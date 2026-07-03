# SiliconFlow Default Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SiliconFlow free OpenAI-compatible chat models to the ModelNet default dev registry using `SILICONFLOW_API_KEY`.

**Architecture:** Append built-in external provider entries in the registry source producer, preserve per-model API key environment references in generated LiteLLM config, and expose `openai_compatible` chat models in the LobeHub model list. Publish and refresh only the dev registry/dev containers.

**Tech Stack:** Python scripts and unittest, YAML registry bundles, Docker Compose dev stack.

---

### Task 1: Tests For Default SiliconFlow Models

**Files:**
- Modify: `scripts/test_modelnet_registry_source.py`
- Modify: `scripts/test_sync_modelnet_litellm.py`
- Modify: `scripts/test_sync_modelnet_lobehub.py`

- [ ] Add a registry source test that proves `discover_model_registry()` includes `siliconflow-thudm-glm-z1-9b-0414` and `siliconflow-tencent-hunyuan-mt-7b` even when no Kubernetes routes are discovered.
- [ ] Add a LiteLLM test that proves a model with `api_key_env: SILICONFLOW_API_KEY` renders `api_key: 'os.environ/SILICONFLOW_API_KEY'`.
- [ ] Add a LobeHub sync test that proves `openai_compatible` chat models appear in `OPENAI_MODEL_LIST`.
- [ ] Run `python3 -m unittest scripts/test_modelnet_registry_source.py scripts/test_sync_modelnet_litellm.py scripts/test_sync_modelnet_lobehub.py` and confirm the new tests fail before implementation.

### Task 2: Registry And Config Implementation

**Files:**
- Modify: `scripts/modelnet_registry_source.py`
- Modify: `scripts/sync_modelnet_litellm.py`
- Modify: `scripts/sync_modelnet_lobehub.py`
- Modify: `docker-compose.dev.yml`
- Modify: `.env.example`

- [ ] Add two default SiliconFlow registry entries with backend `openai_compatible`, model URL `https://api.siliconflow.cn`, and `api_key_env: SILICONFLOW_API_KEY`.
- [ ] Merge default external entries with discovered models without duplicating IDs.
- [ ] Update LiteLLM generation so model-specific `api_key_env` overrides `MODELNET_BACKEND_API_KEY`.
- [ ] Include `openai_compatible` chat models in LobeHub model-list generation.
- [ ] Pass `SILICONFLOW_API_KEY` into dev Router and dev LiteLLM services only.
- [ ] Document `SILICONFLOW_API_KEY` in `.env.example`.

### Task 3: Local Verification

**Files:**
- Runtime source: `/home/duxianghe/modelnet-runtime/registry-source/capability-registry.yaml`
- Runtime bundle root: `/home/duxianghe/modelnet-runtime/registry-dev`

- [ ] Run focused unit tests.
- [ ] Run `python3 -m py_compile scripts/modelnet_registry_source.py scripts/sync_modelnet_litellm.py scripts/sync_modelnet_lobehub.py`.
- [ ] Regenerate the source registry or patch the dev runtime source to include the default SiliconFlow entries.
- [ ] Publish a new dev registry bundle with `scripts/publish_modelnet_registry.py`.
- [ ] Regenerate `.env.modelnet` from the dev registry source.
- [ ] Refresh only dev Router/LiteLLM/Lobe containers if required.
- [ ] Verify dev Router `/v1/models` contains the SiliconFlow model IDs.
- [ ] Verify generated LiteLLM config references `os.environ/SILICONFLOW_API_KEY`.
- [ ] Run a live SiliconFlow smoke only if `SILICONFLOW_API_KEY` is present.
