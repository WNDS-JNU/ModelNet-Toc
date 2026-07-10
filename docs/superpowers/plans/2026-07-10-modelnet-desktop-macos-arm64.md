# ModelNet Desktop macOS ARM64 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the current ModelNet ToC work as focused Git commits, then build and verify an unsigned Apple Silicon ModelNet Desktop DMG on the supplied Mac.

**Architecture:** The repository remains the source of truth. Semantically isolated changes are committed on the current branch and pushed to `origin`; the Mac clones that exact branch and builds the Electron app natively. Electron Builder detects the Mac's `arm64` architecture and, without `CSC_LINK`, creates unsigned DMG and ZIP artifacts.

**Tech Stack:** Git, Node.js 22+ ARM64, Corepack, pnpm 10.33.0, Electron Builder, macOS `hdiutil`, Tailscale SSH.

## Global Constraints

- Build only for macOS `arm64`; Intel, signing, notarization, auto-update publishing, and backend bundling are excluded.
- Keep `MODELNET_DESKTOP_SERVER_URL=http://123.56.135.150`.
- Do not save the Mac password or use `CSC_LINK`.
- Stage and commit only paths that belong to one verified work item; never use `git add -A`.
- The handoff file is `~/Desktop/ModelNet-Desktop-v0.1-macos-arm64.dmg` on the Mac.

---

### Task 1: Create focused local commits from the existing worktree

**Files:**
- Modify: existing ModelNet Router, registry producer, LobeHub, Compose, and documentation paths already present in the worktree.
- Test: `modelnet_router/test_adaptive_auto.py`, `scripts/test_modelnet_registry_source.py`, `scripts/test_sync_modelnet_lobehub.py`, and affected LobeHub unit tests.

**Interfaces:**
- Consumes: the current uncommitted worktree on `codex/merge-lobehub-canary-20260703`.
- Produces: ordered local commits with each commit passing `git diff --cached --check` before it is recorded.

- [ ] **Step 1: Check each candidate commit boundary**

Run `git diff --check` and inspect each staged candidate with `git diff --cached --stat` before committing. Keep router resilience, registry model filtering, ModelNet frontend integration, LobeHub platform migration, conversation/page work, and operations documentation in separate commits.

- [ ] **Step 2: Verify Router and registry commits**

Run:

```bash
/tmp/modelnet-router-test-venv/bin/python -m unittest modelnet_router/test_adaptive_auto.py
python3 -m unittest scripts/test_modelnet_registry_source.py scripts/test_sync_modelnet_lobehub.py
```

Expected: both commands exit with status `0`.

- [ ] **Step 3: Verify applicable LobeHub unit tests**

From `lobehub`, run Vitest for every changed test file that has its dependencies available. Expected: the selected test files exit with status `0`; if the workstation lacks dependencies, retain that fact in the build record and let the native Mac dependency install provide the packaging validation.

- [ ] **Step 4: Commit each validated work item**

For every group, stage only its own paths, run `git diff --cached --check`, and commit with a scoped Conventional Commit message. Finish with `git status --short` and confirm only intentionally deferred paths remain.

### Task 2: Push the source branch and record the build input

**Files:**
- Modify: Git refs only.
- Test: `git ls-remote --heads origin`.

**Interfaces:**
- Consumes: the focused commits from Task 1.
- Produces: an `origin` branch and immutable source SHA for the Mac checkout.

- [ ] **Step 1: Push the current branch**

Run:

```bash
git push -u origin codex/merge-lobehub-canary-20260703
```

Expected: Git reports the upstream branch and successful object transfer.

- [ ] **Step 2: Capture the exact source revision**

Run:

```bash
git rev-parse HEAD
git ls-remote --heads origin codex/merge-lobehub-canary-20260703
```

Expected: the local SHA is reachable from the pushed remote branch.

### Task 3: Prepare an isolated native build checkout on the Mac

**Files:**
- Create: `/Users/xianghedu/ModelNet-toc-macos-build/`.
- Create: `/Users/xianghedu/.local/modelnet-node22/`.
- Test: `node --version`, `pnpm --version`, and `git rev-parse HEAD` in the Mac checkout.

**Interfaces:**
- Consumes: the branch and SHA from Task 2.
- Produces: a clean macOS ARM64 checkout with Node.js 22+ and pnpm 10.33.0.

- [ ] **Step 1: Clone and pin the source**

Clone `git@github.com:WNDS-JNU/ModelNet-Toc.git` into `/Users/xianghedu/ModelNet-toc-macos-build`, fetch the branch from Task 2, and check out its recorded SHA. Expected: `git status --short` is empty.

- [ ] **Step 2: Install the private ARM64 toolchain**

Download a Node.js 22+ Darwin ARM64 archive, verify it with the matching `SHASUMS256.txt`, extract it under `/Users/xianghedu/.local/modelnet-node22`, and activate `pnpm@10.33.0` through Corepack. Expected: Node major version is at least 22 and pnpm reports `10.33.0`.

- [ ] **Step 3: Install project dependencies**

From the Mac checkout's `lobehub` directory run `pnpm install --node-linker=hoisted --registry=https://registry.npmmirror.com`, then run `pnpm install --registry=https://registry.npmmirror.com` in `lobehub/apps/desktop`. Keep the Electron and Electron Builder mirror variables set to their existing `npmmirror.com` paths. Expected: both installations exit with status `0`.

### Task 4: Package and verify the unsigned macOS application

**Files:**
- Create: `lobehub/apps/desktop/release/ModelNet Desktop-0.0.0-arm64.dmg` on the Mac.
- Create: `lobehub/apps/desktop/release/ModelNet Desktop-0.0.0-arm64.zip` on the Mac.
- Create: `/Users/xianghedu/Desktop/ModelNet-Desktop-v0.1-macos-arm64.dmg` on the Mac.

**Interfaces:**
- Consumes: the prepared checkout from Task 3.
- Produces: a locally installable, unsigned Apple Silicon DMG and recorded checksum.

- [ ] **Step 1: Build the Electron artifacts**

From `lobehub`, run:

```bash
MODELNET_DESKTOP=1 MODELNET_DESKTOP_SERVER_URL=http://123.56.135.150 npm run desktop:package:modelnet:app
```

Expected: Electron Builder reports an `arm64` DMG and ZIP under `apps/desktop/release`, with signing disabled because no `CSC_LINK` exists.

- [ ] **Step 2: Validate the DMG and bundle architecture**

Mount the DMG with `hdiutil attach -nobrowse`, run `file` on `ModelNet Desktop.app/Contents/MacOS/ModelNet Desktop`, then detach it with `hdiutil detach`. Expected: `file` reports `arm64`; mount and detach both exit with status `0`.

- [ ] **Step 3: Create the desktop handoff and checksum**

Copy the generated DMG to `/Users/xianghedu/Desktop/ModelNet-Desktop-v0.1-macos-arm64.dmg`, run `shasum -a 256` over that file, and report the SHA-256 plus the source Git SHA. Expected: the copied DMG exists and has a non-empty checksum.

### Task 5: Report the native build result

**Files:**
- Modify: none.
- Test: final artifact existence check on the Mac desktop.

**Interfaces:**
- Consumes: the verified DMG and metadata from Task 4.
- Produces: a concise handoff with install instructions.

- [ ] **Step 1: Confirm final artifact metadata**

Report the Mac path, file size, SHA-256, source commit SHA, Node/pnpm versions, and the exact package command.

- [ ] **Step 2: State the expected unsigned-install flow**

In Finder, open the DMG, drag `ModelNet Desktop.app` to Applications, then right-click the app and choose **Open** for the first launch. State that the warning is expected because this release is intentionally unsigned and not notarized.
