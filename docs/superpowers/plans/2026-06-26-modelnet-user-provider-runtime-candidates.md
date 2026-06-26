# ModelNet User Provider Runtime Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow TOC user-configured OpenAI-compatible providers to participate in ModelNet parallel, serial, and auto networking as request-scoped candidates.

**Architecture:** Keep the global ModelNet registry unchanged. TOC builds stable aliases for selected custom-provider chat models and sends their OpenAI-compatible endpoint credentials in a per-request `modelnet.runtime_candidates` block. The router validates and redacts these candidates, merges them with registry candidates only for the current request, and lets existing runner code select them by alias.

**Tech Stack:** TypeScript/React/Vitest in `lobehub`, Python/FastAPI/unittest in `modelnet_router`, existing OpenAI-compatible router adapter.

---

### Task 1: Frontend Candidate Aliases And Payload Tests

**Files:**
- Modify: `lobehub/src/features/ModelNetParallel/index.test.ts`
- Modify: `lobehub/src/services/chat/chat.test.ts`

- [ ] Add tests proving ModelNet candidate helpers include custom OpenAI-compatible chat providers with `user-provider:` aliases, preserve existing registry model IDs, and ignore non-OpenAI runtime providers.
- [ ] Add ChatService tests proving parallel, serial, and auto ModelNet payloads include `runtime_candidates` only for selected custom aliases and never persist credentials in agent params.
- [ ] Run `cd /home/duxianghe/ModelNet-toc/lobehub && pnpm vitest run src/features/ModelNetParallel/index.test.ts src/services/chat/chat.test.ts` and confirm the new tests fail because the feature is missing.

### Task 2: Router Runtime Candidate Tests

**Files:**
- Modify: `modelnet_router/test_adaptive_auto.py`

- [ ] Add tests proving runtime candidates are converted into request-scoped `Candidate` objects with `backend_type="openai_compatible"`.
- [ ] Add tests proving `scored_candidate_pool` and `pick_candidate` can see runtime candidates by alias while global `load_candidates()` remains unchanged.
- [ ] Add tests proving credential fields are removed from OpenAI IR metadata and candidate backend info.
- [ ] Add tests proving unsafe base URLs are rejected.
- [ ] Run `cd /home/duxianghe/ModelNet-toc && python3 -m unittest modelnet_router/test_adaptive_auto.py` and confirm the new tests fail because the feature is missing.

### Task 3: Frontend Implementation

**Files:**
- Modify: `lobehub/src/features/ModelNetParallel/index.ts`
- Modify: `lobehub/src/features/ChatInput/ActionBar/ModelNetParallel/index.tsx`
- Modify: `lobehub/src/features/ChatInput/ActionBar/ModelNetSerial/index.tsx`
- Modify: `lobehub/src/services/chat/index.ts`

- [ ] Introduce helpers for building/parsing ModelNet custom-provider aliases.
- [ ] Extend ModelNet candidate collection to merge registry candidates with enabled custom OpenAI-compatible chat models from `enabledChatModelList`.
- [ ] Keep parallel and serial UI behavior the same, but use the normalized alias as the saved selected ID.
- [ ] In ChatService, build `modelnet.runtime_candidates` from selected custom aliases using `aiProviderRuntimeConfig[providerId].keyVaults.baseURL/apiKey` and model metadata.
- [ ] For `modelnet-auto`, support optional `modelnetAutoCandidateIds`; if absent, preserve existing auto behavior.
- [ ] Re-run the focused Vitest command and confirm frontend tests pass.

### Task 4: Router Implementation

**Files:**
- Modify: `modelnet_router/modelnet_gateway/schemas.py`
- Modify: `modelnet_router/modelnet_gateway/adapters.py`
- Modify: `modelnet_router/app.py`

- [ ] Add schema/types for `runtime_candidates` with only OpenAI-compatible backend support.
- [ ] Redact credential-bearing `modelnet.runtime_candidates` from `openai_chat_to_ir(...).metadata.raw_request_metadata`.
- [ ] Validate runtime candidate IDs, model IDs, API base URLs, and optional capabilities.
- [ ] Reject unsafe URLs by default: non-HTTPS, localhost, private IPs, link-local, loopback, and reserved address ranges.
- [ ] Merge request-scoped runtime candidates with registry candidates in `pick_candidate`, `scored_candidate_pool`, diagnostics, and auto planning without changing the registry cache.
- [ ] Ensure `candidate_backend_info` and traces never expose `api_key`.
- [ ] Re-run router unittest and Python compile checks.

### Task 5: Verification And Commit

**Files:**
- All modified files from Tasks 1-4.

- [ ] Run `cd /home/duxianghe/ModelNet-toc/lobehub && pnpm vitest run src/features/ModelNetParallel/index.test.ts src/services/chat/chat.test.ts`.
- [ ] Run `cd /home/duxianghe/ModelNet-toc && python3 -m unittest modelnet_router/test_adaptive_auto.py`.
- [ ] Run `cd /home/duxianghe/ModelNet-toc && python3 -m py_compile modelnet_router/app.py modelnet_router/modelnet_gateway/adapters.py modelnet_router/modelnet_gateway/schemas.py`.
- [ ] Review `git diff` and ensure unrelated trace display files are not included.
- [ ] Commit only the implementation files with message `feat: allow user providers in modelnet runtime candidates`.
