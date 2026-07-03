# ModelNet Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ModelNet as a first-class built-in Lobe model provider for ModelNet-supplied models.

**Architecture:** Keep ModelNet OpenAI-compatible at the transport layer, but introduce `modelnet` as the provider id across model-bank, model-runtime, server env config, generated `.env.modelnet`, and ModelNet-specific UI/chat helpers. Preserve `openai` and `lobehub` compatibility only for legacy sessions and existing virtual controls.

**Tech Stack:** Python generator tests with `unittest`; TypeScript provider/runtime/chat tests with Vitest; Lobe model-bank/model-runtime provider registry.

---

### Task 1: Generator Env Migration

**Files:**
- Modify: `scripts/test_sync_modelnet_lobehub.py`
- Modify: `scripts/sync_modelnet_lobehub.py`

- [ ] Add a failing test that renders `.env.modelnet` and expects `MODELNET_API_KEY`, `MODELNET_PROXY_URL`, and `MODELNET_MODEL_LIST`.
- [ ] Run `python3 -m unittest scripts/test_sync_modelnet_lobehub.py` and confirm it fails because the script still emits `OPENAI_*`.
- [ ] Update the generator to emit `MODELNET_*` keys and keep the generated model list content unchanged.
- [ ] Re-run the unit test and confirm it passes.

### Task 2: Provider And Runtime Registration

**Files:**
- Modify: `lobehub/packages/model-bank/src/const/modelProvider.ts`
- Create: `lobehub/packages/model-bank/src/modelProviders/modelnet.ts`
- Create: `lobehub/packages/model-bank/src/aiModels/modelnet.ts`
- Modify: `lobehub/packages/model-bank/src/modelProviders/index.ts`
- Modify: `lobehub/packages/model-bank/src/aiModels/index.ts`
- Create: `lobehub/packages/model-runtime/src/providers/modelnet/index.ts`
- Create: `lobehub/packages/model-runtime/src/providers/modelnet/index.test.ts`
- Modify: `lobehub/packages/model-runtime/src/runtimeMap.ts`
- Modify: `lobehub/packages/model-runtime/src/index.ts`
- Modify: `lobehub/src/envs/llm.ts`

- [ ] Add failing provider/runtime tests expecting ModelNet card and runtime registration.
- [ ] Run the focused Vitest command and confirm it fails because `modelnet` is missing.
- [ ] Add the provider card, built-in model list, runtime, runtime map entry, public export, and env schema/runtime mapping.
- [ ] Re-run focused tests and confirm they pass.

### Task 3: ModelNet UI/Chat Coupling

**Files:**
- Modify: `lobehub/src/features/ModelNetParallel/index.test.ts`
- Modify: `lobehub/src/features/ModelNetParallel/index.ts`
- Modify: `lobehub/src/services/chat/chat.test.ts`
- Modify: `lobehub/src/services/chat/index.ts`

- [ ] Add failing tests proving parallel/serial controls and chat forcing work under provider `modelnet`.
- [ ] Run the focused Vitest command and confirm failures are the expected provider gate failures.
- [ ] Update helper provider ids and chat service ModelNet detection to include `modelnet`.
- [ ] Re-run the focused tests and confirm they pass.

### Task 4: Config And Verification

**Files:**
- Modify: `.env.modelnet`
- Modify as needed: `.env.example`, `docker-compose.dev.yml`

- [ ] Regenerate or update `.env.modelnet` so dev Lobe receives `MODELNET_*` keys.
- [ ] Run Python generator tests and relevant TypeScript tests.
- [ ] Run TypeScript compile or the narrowest available package type check for touched modules.
- [ ] If dev stack is running, verify `/signin` and a minimal ModelNet chat smoke against the dev endpoint.
