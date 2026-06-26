from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

import yaml


SCRIPT_DIR = Path(__file__).resolve().parent
SCRIPT_PATH = SCRIPT_DIR / "modelnet_registry_source.py"
SPEC = importlib.util.spec_from_file_location("modelnet_registry_source", SCRIPT_PATH)
assert SPEC is not None
modelnet_registry_source = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = modelnet_registry_source
assert SPEC.loader is not None
SPEC.loader.exec_module(modelnet_registry_source)


def ingress() -> dict:
    return {
        "metadata": {"name": "qwen3-4b-awq"},
        "spec": {
            "tls": [{"hosts": ["inference.cluster.aimodelnetwork.cn"]}],
            "rules": [
                {
                    "host": "inference.cluster.aimodelnetwork.cn",
                    "http": {
                        "paths": [
                            {
                                "path": "/Qwen/Qwen3-4B-AWQ",
                                "pathType": "Prefix",
                                "backend": {
                                    "service": {
                                        "name": "qwen3-4b-awq",
                                        "port": {"number": 8000},
                                    }
                                },
                            }
                        ]
                    },
                }
            ],
        },
    }


def nodeport_service() -> dict:
    return {
        "metadata": {"name": "deploy-jetson-16g-1-meta-llama-31-8b-instruct-q80"},
        "spec": {
            "type": "NodePort",
            "ports": [{"port": 8000, "nodePort": 30834}],
        },
    }


class FakeK8sClient:
    def __init__(self, ingresses: list[dict], services: list[dict] | None = None) -> None:
        self.ingresses = ingresses
        self.services = services or []

    def list_ingresses(self, namespace: str) -> list[dict]:
        return self.ingresses if namespace == "inference" else []

    def list_services(self, namespace: str) -> list[dict]:
        return self.services if namespace == "llama-cpp" else []


class ModelNetRegistrySourceTest(unittest.TestCase):
    def test_parse_namespaces_dedupes_and_trims(self) -> None:
        self.assertEqual(
            modelnet_registry_source.parse_namespaces(" inference, llama-cpp, inference ,, light "),
            ("inference", "llama-cpp", "light"),
        )

    def test_iter_ingress_routes_builds_base_url(self) -> None:
        routes = modelnet_registry_source.iter_ingress_routes(
            "inference",
            ingress(),
            default_scheme="http",
        )

        self.assertEqual(
            routes,
            [
                {
                    "namespace": "inference",
                    "ingress": "qwen3-4b-awq",
                    "host": "inference.cluster.aimodelnetwork.cn",
                    "path": "/Qwen/Qwen3-4B-AWQ",
                    "base_url": "https://inference.cluster.aimodelnetwork.cn/Qwen/Qwen3-4B-AWQ",
                    "service_name": "qwen3-4b-awq",
                    "service_port": "8000",
                }
            ],
        )

    def test_discover_model_registry_keeps_ingress_and_nodeport_routes(self) -> None:
        settings = modelnet_registry_source.K8sDiscoverySettings(
            namespaces=("inference", "llama-cpp"),
            default_backend="vllm_chat",
            route_default_scheme="https",
            nodeport_host="219.222.20.79",
        )

        def probe(base_url: str, timeout: float) -> str:
            del timeout
            if "Qwen3-4B-AWQ" in base_url:
                return "Qwen/Qwen3-4B-AWQ"
            return "Llama-3.1-8B-Instruct-Q8_0.gguf"

        result = modelnet_registry_source.discover_model_registry(
            settings,
            client=FakeK8sClient([ingress()], [nodeport_service()]),
            probe_func=probe,
        )
        ids = [model["id"] for model in result["models"]]

        self.assertEqual(
            ids,
            [
                "inference-qwen-qwen3-4b-awq",
                "llama-cpp-deploy-jetson-16g-1-meta-llama-31-8b-instruct-q80",
            ],
        )
        self.assertEqual(result["models"][0]["backend"], "vllm_chat")
        self.assertEqual(result["models"][1]["backend"], "llama_cpp")

    def test_refresh_writes_source_registry_and_status(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "capability-registry.yaml"
            status_output = Path(temp_dir) / "status.json"
            settings = modelnet_registry_source.K8sDiscoverySettings(namespaces=("inference",))

            status = modelnet_registry_source.refresh_registry_source(
                settings=settings,
                output=output,
                status_output=status_output,
                client=FakeK8sClient([ingress()]),
                probe_func=lambda _base_url, _timeout: "Qwen/Qwen3-4B-AWQ",
            )

            self.assertEqual(status["status"], "success")
            self.assertTrue(status["applied"])
            payload = yaml.safe_load(output.read_text(encoding="utf-8"))
            self.assertEqual(payload["schema_version"], "modelnet.capabilities.v1")
            self.assertIn("chat.general", payload["capabilities"])
            self.assertEqual(payload["models"][0]["id"], "inference-qwen-qwen3-4b-awq")
            self.assertEqual(json.loads(status_output.read_text(encoding="utf-8"))["model_count"], 1)

    def test_dry_run_does_not_write_source(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "capability-registry.yaml"
            status_output = Path(temp_dir) / "status.json"
            settings = modelnet_registry_source.K8sDiscoverySettings(namespaces=("inference",))

            status = modelnet_registry_source.refresh_registry_source(
                settings=settings,
                output=output,
                status_output=status_output,
                dry_run=True,
                client=FakeK8sClient([ingress()]),
                probe_func=lambda _base_url, _timeout: "Qwen/Qwen3-4B-AWQ",
            )

            self.assertEqual(status["status"], "dry_run")
            self.assertFalse(status["applied"])
            self.assertFalse(output.exists())
            self.assertTrue(status_output.exists())

    def test_partial_smaller_discovery_preserves_existing_registry(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "capability-registry.yaml"
            output.write_text(
                """\
schema_version: modelnet.capabilities.v1
version: old
generated_at: old
source: test
capabilities: {}
models:
  - id: inference-qwen-qwen3-4b-awq
    backend: vllm_chat
    model_name: Qwen/Qwen3-4B-AWQ
    model_url: https://inference.cluster.aimodelnetwork.cn/Qwen/Qwen3-4B-AWQ
  - id: old-model
    backend: vllm_chat
    model_name: old
    model_url: https://example.com/old
""",
                encoding="utf-8",
            )
            settings = modelnet_registry_source.K8sDiscoverySettings(namespaces=("inference",))
            broken_ingress = ingress()
            broken_ingress["spec"]["rules"].append(
                {
                    "host": "inference.cluster.aimodelnetwork.cn",
                    "http": {
                        "paths": [
                            {
                                "path": "/broken/model",
                                "backend": {"service": {"name": "broken", "port": {"number": 8000}}},
                            }
                        ]
                    },
                }
            )

            def probe(base_url: str, timeout: float) -> str:
                del timeout
                if base_url.endswith("/broken/model"):
                    raise RuntimeError("HTTP 503 from upstream")
                return "Qwen/Qwen3-4B-AWQ"

            status = modelnet_registry_source.refresh_registry_source(
                settings=settings,
                output=output,
                client=FakeK8sClient([broken_ingress]),
                probe_func=probe,
            )

            self.assertEqual(status["status"], "partial_failed")
            self.assertTrue(status["preserved_existing_registry"])
            payload = yaml.safe_load(output.read_text(encoding="utf-8"))
            self.assertEqual([item["id"] for item in payload["models"]], ["inference-qwen-qwen3-4b-awq", "old-model"])


if __name__ == "__main__":
    unittest.main()
