# AgentManagerRuntime Initialization Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock the existing three-executor lazy-runtime fix with complete regression coverage, build the current `modelnet-app` source reproducibly into an isolated dev image, prove that exact image contains the corrected bundle, and recreate only the two affected dev services.

**Architecture:** Keep the existing independent lazy singleton in each registry-imported executor. Extend the registry-level Vitest test so it proves import, registration, first-use construction, and reuse for `agent-builder`, `group-agent-builder`, and `agent-management`. Add one fail-closed dev rebuild helper that always resolves Compose project `modelnet-toc-dev` against `/home/duxianghe/ModelNet-toc/modelnet-app`, then use the image ID produced by that build as the immutable identity for bundle inspection and scoped recreation.

**Tech Stack:** TypeScript, Vitest, pnpm, Bash, Python `unittest`, Docker Compose, Vite 8/Rolldown.

## Current State

- `modelnet-app/packages/builtin-tool-agent-builder/src/executor.ts` already has `runtime` plus `getRuntime()` and delegates its `AgentManagerRuntime` calls through the getter.
- `modelnet-app/packages/builtin-tool-group-agent-builder/src/executor.ts` already has `agentManagerRuntime` plus `getAgentManagerRuntime()` and delegates inherited runtime calls through the getter.
- `modelnet-app/packages/builtin-tool-agent-management/src/executor.ts` already has `runtime` plus `getRuntime()` and delegates its `AgentManagerRuntime` calls through the getter.
- `modelnet-app/src/store/tool/slices/builtin/executors/index.initialization.test.ts` currently proves lazy construction and reuse only for `builtin-tool-agent-builder`.
- `scripts/rebuild_modelnet_app_dev.sh` does not exist.
- `docker-compose.dev.yml` defines Compose project `modelnet-toc-dev`, service `modelnet-app`, and build context `${MODELNET_APP_SRC:-${LOBEHUB_TOC_SRC:-./modelnet-app}}`.
- `.env.dev` currently selects image `modelnet-toc-dev-app:cycle-fix-20260711`.

## Non-Negotiable Safety Rules

- Work only on the current 4A100 host in `/home/duxianghe/ModelNet-toc`.
- Treat the `lobehub/` to `modelnet-app/` migration worktree as user-owned. Never run `git add -A`, `git add .`, `git commit -a`, `git reset`, `git clean`, `git checkout`, a repository-wide formatter, or any command that rewrites unrelated files.
- Inspect, edit, test, stage, and commit only paths named by the current task. Before editing an existing path, review its path-scoped status and diff. If an in-scope file contains overlapping changes that the task cannot preserve, stop and ask the controlling agent instead of reverting or replacing it.
- Do not edit the three executor files unless a verification gate proves the stated lazy getters are incomplete. Under the recorded current state, they are verification-only files.
- The rebuild workflow must never run `docker commit`, use a previously running builder as an image source, or create a builder kept alive by `sleep infinity`, `sleep 600`, or any equivalent mutable sleeping command.
- Build only through `docker-compose.dev.yml` with `.env`, `.env.dev`, Compose project `modelnet-toc-dev`, service `modelnet-app`, and absolute `MODELNET_APP_SRC=/home/duxianghe/ModelNet-toc/modelnet-app`.
- Do not build, tag, recreate, restart, or promote any production service. Production access in this plan is passive inspection only.
- Do not perform authenticated Edge verification from an implementation worker. Stop after the automated dev `/signin` gate and hand the recorded image ID and browser checklist to the controlling agent.

## Checkpoint Order

The checkpoints are strictly ordered. Do not build before checkpoints 1-4 pass, do not recreate before checkpoints 5-6 pass, and do not claim browser acceptance before checkpoint 8 is completed by the controlling agent.

1. Preserve and inventory only in-scope worktree changes.
2. Extend the three-executor initialization regression and run it.
3. Verify all three existing lazy getters and affected unit tests.
4. Add the rebuild-script test first, observe RED because the script is absent, implement the script, and reach GREEN.
5. Validate resolved Compose identity/context and record dev and production container baselines.
6. Build current host source through Compose; inspect the exact image ID, bundle, and image history.
7. Revalidate the tag-to-image-ID binding, recreate only dev `modelnet-app` and `toc-lb`, verify `/signin`, and prove production is unchanged.
8. Hand authenticated Edge verification to the controlling agent.

---

### Task 1: Protect the Dirty Migration Worktree

**Files:**

- Inspect: `modelnet-app/src/store/tool/slices/builtin/executors/index.initialization.test.ts`
- Inspect: `modelnet-app/packages/builtin-tool-agent-builder/src/executor.ts`
- Inspect: `modelnet-app/packages/builtin-tool-group-agent-builder/src/executor.ts`
- Inspect: `modelnet-app/packages/builtin-tool-agent-management/src/executor.ts`
- Create later: `scripts/test_rebuild_modelnet_app_dev.py`
- Create later: `scripts/rebuild_modelnet_app_dev.sh`

- [ ] **Step 1: Confirm the host and repository root**

```bash
test "$(hostname)" = "4A100" || test "$(pwd -P)" = "/home/duxianghe/ModelNet-toc"
test "$(pwd -P)" = "/home/duxianghe/ModelNet-toc"
```

Expected: both commands exit 0 and the second check guarantees the exact repository root even if the hostname alias differs.

- [ ] **Step 2: Review only the paths in this implementation slice**

```bash
git status --short -- \
  modelnet-app/src/store/tool/slices/builtin/executors/index.initialization.test.ts \
  modelnet-app/packages/builtin-tool-agent-builder/src/executor.ts \
  modelnet-app/packages/builtin-tool-group-agent-builder/src/executor.ts \
  modelnet-app/packages/builtin-tool-agent-management/src/executor.ts \
  scripts/test_rebuild_modelnet_app_dev.py \
  scripts/rebuild_modelnet_app_dev.sh
git diff -- \
  modelnet-app/src/store/tool/slices/builtin/executors/index.initialization.test.ts \
  modelnet-app/packages/builtin-tool-agent-builder/src/executor.ts \
  modelnet-app/packages/builtin-tool-group-agent-builder/src/executor.ts \
  modelnet-app/packages/builtin-tool-agent-management/src/executor.ts
```

Expected: the current test and getter changes are visible without exposing or altering unrelated migration changes. Record this output in the implementation handoff. Do not clean or normalize anything outside these paths.

### Task 2: Extend the Registry Regression to All Three Executors

**Files:**

- Modify: `modelnet-app/src/store/tool/slices/builtin/executors/index.initialization.test.ts`

**Interfaces:**

- Import `AgentBuilderApiName` and `AgentBuilderIdentifier` from `@lobechat/builtin-tool-agent-builder`.
- Add `GroupAgentBuilderApiName` and `GroupAgentBuilderIdentifier` from `@lobechat/builtin-tool-group-agent-builder`.
- Add `AgentManagementApiName` and `AgentManagementIdentifier` from `@lobechat/builtin-tool-agent-management`.
- Continue invoking the real registry through `registerBuiltinToolExecutors()` and `invokeExecutor()` from `./index`.

- [ ] **Step 1: Expand the hoisted constructor mock and method spies**

Keep `constructorSpy` and `getAvailableModelsSpy`. Add `createAgentSpy`, returning a resolved successful `BuiltinToolResult`, and expose it as `createAgent` on the mocked `AgentManagerRuntime` class. Use `getAvailableModels` for both builder executors and `createAgent` for agent-management so every invocation must delegate through an `AgentManagerRuntime` method.

Expected mock results:

```ts
getAvailableModelsSpy: vi.fn().mockResolvedValue({ content: 'models-ok', success: true }),
createAgentSpy: vi.fn().mockResolvedValue({ content: 'agent-ok', success: true }),
```

- [ ] **Step 2: Make one ordered test prove each executor explicitly**

Preserve the initial import-time assertion and registration assertion at zero constructors. Then execute and assert this exact sequence:

1. Call `AgentBuilderIdentifier` / `AgentBuilderApiName.getAvailableModels` once: constructor total `1`, model-method calls `1`.
2. Call the same agent-builder API again: constructor total remains `1`, model-method calls `2`.
3. Call `GroupAgentBuilderIdentifier` / `GroupAgentBuilderApiName.getAvailableModels` once: constructor total `2`, model-method calls `3`.
4. Call the same group-agent-builder API again: constructor total remains `2`, model-method calls `4`.
5. Call `AgentManagementIdentifier` / `AgentManagementApiName.createAgent` once with a minimal valid object containing `title`: constructor total `3`, create-method calls `1`.
6. Call the same agent-management API again: constructor total remains `3`, create-method calls `2`.

Pass the existing `{ messageId: 'test-message-id' }` context to every invocation. Keep the import-time, registration-time, first-call, and second-call assertions adjacent to the executor they identify; do not replace them with only one final constructor-count assertion.

- [ ] **Step 3: Run the focused test before any other implementation**

```bash
cd /home/duxianghe/ModelNet-toc/modelnet-app
pnpm exec vitest run src/store/tool/slices/builtin/executors/index.initialization.test.ts
```

Expected: PASS. This is a test-first characterization of source code that already contains the approved lazy getters, so do not fabricate a RED result by reverting or temporarily making an executor eager. The meaningful RED/GREEN cycle in this plan applies to the absent rebuild script in Task 4.

### Task 3: Verify the Three Existing Lazy Getters

**Files:**

- Verify only: `modelnet-app/packages/builtin-tool-agent-builder/src/executor.ts`
- Verify only: `modelnet-app/packages/builtin-tool-group-agent-builder/src/executor.ts`
- Verify only: `modelnet-app/packages/builtin-tool-agent-management/src/executor.ts`
- Test: `modelnet-app/src/store/tool/slices/builtin/executors/index.initialization.test.ts`
- Test: `modelnet-app/src/store/tool/slices/builtin/executors/index.test.ts`
- Test: `modelnet-app/packages/agent-manager-runtime/src/__tests__/AgentManagerRuntime.test.ts`

- [ ] **Step 1: Prove one independent lazy slot and getter per executor**

```bash
cd /home/duxianghe/ModelNet-toc/modelnet-app
rg -n '^let (runtime|agentManagerRuntime): AgentManagerRuntime \| undefined;$' \
  packages/builtin-tool-agent-builder/src/executor.ts \
  packages/builtin-tool-group-agent-builder/src/executor.ts \
  packages/builtin-tool-agent-management/src/executor.ts
rg -n '^const get(Runtime|AgentManagerRuntime) = \(\): AgentManagerRuntime => \{$' \
  packages/builtin-tool-agent-builder/src/executor.ts \
  packages/builtin-tool-group-agent-builder/src/executor.ts \
  packages/builtin-tool-agent-management/src/executor.ts
rg -n '(runtime|agentManagerRuntime) \?\?= new AgentManagerRuntime' \
  packages/builtin-tool-agent-builder/src/executor.ts \
  packages/builtin-tool-group-agent-builder/src/executor.ts \
  packages/builtin-tool-agent-management/src/executor.ts
```

Expected: each command reports exactly one match in each of the three files. Agent-builder and agent-management use `getRuntime`; group-agent-builder uses `getAgentManagerRuntime`.

- [ ] **Step 2: Reject any eager module-scope runtime construction**

```bash
if rg -n '^(const|let) (runtime|agentManagerRuntime) = new AgentManagerRuntime' \
  packages/builtin-tool-agent-builder/src/executor.ts \
  packages/builtin-tool-group-agent-builder/src/executor.ts \
  packages/builtin-tool-agent-management/src/executor.ts; then
  exit 1
fi
```

Expected: no matches and exit 0.

- [ ] **Step 3: Run the complete focused regression set**

```bash
pnpm exec vitest run \
  src/store/tool/slices/builtin/executors/index.initialization.test.ts \
  src/store/tool/slices/builtin/executors/index.test.ts \
  packages/agent-manager-runtime/src/__tests__/AgentManagerRuntime.test.ts
pnpm run type-check
```

Expected: all Vitest files pass, the initialization test reaches constructor totals `0 -> 1 -> 2 -> 3`, and `type-check` exits 0. If any getter verification fails, stop and report the exact file; do not overwrite an executor or broaden the change without controlling-agent approval.

### Task 4: TDD the Dev-Only Compose Rebuild Script

**Files:**

- Create: `scripts/test_rebuild_modelnet_app_dev.py`
- Create: `scripts/rebuild_modelnet_app_dev.sh`
- Verify: `docker-compose.dev.yml`
- Verify: `.env`
- Verify: `.env.dev`

**Script contract:**

- Resolve its repository root to `/home/duxianghe/ModelNet-toc` and fail closed elsewhere.
- Reject a pre-set `MODELNET_APP_SRC` unless it equals `/home/duxianghe/ModelNet-toc/modelnet-app`, then export that exact value.
- Require `.env`, `.env.dev`, `docker-compose.dev.yml`, and the absolute source directory to exist.
- Use this exact Compose prefix for both validation and build:

```bash
docker compose \
  --project-name modelnet-toc-dev \
  --env-file /home/duxianghe/ModelNet-toc/.env \
  --env-file /home/duxianghe/ModelNet-toc/.env.dev \
  -f /home/duxianghe/ModelNet-toc/docker-compose.dev.yml
```

- Parse `config --format json` before building and require project name `modelnet-toc-dev`, `services.modelnet-app.build.context` equal to the absolute source path, and `services.modelnet-app.image` be non-empty.
- Print the resolved project, absolute context, image reference, and post-build image ID.
- Execute only `compose build modelnet-app`; it must not run `up`, recreate containers, call `docker commit`, call `docker run`, or use a sleeping builder.

- [ ] **Step 1: Write the Python test before creating the shell script**

Use `unittest`, `tempfile.TemporaryDirectory`, and a fake `docker` executable prepended to `PATH`. The fake must record every argument vector and return controlled JSON for `docker compose ... config --format json`, success for `docker compose ... build modelnet-app`, and a fixed `sha256:` ID for `docker image inspect`.

Cover these exact cases:

1. The missing `scripts/rebuild_modelnet_app_dev.sh` produces RED.
2. A conflicting `MODELNET_APP_SRC` exits nonzero before any build call.
3. Resolved project name other than `modelnet-toc-dev` exits nonzero before build.
4. Resolved context other than `/home/duxianghe/ModelNet-toc/modelnet-app` exits nonzero before build.
5. The success case records the exact Compose prefix above, one `config --format json`, exactly one `build modelnet-app`, and one image inspection for the resolved image reference.
6. The script text and recorded commands contain no `docker commit`, `sleep infinity`, or `sleep 600`; they contain no `docker run` builder path.
7. The script output includes `modelnet-toc-dev`, the absolute context, the resolved image reference, and the fixed image ID.

- [ ] **Step 2: Run the new test and observe RED**

```bash
cd /home/duxianghe/ModelNet-toc
python3 -m unittest scripts/test_rebuild_modelnet_app_dev.py
```

Expected: FAIL because `scripts/rebuild_modelnet_app_dev.sh` does not exist. The failure must be the missing helper, not a Python syntax or fixture error.

- [ ] **Step 3: Implement the smallest script satisfying the contract**

Create `scripts/rebuild_modelnet_app_dev.sh` with `#!/usr/bin/env bash` and `set -euo pipefail`. Use a Bash array for the exact Compose prefix, Python's standard-library JSON parser for resolved-config validation, and `docker image inspect "$IMAGE_REF" --format '{{.Id}}'` after the Compose build. Do not add any deployment behavior.

- [ ] **Step 4: Reach GREEN and validate shell syntax**

```bash
chmod +x scripts/rebuild_modelnet_app_dev.sh
bash -n scripts/rebuild_modelnet_app_dev.sh
python3 -m unittest scripts/test_rebuild_modelnet_app_dev.py
```

Expected: `bash -n` exits 0 and every unittest passes.

### Task 5: Validate Compose and Record Immutable Baselines

**Files:**

- Execute: `scripts/rebuild_modelnet_app_dev.sh`
- Read: `docker-compose.dev.yml`
- Read: `.env`
- Read: `.env.dev`
- Write runtime evidence only under: `/tmp/agent-manager-runtime-cycle-*`

- [ ] **Step 1: Resolve and validate the exact Compose service before any build**

```bash
cd /home/duxianghe/ModelNet-toc
export MODELNET_APP_SRC=/home/duxianghe/ModelNet-toc/modelnet-app
COMPOSE=(docker compose --project-name modelnet-toc-dev --env-file /home/duxianghe/ModelNet-toc/.env --env-file /home/duxianghe/ModelNet-toc/.env.dev -f /home/duxianghe/ModelNet-toc/docker-compose.dev.yml)
"${COMPOSE[@]}" config --format json | python3 -c 'import json, sys; c=json.load(sys.stdin); s=c["services"]["modelnet-app"]; assert c["name"] == "modelnet-toc-dev"; assert s["build"]["context"] == "/home/duxianghe/ModelNet-toc/modelnet-app"; assert s["image"] == "modelnet-toc-dev-app:cycle-fix-20260711"; print(c["name"], s["build"]["context"], s["image"])'
```

Expected output:

```text
modelnet-toc-dev /home/duxianghe/ModelNet-toc/modelnet-app modelnet-toc-dev-app:cycle-fix-20260711
```

If the output differs, stop and report the drift to the controlling agent. Do not silently substitute another image reference or continue with an empty or implicitly resolved image.

- [ ] **Step 2: Record production and dev container IDs and timestamps before the build**

```bash
docker ps -aq --filter label=com.docker.compose.project=modelnet-toc | \
  xargs -r docker inspect --format '{{.Id}}\t{{.Name}}\t{{.Created}}\t{{.State.StartedAt}}\t{{json .HostConfig.PortBindings}}' | \
  sort > /tmp/agent-manager-runtime-cycle-production-before.tsv
docker ps -aq --filter label=com.docker.compose.project=modelnet-toc-dev | \
  xargs -r docker inspect --format '{{.Id}}\t{{.Name}}\t{{.Created}}\t{{.State.StartedAt}}\t{{json .HostConfig.PortBindings}}' | \
  sort > /tmp/agent-manager-runtime-cycle-dev-before.tsv
test -s /tmp/agent-manager-runtime-cycle-production-before.tsv
test -s /tmp/agent-manager-runtime-cycle-dev-before.tsv
```

Expected: both files are non-empty. Each row records immutable container ID, name, creation timestamp, last start timestamp, and port bindings. No container is restarted by these passive commands.

### Task 6: Build and Inspect the Exact Dev Image

**Files:**

- Execute: `scripts/rebuild_modelnet_app_dev.sh`
- Inspect inside image: `/app/public/_spa/**/*.js`
- Record: `/tmp/agent-manager-runtime-cycle-image.txt`
- Record: `/tmp/agent-manager-runtime-cycle-history.txt`

- [ ] **Step 1: Build the current host source only through Compose**

```bash
cd /home/duxianghe/ModelNet-toc
MODELNET_APP_SRC=/home/duxianghe/ModelNet-toc/modelnet-app ./scripts/rebuild_modelnet_app_dev.sh
```

Expected: the helper prints project `modelnet-toc-dev`, context `/home/duxianghe/ModelNet-toc/modelnet-app`, image `modelnet-toc-dev-app:cycle-fix-20260711`, and a `sha256:` image ID. No container is recreated or restarted.

- [ ] **Step 2: Record the exact built image reference and ID**

```bash
IMAGE_REF=$("${COMPOSE[@]}" config --format json | python3 -c 'import json, sys; print(json.load(sys.stdin)["services"]["modelnet-app"]["image"])')
IMAGE_ID=$(docker image inspect "$IMAGE_REF" --format '{{.Id}}')
printf '%s\t%s\n' "$IMAGE_REF" "$IMAGE_ID" > /tmp/agent-manager-runtime-cycle-image.txt
test -n "$IMAGE_REF"
case "$IMAGE_ID" in sha256:*) ;; *) exit 1 ;; esac
```

Expected: `/tmp/agent-manager-runtime-cycle-image.txt` binds `modelnet-toc-dev-app:cycle-fix-20260711` to one full `sha256:` image ID. Use this `IMAGE_ID`, not merely the mutable tag, in every following inspection.

- [ ] **Step 3: Inspect the emitted SPA bundle inside that exact image**

Run the final image's Node binary only as a short-lived, read-only scanner. This is not a builder, is never kept sleeping, and is never committed.

```bash
docker run --rm -i --entrypoint /bin/node "$IMAGE_ID" - <<'NODE'
const fs = require('fs');
const path = require('path');
const root = '/app/public/_spa';
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else files.push(file);
  }
};
walk(root);
const js = files.filter((file) => file.endsWith('.js'));
const text = new Map(js.map((file) => [file, fs.readFileSync(file, 'utf8')]));
const staleName = 'src-DD3mG7pF.js';
if (files.some((file) => path.basename(file) === staleName)) throw new Error(`stale file: ${staleName}`);
if ([...text.values()].some((body) => body.includes(staleName))) throw new Error(`stale reference: ${staleName}`);
if ([...text.values()].some((body) => /b9\s*=\s*new\s+Q9/.test(body))) throw new Error('eager signature: b9=new Q9');
const ids = ['lobe-agent-builder', 'lobe-group-agent-builder', 'lobe-agent-management'];
const candidates = [...text].filter(([, body]) => ids.some((id) => body.includes(id)));
for (const id of ids) {
  if (!candidates.some(([, body]) => body.includes(id))) throw new Error(`missing executor identifier: ${id}`);
}
const lazy = [];
for (const [file, body] of candidates) {
  const pattern = /(?:\?\?=|\|\|=)\s*new\s+[$A-Z_a-z][$\w]*\(\{\s*agentService\s*:/g;
  for (const match of body.matchAll(pattern)) lazy.push([path.relative(root, file), match[0]]);
}
if (lazy.length < 3) throw new Error(`expected at least three emitted lazy runtime constructions, found ${lazy.length}`);
console.log(JSON.stringify({ candidateChunks: candidates.map(([file]) => path.relative(root, file)), lazyConstructions: lazy }, null, 2));
NODE
```

Expected: exit 0; no file or reference named `src-DD3mG7pF.js`; no `b9=new Q9`; all three executor identifiers appear in candidate emitted chunks; and the scanner prints at least three lazy assignment/construction excerpts from those chunks. Save the JSON output with the implementation evidence. The source-level three-getter check and constructor-spy test remain required so a coincidental minifier symbol change cannot satisfy this gate alone.

- [ ] **Step 4: Reject mutable sleeping-builder provenance in the exact image history**

```bash
docker history --no-trunc "$IMAGE_ID" | tee /tmp/agent-manager-runtime-cycle-history.txt
if rg -ni 'sleep[[:space:]]+(infinity|600)' /tmp/agent-manager-runtime-cycle-history.txt; then
  exit 1
fi
```

Expected: history is recorded and the rejection search has no matches. Also verify the helper test still proves no `docker commit`; a tag change or successful build command without these artifact gates is not acceptance.

### Task 7: Recreate Only the Two Dev Services and Prove Isolation

**Files:**

- Deploy only Compose services: `modelnet-app`, `toc-lb`
- Verify: `http://127.0.0.1:3181/signin`
- Record: `/tmp/agent-manager-runtime-cycle-production-after.tsv`
- Record: `/tmp/agent-manager-runtime-cycle-dev-after.tsv`

- [ ] **Step 1: Fail closed if the Compose tag no longer points to the inspected image**

```bash
test "$(docker image inspect "$IMAGE_REF" --format '{{.Id}}')" = "$IMAGE_ID"
```

Expected: exit 0 immediately before recreation. If it fails, return to Task 6 and inspect the new image; never deploy an uninspected tag target.

- [ ] **Step 2: Recreate exactly dev `modelnet-app` and `toc-lb`**

```bash
"${COMPOSE[@]}" up -d \
  --no-deps \
  --no-build \
  --pull never \
  --force-recreate \
  modelnet-app toc-lb
```

Expected: only containers `modelnet-toc-dev-app` and `modelnet-toc-dev-lb` are recreated. Postgres, Redis, RustFS, rustfs-init, searxng, Router, LiteLLM, and every production container retain their prior IDs and start timestamps.

- [ ] **Step 3: Prove the dev app runs the inspected image ID and `/signin` is healthy**

```bash
test "$(docker inspect modelnet-toc-dev-app --format '{{.Image}}')" = "$IMAGE_ID"
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3181/signin
```

Expected: the image-ID assertion exits 0 and curl prints `200`.

- [ ] **Step 4: Record after-state and prove production IDs/timestamps/bindings are byte-for-byte unchanged**

```bash
docker ps -aq --filter label=com.docker.compose.project=modelnet-toc | \
  xargs -r docker inspect --format '{{.Id}}\t{{.Name}}\t{{.Created}}\t{{.State.StartedAt}}\t{{json .HostConfig.PortBindings}}' | \
  sort > /tmp/agent-manager-runtime-cycle-production-after.tsv
docker ps -aq --filter label=com.docker.compose.project=modelnet-toc-dev | \
  xargs -r docker inspect --format '{{.Id}}\t{{.Name}}\t{{.Created}}\t{{.State.StartedAt}}\t{{json .HostConfig.PortBindings}}' | \
  sort > /tmp/agent-manager-runtime-cycle-dev-after.tsv
cmp /tmp/agent-manager-runtime-cycle-production-before.tsv /tmp/agent-manager-runtime-cycle-production-after.tsv
```

Expected: `cmp` exits 0. Every production container ID, creation/start timestamp, and binding is unchanged.

- [ ] **Step 5: Prove only the two named dev container identities changed**

```bash
python3 - <<'PY'
from pathlib import Path

def rows(name):
    return {line.split('\t')[1]: line for line in Path(name).read_text().splitlines() if line}

before = rows('/tmp/agent-manager-runtime-cycle-dev-before.tsv')
after = rows('/tmp/agent-manager-runtime-cycle-dev-after.tsv')
allowed = {'/modelnet-toc-dev-app', '/modelnet-toc-dev-lb'}
assert before.keys() == after.keys(), (before.keys(), after.keys())
changed = {name for name in before if before[name] != after[name]}
assert changed == allowed, changed
print('changed dev containers:', ' '.join(sorted(changed)))
PY
```

Expected output identifies exactly `/modelnet-toc-dev-app` and `/modelnet-toc-dev-lb`. Any additional changed dev or production identity is a failed isolation gate; stop and report it rather than restarting more services.

### Task 8: Hand Authenticated Edge Acceptance to the Controlling Agent

**Files:** none.

- [ ] **Step 1: Provide the controlling agent with the exact evidence bundle**

Report:

- the focused Vitest and type-check results;
- rebuild-script RED/GREEN results;
- `IMAGE_REF` and full `IMAGE_ID` from `/tmp/agent-manager-runtime-cycle-image.txt`;
- bundle scanner JSON and `/tmp/agent-manager-runtime-cycle-history.txt`;
- `/signin` HTTP `200`;
- the successful production `cmp` and the two-name dev change set.

- [ ] **Step 2: Leave these authenticated Edge checks to the controlling agent**

The controlling agent must load the authenticated dev SPA at `http://127.0.0.1:3181`, with DevTools open and cache disabled, and verify all of the following against the just-recorded `IMAGE_ID` deployment:

1. Edge does not request `src-DD3mG7pF.js`.
2. The console does not report `Q9 is not a constructor`.
3. The authenticated SPA renders and does not remain on the full-page Loading fallback.

Expected implementation-worker outcome: report the automated gates as complete and mark authenticated Edge acceptance as explicitly pending controlling-agent verification. Do not claim full runtime acceptance on `/signin` alone.

## Final Self-Review Gate

Before implementation handoff, verify that:

- the plan treats all three lazy getters as existing state and never asks to reimplement them without a failed verification gate;
- the current one-executor test is extended in explicit `agent-builder -> group-agent-builder -> agent-management` order with constructor totals `0 -> 1 -> 2 -> 3` and per-executor reuse assertions;
- the rebuild script has a real RED/GREEN TDD cycle and uses only the exact absolute source, Compose file, env files, project, and service;
- `docker commit`, mutable sleeping builders, `sleep infinity`, and `sleep 600` are prohibited and tested;
- the exact built `sha256:` image is used for bundle inspection, history inspection, pre-deploy tag revalidation, and running-container verification;
- bundle acceptance rejects both `b9=new Q9` and `src-DD3mG7pF.js` and requires emitted lazy-construction evidence;
- production baselines are captured before the build and compared after recreation;
- recreation is limited to dev `modelnet-app` and `toc-lb` with `--no-deps --no-build --pull never`;
- `/signin` is automated while authenticated Edge verification is owned by the controlling agent;
- no command cleans, resets, formats, stages, commits, or otherwise mutates unrelated migration work.
