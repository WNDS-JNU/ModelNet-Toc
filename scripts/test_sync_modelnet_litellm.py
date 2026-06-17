from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parent / "sync_modelnet_litellm.py"
SPEC = importlib.util.spec_from_file_location("sync_modelnet_litellm", SCRIPT_PATH)
assert SPEC is not None
sync_modelnet_litellm = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync_modelnet_litellm)


def section_for(config: str, model_name: str) -> str:
    marker = f"  - model_name: '{model_name}'"
    start = config.index(marker)
    next_model = config.find("\n  - model_name:", start + len(marker))
    general_settings = config.find("\ngeneral_settings:", start + len(marker))
    candidates = [idx for idx in (next_model, general_settings) if idx != -1]
    end = min(candidates) if candidates else len(config)
    return config[start:end]


class LiteLLMLayeringTest(unittest.TestCase):
    def test_aggregate_and_auto_entries_route_to_modelnet_router(self) -> None:
        config, model_names = sync_modelnet_litellm.build_config(
            [
                {
                    "backend": "llama_cpp",
                    "id": "llama-cpp-a",
                    "model_name": "Qwen3-8B-BF16.gguf",
                    "model_url": "http://llama-host:8080",
                }
            ]
        )

        self.assertEqual(model_names[:2], ["modelnet", "modelnet-auto"])
        for model_name in ("modelnet", "modelnet-auto"):
            section = section_for(config, model_name)
            self.assertIn("api_base: 'http://modelnet-router:8000/v1'", section)
            self.assertIn("allowed_openai_params:", section)

    def test_concrete_backend_entries_keep_registry_api_base(self) -> None:
        config, model_names = sync_modelnet_litellm.build_config(
            [
                {
                    "backend": "llama_cpp",
                    "id": "llama-cpp-a",
                    "model_name": "Qwen3-8B-BF16.gguf",
                    "model_url": "http://llama-host:8080",
                },
                {
                    "backend": "vllm_chat",
                    "id": "inference-a",
                    "model_name": "org/model-a",
                    "model_url": "https://inference.example/model-a",
                },
            ]
        )

        self.assertEqual(model_names, ["modelnet", "modelnet-auto", "llama-cpp-a", "inference-a"])
        llama_section = section_for(config, "llama-cpp-a")
        vllm_section = section_for(config, "inference-a")
        self.assertIn("api_base: 'http://llama-host:8080/v1'", llama_section)
        self.assertIn("api_base: 'https://inference.example/model-a/v1'", vllm_section)
        self.assertNotIn("http://modelnet-router:8000/v1", llama_section)
        self.assertNotIn("http://modelnet-router:8000/v1", vllm_section)


if __name__ == "__main__":
    unittest.main()
