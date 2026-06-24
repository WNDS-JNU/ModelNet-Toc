from __future__ import annotations

import hashlib
import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import yaml


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
SCRIPT_PATH = SCRIPT_DIR / "publish_modelnet_registry.py"
SPEC = importlib.util.spec_from_file_location("publish_modelnet_registry", SCRIPT_PATH)
assert SPEC is not None
publish_modelnet_registry = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = publish_modelnet_registry
assert SPEC.loader is not None
SPEC.loader.exec_module(publish_modelnet_registry)


MODEL_NET_YAML = """\
models:
  - id: reranker-a
    backend: vllm_chat
    model_name: Qwen/Qwen3-Reranker-8B
    model_url: https://reranker.example
  - id: z-chat
    backend: vllm_chat
    model_name: Qwen/Qwen3-14B-AWQ
    model_url: https://inference.example/z-chat
    runtime: vllm
    resource_class: jetson-64g
    capabilities:
      - chat
      - reasoning
    quality: high
    cost_weight: medium
  - id: a-chat
    backend: llama_cpp
    model_name: Qwen3-4B-BF16.gguf
    model_url: http://llama-host:8080
    capabilities:
      - chat
      - reasoning
  - id: embedding-a
    backend: openai_compatible
    model_name: qwen3-embedding-4b
    model_url: https://embedding.example
    task: embedding
  - id: whisper-a
    backend: openai_compatible
    model_name: whisper-large-v3-turbo
    model_url: https://audio.example
    task: transcription
  - id: sdxl-a
    backend: openai_compatible
    model_name: sdxl-base
    model_url: https://image.example
    task: text_to_image
"""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class PublishModelNetRegistryTest(unittest.TestCase):
    def test_publish_creates_versioned_bundle_current_symlink_and_checksums(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "registry"
            source = Path(temp_dir) / "model_net.yaml"
            source.write_text(MODEL_NET_YAML, encoding="utf-8")

            result = publish_modelnet_registry.publish_registry(
                source=source,
                root=root,
                version="2026-06-21T00-00-00Z",
            )

            self.assertEqual(result.version, "2026-06-21T00-00-00Z")
            self.assertTrue((root / "current").is_symlink())
            self.assertEqual(os.readlink(root / "current"), "versions/2026-06-21T00-00-00Z")
            bundle = root / "current"
            for relative in (
                "capability-registry.yaml",
                "litellm/modelnet-config.yaml",
                "version.json",
                "checksums.sha256",
            ):
                self.assertTrue((bundle / relative).exists(), relative)
            self.assertFalse((bundle / "model_net.yaml").exists())

            checksums = {}
            for line in (bundle / "checksums.sha256").read_text(encoding="utf-8").splitlines():
                digest, relative = line.split("  ", 1)
                checksums[relative] = digest
            self.assertNotIn("model_net.yaml", checksums)
            self.assertEqual(
                checksums["capability-registry.yaml"],
                sha256(bundle / "capability-registry.yaml"),
            )
            self.assertEqual(
                checksums["litellm/modelnet-config.yaml"],
                sha256(bundle / "litellm/modelnet-config.yaml"),
            )

            litellm_config = (bundle / "litellm/modelnet-config.yaml").read_text(encoding="utf-8")
            self.assertIn("model_name: 'modelnet'", litellm_config)
            self.assertIn("model_name: 'modelnet-auto'", litellm_config)
            self.assertIn("model_name: 'a-chat'", litellm_config)
            self.assertIn("model_name: 'z-chat'", litellm_config)

            capability_payload = yaml.safe_load(
                (bundle / "capability-registry.yaml").read_text(encoding="utf-8")
            )
            self.assertEqual(capability_payload["schema_version"], "modelnet.capabilities.v1")
            self.assertEqual(capability_payload["source"], "model_net.yaml")
            self.assertIn("models", capability_payload)
            self.assertEqual(capability_payload["models"][0]["id"], "a-chat")

    def test_capability_registry_groups_factual_capabilities_and_candidates(self) -> None:
        payload = yaml.safe_load(
            publish_modelnet_registry.render_capability_registry(
                yaml.safe_load(MODEL_NET_YAML),
                generated_at="2026-06-21T00:00:00Z",
                version="2026-06-21T00-00-00Z",
            )
        )

        self.assertEqual([model["id"] for model in payload["models"]][:3], ["a-chat", "embedding-a", "reranker-a"])
        self.assertEqual(payload["models"][0]["model_url"], "http://llama-host:8080")

        capabilities = payload["capabilities"]
        self.assertEqual(
            list(capabilities),
            ["audio.transcribe", "chat.general", "image.generate", "rag.embed"],
        )
        self.assertNotIn("code.modify", capabilities)
        all_candidate_ids = {
            candidate["model"]
            for capability in capabilities.values()
            for candidate in capability["candidates"]
        }
        self.assertNotIn("reranker-a", all_candidate_ids)
        self.assertEqual(capabilities["audio.transcribe"]["candidates"][0]["model"], "whisper-a")
        self.assertEqual(capabilities["image.generate"]["candidates"][0]["model"], "sdxl-a")
        self.assertEqual(capabilities["rag.embed"]["candidates"][0]["model"], "embedding-a")

        chat_candidates = capabilities["chat.general"]["candidates"]
        self.assertEqual([candidate["model"] for candidate in chat_candidates], ["a-chat", "z-chat"])
        self.assertEqual(
            chat_candidates[0],
            {
                "model": "a-chat",
                "runtime": "llama_cpp",
                "resource_class": "unknown",
                "quality": "unknown",
                "cost_weight": "unknown",
            },
        )
        self.assertEqual(chat_candidates[1]["runtime"], "vllm")
        self.assertEqual(chat_candidates[1]["resource_class"], "jetson-64g")
        self.assertEqual(chat_candidates[1]["quality"], "high")
        self.assertEqual(chat_candidates[1]["cost_weight"], "medium")

    def test_code_modify_is_generated_only_from_explicit_code_task(self) -> None:
        payload = yaml.safe_load(
            publish_modelnet_registry.render_capability_registry(
                {
                    "models": [
                        {
                            "id": "coder-a",
                            "backend": "vllm_chat",
                            "model_name": "Qwen/Qwen3-Coder",
                            "model_url": "https://coder.example",
                            "task": "code",
                        }
                    ]
                },
                generated_at="2026-06-21T00:00:00Z",
                version="2026-06-21T00-00-00Z",
            )
        )

        self.assertEqual(payload["models"][0]["id"], "coder-a")
        self.assertIn("code.modify", payload["capabilities"])
        self.assertEqual(payload["capabilities"]["code.modify"]["task"], "code")
        self.assertEqual(
            payload["capabilities"]["code.modify"]["requires_tools"],
            ["file.read", "file.write", "git.diff", "shell.test"],
        )

    def test_bad_yaml_rejected_without_advancing_current(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "registry"
            good_source = Path(temp_dir) / "good.yaml"
            bad_source = Path(temp_dir) / "bad.yaml"
            good_source.write_text(MODEL_NET_YAML, encoding="utf-8")
            bad_source.write_text("models:\n  - id: [\n", encoding="utf-8")

            publish_modelnet_registry.publish_registry(
                source=good_source,
                root=root,
                version="2026-06-21T00-00-00Z",
            )

            with self.assertRaises(publish_modelnet_registry.RegistryPublishError):
                publish_modelnet_registry.publish_registry(
                    source=bad_source,
                    root=root,
                    version="2026-06-21T00-01-00Z",
                )
            self.assertEqual(os.readlink(root / "current"), "versions/2026-06-21T00-00-00Z")
            self.assertFalse((root / "versions/2026-06-21T00-01-00Z").exists())

    def test_dry_run_builds_bundle_under_tmp_without_touching_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "registry"
            source = Path(temp_dir) / "model_net.yaml"
            source.write_text(MODEL_NET_YAML, encoding="utf-8")

            result = publish_modelnet_registry.publish_registry(
                source=source,
                root=root,
                version="2026-06-21T00-02-00Z",
                dry_run=True,
            )
            self.addCleanup(shutil.rmtree, result.bundle_dir.parent, True)

            self.assertTrue(result.dry_run)
            self.assertTrue(str(result.bundle_dir).startswith("/tmp/modelnet-registry-"))
            self.assertTrue((result.bundle_dir / "checksums.sha256").exists())
            self.assertFalse(root.exists())

    def test_rejects_version_with_path_components_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "registry"
            source = Path(temp_dir) / "model_net.yaml"
            source.write_text(MODEL_NET_YAML, encoding="utf-8")

            for version in ("/tmp/escape", "nested/version", "nested\\version", "..", ""):
                with self.subTest(version=version):
                    with self.assertRaises(publish_modelnet_registry.RegistryPublishError):
                        publish_modelnet_registry.publish_registry(
                            source=source,
                            root=root,
                            version=version,
                        )
            self.assertFalse((root / "versions").exists())
            self.assertFalse((root / ".build").exists())

    def test_current_plain_file_rejected_before_version_directory_is_moved(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "registry"
            root.mkdir()
            (root / "current").write_text("not a symlink", encoding="utf-8")
            source = Path(temp_dir) / "model_net.yaml"
            source.write_text(MODEL_NET_YAML, encoding="utf-8")

            with self.assertRaises(publish_modelnet_registry.RegistryPublishError):
                publish_modelnet_registry.publish_registry(
                    source=source,
                    root=root,
                    version="2026-06-21T00-03-00Z",
                )

            self.assertFalse((root / "versions/2026-06-21T00-03-00Z").exists())
            self.assertFalse((root / ".build/2026-06-21T00-03-00Z").exists())


if __name__ == "__main__":
    unittest.main()
