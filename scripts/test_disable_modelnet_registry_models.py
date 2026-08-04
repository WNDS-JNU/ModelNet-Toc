from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SCRIPT_PATH = SCRIPT_DIR / "disable_modelnet_registry_models.py"
SPEC = importlib.util.spec_from_file_location("disable_modelnet_registry_models", SCRIPT_PATH)
assert SPEC is not None
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
assert SPEC.loader is not None
SPEC.loader.exec_module(module)


class DisableModelNetRegistryModelsTest(unittest.TestCase):
    def test_disable_models_filters_inventory_and_capability_candidates(self) -> None:
        payload = {
            "schema_version": "modelnet.capabilities.v1",
            "capabilities": {
                "chat.general": {
                    "task": "chat",
                    "candidates": [
                        {"model": "healthy", "runtime": "vllm"},
                        {"model": "offline", "runtime": "llama_cpp"},
                    ],
                }
            },
            "models": [
                {"id": "healthy", "backend": "vllm_chat"},
                {"id": "offline", "backend": "llama_cpp"},
            ],
        }

        filtered, removed = module.disable_models(payload, {"offline"})

        self.assertEqual(removed, ["offline"])
        self.assertEqual([item["id"] for item in filtered["models"]], ["healthy"])
        self.assertEqual(
            filtered["capabilities"]["chat.general"]["candidates"],
            [{"model": "healthy", "runtime": "vllm"}],
        )
        self.assertEqual(len(payload["models"]), 2)

    def test_disable_models_reports_absent_ids_without_changing_models(self) -> None:
        payload = {"models": [{"id": "healthy", "backend": "vllm_chat"}]}

        filtered, removed = module.disable_models(payload, {"missing"})

        self.assertEqual(removed, [])
        self.assertEqual(filtered, payload)


if __name__ == "__main__":
    unittest.main()
