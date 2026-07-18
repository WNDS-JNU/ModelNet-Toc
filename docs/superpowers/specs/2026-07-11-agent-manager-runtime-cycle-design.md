# AgentManagerRuntime Initialization Cycle Design

## Status and Scope

This design is approved for the isolated `modelnet-toc-dev` stack only. It preserves the existing lazy-singleton fix, expands its regression contract to all three affected executors, and replaces the non-reproducible image-patching workflow that prevented the fix from reaching the browser.

Implementation scope is limited to the three executor modules, their focused registry-level regression test, one dev-only rebuild script, and the associated design/plan documentation. Production images, containers, networks, ports, and data are explicitly out of scope.

## Problem

The authenticated desktop SPA crashes before its first render with `TypeError: Q9 is not a constructor`. The Rolldown chunk maps that constructor call to module-scope `new AgentManagerRuntime(...)` in the builtin tool executors.

The dependency cycle is:

`tool store executor registry -> builtin executor -> AgentManagerRuntime -> tool store`

Three registry-imported executors participated in the cycle by constructing `AgentManagerRuntime` during module evaluation:

- `builtin-tool-agent-builder`
- `builtin-tool-group-agent-builder`
- `builtin-tool-agent-management`

Changing only one executor would leave the same initialization-order hazard in the other two.

## Proven Deployment Root Cause

The source-level lazy-singleton change and the deployed result must be treated as separate concerns. The attempted cycle-fix runtime image was produced with `docker commit` from a stale builder container. That container had not received the changed host source under `/home/duxianghe/ModelNet-toc/modelnet-app`, so committing it merely preserved the old build output.

The resulting running bundle still contained the eager-construction signature `b9=new Q9`, and Edge continued to load the old `src-DD3mG7pF.js` chunk. Restarting or recreating from that image could therefore never validate the host source fix. This was a deployment-provenance failure, not evidence that the lazy-singleton design was ineffective.

## Approved Runtime Design

Keep all three module-local lazy singleton getters. Each affected executor retains its own `AgentManagerRuntime | undefined` slot and initializes it synchronously on the first runtime-delegating method call:

```ts
let runtime: AgentManagerRuntime | undefined;

const getRuntime = (): AgentManagerRuntime => {
  runtime ??= new AgentManagerRuntime({ agentService, discoverService });
  return runtime;
};
```

The group-agent-builder may retain its clearer `agentManagerRuntime` and `getAgentManagerRuntime` names; the lifecycle contract is the same. The getter reads the live `AgentManagerRuntime` binding only after the SPA module graph has initialized. Every call site that previously used a module-scope instance must go through its executor's getter.

Each executor keeps one independent singleton, matching the pre-fix one-instance-per-executor lifetime. Public exports, executor identifiers, method signatures, injected services, return values, and post-call behavior remain unchanged. The static import cycle may still exist, but module evaluation no longer dereferences the not-yet-initialized constructor.

## Regression Contract

Extend the registry-level Vitest coverage to all three executors, using a constructor spy for `AgentManagerRuntime` and representative runtime-delegating APIs with mocked method results. The test must prove, in order:

1. Importing the real builtin executor registry constructs zero runtime instances.
2. Explicitly registering the executors still constructs zero runtime instances.
3. The first invocation of `builtin-tool-agent-builder` constructs exactly one instance, and a second invocation reuses it.
4. The first invocation of `builtin-tool-group-agent-builder` increases the total to exactly two instances, and a second invocation reuses its instance.
5. The first invocation of `builtin-tool-agent-management` increases the total to exactly three instances, and a second invocation reuses its instance.

The assertions must identify each executor explicitly rather than inferring coverage from a final constructor count. This catches an eager constructor, a missing getter conversion, and accidental sharing of one singleton across executors. Existing registry and `AgentManagerRuntime` unit tests remain part of the verification set.

## Reproducible Dev Image Build

Add a dev-only rebuild script, `scripts/rebuild_modelnet_app_dev.sh`, that builds the dev `modelnet-app` image from the actual host source. The effective Docker build context must be the absolute path:

`/home/duxianghe/ModelNet-toc/modelnet-app`

The script must use `docker-compose.dev.yml` with the `modelnet-toc-dev` project and the existing `.env` plus `.env.dev` inputs. It must set or validate `MODELNET_APP_SRC` so the resolved Compose build context is exactly the path above, print the resolved image/context for auditability, fail closed if the project or context differs, and build the `modelnet-app` service through Docker/Compose rather than from a mutable running container.

`docker commit` is prohibited for this workflow. Builder containers kept alive with `sleep infinity`, `sleep 600`, or similar commands are also prohibited as image sources because their filesystem can diverge from the host source and their provenance is not reproducible. A stale builder container must never be used as a substitute for a Docker build context.

The absolute context makes this helper intentionally host-specific and dev-only. That trades portability for an auditable guarantee that the 4A100 workspace being edited is the workspace being built.

## Image and Bundle Acceptance Gates

Before deployment, inspect the newly built image itself rather than a host-side build directory or a pre-existing container. All of the following are required:

- scan the emitted JavaScript bundle and confirm that the eager constructor signature `b9=new Q9` is absent;
- confirm through the emitted chunk or its source map that construction occurs inside the lazy getter path, so a changed minifier symbol cannot create a false pass;
- confirm the image does not contain or reference the stale `src-DD3mG7pF.js` chunk;
- run `docker history --no-trunc` on the exact image selected by the dev Compose service and confirm there are no `sleep infinity` or `sleep 600` layers;
- record the inspected image ID and use that same image ID for the dev recreation.

A successful Docker command or a changed image tag alone is insufficient. These gates tie the source fix to the artifact that will actually run.

## Dev Deployment and Runtime Verification

After the tests and image gates pass, recreate only the `modelnet-app` and `toc-lb` services in Compose project `modelnet-toc-dev`. Use `--no-deps`, `--no-build`, and `--pull never`, or a strictly equivalent scoped command, so the inspected image cannot be replaced and Postgres, Redis, RustFS, searxng, Router, LiteLLM, and all production services are not recreated.

Verify:

1. the dev `modelnet-app` container runs the recorded inspected image ID;
2. dev `/signin` at `http://127.0.0.1:3181/signin` returns HTTP 200;
3. an authenticated Edge load no longer requests `src-DD3mG7pF.js`;
4. the authenticated SPA renders without `Q9 is not a constructor` and without remaining on the full-page Loading fallback;
5. only the dev `modelnet-app` and `toc-lb` container identities/restart timestamps changed;
6. production container identities, restart timestamps, health, and bindings remain unchanged.

Do not build, tag, recreate, restart, or promote anything in the production stack as part of this remediation.

## Alternatives Considered

1. **Create executors through factories inside `registerBuiltinToolExecutors`.** This makes lifecycle ownership more explicit, but changes the registry API and all three executor exports while retaining the static import cycle. The lazy getters achieve the required evaluation safety with less surface-area change.
2. **Inject every Zustand store dependency into `AgentManagerRuntime`.** This could remove the architectural cycle entirely, but it is a broader refactor spanning the runtime's agent, model, user, and tool-store operations. It has a larger regression surface and is not required for the immediate SPA recovery.
3. **Patch a running or sleeping builder and use `docker commit`.** This can appear faster, but it cannot prove which host source was incorporated, produced the stale bundle in this incident, and leaves non-reproducible history. It is prohibited.
4. **Reuse an existing cached builder container.** This avoids build time but preserves the same source-synchronization ambiguity as `docker commit`. Docker layer cache may be used only through the declared Docker build with the verified context; a mutable builder container may not be the source artifact.
5. **Recreate the entire dev stack.** This provides no additional evidence for a frontend artifact change and needlessly disrupts stateful and routing services. Recreating only dev `modelnet-app` and `toc-lb` is sufficient and makes any restart scope easy to audit.
6. **Promote immediately to production after a successful build.** This shortens delivery time but bypasses the project's dev-first policy and expands the blast radius. Production promotion requires a separate, explicit approval after dev verification.

## Worktree and Change Safety

The repository contains an in-progress `lobehub/` to `modelnet-app/` migration and many unrelated dirty or untracked changes. Implementation must preserve them. No broad add, reset, clean, checkout, or formatting command is allowed; files must be selected explicitly when reviewing, staging, or committing.

For this design-document update, only `docs/superpowers/specs/2026-07-11-agent-manager-runtime-cycle-design.md` may be edited, staged, and committed. The implementation files described above remain future implementation scope and must not be included in this documentation-only commit.

## Design Self-Review Gate

Before accepting this document or implementing it, confirm that:

- there are no placeholders, TODOs, unresolved choices, or commands with an unspecified project/context/image;
- the three lazy getters, three-executor test matrix, and one-instance-per-executor lifecycle agree throughout;
- source-level cycle remediation is not confused with the stale-image deployment root cause;
- bundle inspection, image-history inspection, dev recreation, and browser verification all refer to the same image;
- `modelnet-toc-dev`, the absolute `modelnet-app` context, and the two-service recreation boundary are explicit;
- no step authorizes production changes or unrelated worktree cleanup;
- the alternatives state both their benefit and the reason they were rejected.
