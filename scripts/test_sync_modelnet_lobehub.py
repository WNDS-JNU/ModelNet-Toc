from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parent / "sync_modelnet_lobehub.py"
SPEC = importlib.util.spec_from_file_location("sync_modelnet_lobehub", SCRIPT_PATH)
assert SPEC is not None
sync_modelnet_lobehub = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync_modelnet_lobehub)


class ModelDisplayNameTest(unittest.TestCase):
    def test_strips_huggingface_namespace(self) -> None:
        self.assertEqual(
            sync_modelnet_lobehub.model_display_name(
                {"model_name": "Qwen/Qwen3-14B-AWQ"}
            ),
            "Qwen3-14B-AWQ",
        )

    def test_keeps_quantization_suffix(self) -> None:
        self.assertEqual(
            sync_modelnet_lobehub.model_display_name(
                {"model_name": "cyankiwi/Llama-3.1-8B-Instruct-AWQ-INT4"}
            ),
            "Llama-3.1-8B-Instruct-AWQ-INT4",
        )

    def test_strips_model_file_extension(self) -> None:
        self.assertEqual(
            sync_modelnet_lobehub.model_display_name(
                {"model_name": "Qwen3-8B-BF16.gguf"}
            ),
            "Qwen3-8B-BF16",
        )

    def test_duplicate_display_names_keep_unique_internal_ids(self) -> None:
        entries = sync_modelnet_lobehub.build_model_list(
            [
                {"backend": "llama_cpp", "id": "deploy-a", "model_name": "Qwen3-8B-BF16.gguf"},
                {"backend": "llama_cpp", "id": "deploy-b", "model_name": "Qwen3-8B-BF16.gguf"},
            ]
        )

        self.assertIn("+deploy-a=Qwen3-8B-BF16", entries)
        self.assertIn("+deploy-b=Qwen3-8B-BF16", entries)
        self.assertEqual(entries.count("+deploy-a=Qwen3-8B-BF16"), 1)
        self.assertEqual(entries.count("+deploy-b=Qwen3-8B-BF16"), 1)

    def test_openai_compatible_chat_models_are_included(self) -> None:
        entries = sync_modelnet_lobehub.build_model_list(
            [
                {
                    "backend": "openai_compatible",
                    "id": "siliconflow-thudm-glm-z1-9b-0414",
                    "model_name": "THUDM/GLM-Z1-9B-0414",
                    "model_url": "https://api.siliconflow.cn",
                }
            ]
        )

        self.assertIn("+siliconflow-thudm-glm-z1-9b-0414=GLM-Z1-9B-0414", entries)


if __name__ == "__main__":
    unittest.main()
