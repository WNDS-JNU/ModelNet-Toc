# ModelNet Dev Output Fallback Repair Notes (2026-07-07)

> 历史记录（2026-08-24 注）：本文保留 LiteLLM 退役前的架构或排障证据。当前 ModelNet App/SDK 直接访问 `modelnet-router`，文中的 3090/3190、LiteLLM 容器和相关操作命令不再适用。

## Context

Dev URL reported by user:

- `http://127.0.0.1:3181/agent/agt_vtFJuE7GmPBN/tpc_1aWpKl0EYUlC`

Observed visible output had two suspicious symptoms:

1. Auto trace first planned `role_graph`, then fell back to `fallback_repair`, but the fallback trace still displayed role-graph-only fields such as `experts.parallel -> synthesizer.final` and `explicit_role_graph`.
2. The fallback answer exposed planning/reasoning prose beginning with `好的，我需要...` instead of a direct user-facing answer.

## Reproduction Evidence

Dev stack health on 4A100 was OK:

- TOC `/signin`: HTTP 200.
- Router `/healthz`: HTTP 200, registry path `/etc/modelnet/registry/current/capability-registry.yaml`, 18 ready candidates.

A direct router smoke with the same two aliases from the screenshot completed successfully as `role_graph`, so the screenshot fallback is likely transient runtime failure/empty output from one of the expert nodes rather than deterministic planning failure.

The stale fallback trace was reproduced with a deterministic unit test by mocking a `role_graph` runtime error and forcing the router fallback path.

## Root Causes

### 1. Stale fallback plan metadata

`run_auto_ensemble` handled multi-runner errors by constructing fallback metadata with:

```python
fallback_plan = {**plan, ...}
```

That copied topology fields from the failed plan (`stages`, `escalation_reason`, `selected_roles`, role annotations) into the route-once fallback plan.

### 2. Route-once did not use hidden-reasoning filtering

`run_route_ensemble` called `generate_text` and streamed `result["text"]` directly. Other paths, such as response sources and synthesis, already use `strip_response_hidden_reasoning`, but route-once did not. This made fallback repair vulnerable to Qwen/GLM-style visible planning preambles.

## Fix Implemented

Files changed:

- `modelnet_router/app.py`
- `modelnet_router/test_adaptive_auto.py`

Router changes:

- Added `build_runtime_fallback_plan` and `sanitize_fallback_selected_sources`.
- Runtime fallback plans now use:
  - `plan_version: fallback_route_once_v1`
  - `strategy: fallback_repair`
  - `runner: route.once`
  - `aggregator: load_aware`
  - `stages: ["route.once"]`
  - `escalation_reason: runner_error_fallback`
- Fallback selected source metadata keeps useful backend identity but drops role-graph-only fields like `role` and `selected_roles`.
- Extended visible reasoning preamble stripping to recognize Chinese planning preambles like `好的，我需要帮用户...` when they look like meta reasoning about the user's request.
- Updated `run_route_ensemble` to strip hidden reasoning and, when the first answer contains only hidden/planning text, retry once with a final-answer-only recovery prompt.
- Route recovery is recorded in call ledger as `route.recovery`, so `internal_call_count` and token accounting reflect the extra recovery call.

## Tests Added

New focused tests:

- `test_role_graph_runtime_fallback_emits_route_once_trace`
- `test_response_hidden_reasoning_filter_removes_chinese_visible_planning_preamble`
- `test_route_once_recovers_when_visible_answer_is_only_reasoning_preamble`

Initial red failures confirmed:

- Fallback trace had stale `['experts.parallel', 'synthesizer.final']` instead of `['route.once']`.
- Chinese planning preamble was not stripped.
- Route-once did not retry recovery.

Focused tests are now green.

## Verification Results

Local code verification passed:

```bash
/tmp/modelnet-router-test-venv/bin/python -m py_compile modelnet_router/app.py modelnet_router/test_adaptive_auto.py
/tmp/modelnet-router-test-venv/bin/python -m unittest modelnet_router/test_adaptive_auto.py
```

Result: `py_compile` exited 0; router unit suite ran 96 tests and exited OK.

Dev deployment verification:

- A normal `docker compose ... build modelnet-router` stalled at Docker Hub base-image metadata for `python:3.12-slim` and was interrupted.
- To avoid external metadata fetch, rebuilt a dev-only overlay image from the existing local `lobehub-toc-dev-modelnet-router:latest` image, copying `app.py` and `modelnet_gateway/` from the working tree.
- Recreated only `modelnet-router-dev` with `docker compose ... up -d --no-deps --force-recreate --no-build modelnet-router`.
- In-container patched-code probe returned `['route.once']` for fallback stages and `('可见答案', True)` for Chinese preamble stripping.
- Router `/healthz`: HTTP 200, `status: ok`.
- Router `/v1/models`: HTTP 200.
- TOC `/signin`: HTTP 200.
- Compose status shows `modelnet-router-dev` healthy after recreation; other dev services remained up.

Note: the dev image tag has been updated through the local overlay build. A future clean build from the original Dockerfile may still require Docker Hub/base-image metadata unless the network/proxy path is fixed.


## Addendum: No Visible Output After Dev Recreate

### Symptom

After the dev stack was rebuilt/recreated, the referenced TOC topic appeared to produce no visible assistant output again.

### Fresh Evidence

- Dev compose stack was up; `lobe`, `postgresql`, `redis`, `rustfs`, and `modelnet-router` were healthy.
- The unauthenticated curl to the topic URL returned HTTP 302, so browser session state is required for direct page reproduction.
- Direct Router smoke against `/v1/chat/completions` with `modelnet-auto` and `single_best` returned HTTP 200 but emitted content beginning with an unclosed `<think>` block from `llama-cpp-deploy-pc-3090-qwen3-8b-bf16`.
- LiteLLM smoke returned visible content because that request selected a different backend, so the failure was backend-selection dependent.

### Root Cause

`strip_response_hidden_reasoning` handled closed `<think>...</think>` blocks and stray closing `</think>`, but not a non-streamed answer that starts with `<think>` and never emits the closing tag. In route-once fallback this left the entire hidden-reasoning prefix as visible `content`; UI-side thinking filtering can then remove it and leave no visible answer.

### Fix

- Added a regression for unclosed `<think>` blocks in `test_response_hidden_reasoning_filter_removes_think_blocks`.
- Added `test_route_once_recovers_when_answer_is_unclosed_think_block` to verify route-once retries final-answer recovery instead of streaming hidden reasoning as visible content.
- Updated `strip_response_hidden_reasoning` so any remaining opening `<think>` after closed-block cleanup causes everything from the opening tag onward to be treated as hidden reasoning. If there is no visible prefix, route-once recovery is triggered.

### Verification

Local verification:

```bash
/tmp/modelnet-router-test-venv/bin/python -m py_compile modelnet_router/app.py modelnet_router/test_adaptive_auto.py
/tmp/modelnet-router-test-venv/bin/python -m unittest modelnet_router/test_adaptive_auto.py
```

Result: `py_compile` exited 0; router suite ran 97 tests and exited OK.

Dev deployment verification:

- Rebuilt the dev router overlay image from the existing local `lobehub-toc-dev-modelnet-router:latest` image.
- Recreated only `modelnet-router-dev` with `docker compose ... up -d --no-deps --force-recreate --no-build modelnet-router`.
- In-container check: `strip_response_hidden_reasoning('<think>
implicit secret without close')` returned `('', True)`.
- Router direct smoke: HTTP 200, content `可以，我现在可以输出。`, `CONTENT_LEN=11`, `HAS_THINK=False`.
- LiteLLM smoke: HTTP 200, content `LiteLLM 现在可以输出。`, `CONTENT_LEN=15`, `HAS_THINK=False`.
- TOC `/signin`: HTTP 200.

## Addendum: Target Topic Still Blank After Backend Smoke Passed

### Symptom

The target URL still looked blank even after direct Router and LiteLLM smoke requests returned visible content.

### Fresh Evidence

Read-only dev Postgres inspection for topic `tpc_1aWpKl0EYUlC` showed:

- The user message `msg_iaBULfVD133cdyqOtS` had `metadata.activeBranchIndex = 3`.
- It had only three assistant child branches, so index `3` is the conversation-flow optimistic sentinel (`activeBranchIndex == children.length`) and renders as "new branch still being created".
- The latest assistant child `msg_0rSzUsuhMY8kp9vi2A` had `content_len = 0`, no `error`, and the old ModelNet trace / Chinese planning preamble in `reasoning.content`.

So the page was not blank because the current Router could not produce output. The persisted topic was selecting a stale optimistic branch, and the selected branch had no visible `content`.

### Additional Backend Finding

A direct retry of the original long design prompt against `modelnet-auto` timed out at 180s before the role-graph timeout fix. Code inspection showed `run_role_graph_ensemble` used:

```python
await asyncio.gather(*(generate_response_source(...) for source in request.sources))
```

That waits for all expert calls before emitting any source events. Since each backend request used the global 180s timeout, one slow expert could make the UI appear to produce no answer for a long time.

### Fixes

- Added `MODELNET_AUTO_ROLE_GRAPH_EXPERT_TIMEOUT_SECONDS` with default `45`.
- Added per-source expert timeout support via `role_graph.expert_timeout_seconds`.
- Timed-out role-graph experts now become failed source results with call-ledger status `timeout`; existing runtime fallback then converts the run to `fallback_repair` / `route.once`.
- Added cancellation cleanup in `generate_response_source` so timed-out tasks release their candidate state.
- Added a Conversation regenerate guard: if regenerate switches to an optimistic new branch but no new child branch appears, it restores the last valid branch instead of leaving the topic permanently blank.
- Repaired the dev topic data: wrote a fresh visible `modelnet-auto` answer into `msg_0rSzUsuhMY8kp9vi2A` and changed `msg_iaBULfVD133cdyqOtS.metadata.activeBranchIndex` from `3` to `2`.

### Verification

Local tests:

```bash
/tmp/modelnet-router-test-venv/bin/python -m unittest modelnet_router/test_adaptive_auto.py
python3 -m py_compile modelnet_router/app.py modelnet_router/test_adaptive_auto.py
pnpm exec vitest run src/features/Conversation/store/slices/generation/action.test.ts -t "regenerateUserMessage"
```

Results:

- Router suite: `98` tests OK.
- Router `py_compile`: exited 0.
- Conversation regenerate tests: `9` passed.

Dev deployment and smoke:

- Rebuilt the dev Router overlay image and recreated `modelnet-router-dev`.
- In-container check: `AUTO_ROLE_GRAPH_EXPERT_TIMEOUT_SECONDS == 45.0`; unclosed `<think>` returns `('', True)`.
- Router `/healthz`: HTTP 200.
- Short Router smoke: content `Router 现在可以输出。`, `HAS_THINK=False`.
- Original long prompt retry after the timeout fix returned visible content (`CONTENT_LEN=1926`, `HAS_THINK=False`).
- Dev topic repair readback: selected assistant `msg_0rSzUsuhMY8kp9vi2A` now has `content_len=1459`; user message `activeBranchIndex=2`.
- TOC `/signin`: HTTP 200; `lobe` healthy, `modelnet-router-dev` healthy, LiteLLM running.

Remaining limitation: no authenticated browser/session tool was available in this Codex run, so the final page was verified through database state, service health, and direct Router output rather than a logged-in screenshot of the target URL.
