# ModelNet ToC Agent Notes

## Current 4A100 Host

- Current device: this workspace is already on `4A100`.
- SSH from other machines: `ssh 4A100`
- Code dir: `/home/duxianghe/ModelNet-toc`
- code_sync: current 4A100 working tree
- wandb: false

## Project Preferences

- All development for this project must happen on the current `4A100` device, inside the confirmed directory `/home/duxianghe/ModelNet-toc`.
- Codex network access for this project should go through the local proxy on port `7890` (for example `127.0.0.1:7890` / `localhost:7890`).

<!-- codex-memory:modelnet-dev-stack:start -->
## Current Memory: Isolated TOC Dev Stack and Promotion Rule

- As of 2026-06-18, the project has an isolated dev stack on `4A100` in `/home/duxianghe/ModelNet-toc`, defined by `docker-compose.dev.yml` and ignored `.env.dev`.
- Development policy: make code/config changes and test them on the dev stack first. Promote to the production stack only after dev verification passes.
- The dev stack includes TOC/Lobe, `modelnet-router`, LiteLLM, and private dev dependencies: Postgres, Redis, RustFS, and searxng.
- Dev stack identity:
  - Compose project/network: `lobehub-toc-dev` / `lobehub-toc-dev_lobe-dev-network`.
  - Main containers: `lobehub-toc-dev-lobe`, `lobehub-toc-dev-lb`, `modelnet-router-dev`, `modelnet-litellm-dev`.
  - Dev volumes are project-scoped under `lobehub-toc-dev_*`, separate from production volumes.
- Dev host bindings are local-only on 4A100:
  - TOC: `127.0.0.1:3181 -> 80`.
  - LiteLLM: `127.0.0.1:3190 -> 8000`.
  - Router: `127.0.0.1:3192 -> 8000`.
  - RustFS dev: `127.0.0.1:9180 -> 9000`, `127.0.0.1:9181 -> 9001`.
- Dev isolation rule: do not attach the dev router to production Dify's `docker_default` network with alias `modelnet-gateway`; that alias belongs to production routing.
- Dev TOC should point at dev services: `APP_URL=http://127.0.0.1:3181`, `OPENAI_PROXY_URL=http://litellm:8000/v1`, `REDIS_PREFIX=lobehub-toc-dev`, and `S3_ENDPOINT=http://rustfs:9000`.
- `modelnet-litellm-dev` currently reuses the existing `lobehub-toc-litellm-modelnet` image, but runs as a separate dev container with separate port, network, and mounted config.
- This Codex/workspace session is already on 4A100. For commands, run them directly in `/home/duxianghe/ModelNet-toc`; from another machine, use an SSH tunnel such as `ssh -N -L 3181:127.0.0.1:3181 -L 3190:127.0.0.1:3190 -L 3192:127.0.0.1:3192 4A100`, then open `http://127.0.0.1:3181`.
- Useful dev commands:
  - Status: `cd /home/duxianghe/ModelNet-toc && docker compose --env-file .env --env-file .env.dev -f docker-compose.dev.yml ps`.
  - Start after images exist: `cd /home/duxianghe/ModelNet-toc && docker compose --env-file .env --env-file .env.dev -f docker-compose.dev.yml up -d --no-build --pull never`.
  - Stop while preserving dev data: `cd /home/duxianghe/ModelNet-toc && docker compose --env-file .env --env-file .env.dev -f docker-compose.dev.yml down`.
- Verification on 2026-06-18: dev TOC `/signin` returned `200`, dev router `/healthz` returned `status: ok`, LiteLLM liveliness/readiness returned `200`, and production `3081/3090/3092` remained healthy.
<!-- codex-memory:modelnet-dev-stack:end -->

## Model Deployment

- Local-LAN ModelNet inference backends are deployed through Kubernetes.
- LiteLLM is the outer OpenAI-compatible proxy. Aggregate/auto aliases such as `modelnet` and `modelnet-auto` go to `modelnet-router`; concrete backend model IDs go directly to their generated K8S backend endpoints.
- Do not assume model backends are local Docker Compose services when running smoke tests or debugging backend availability.

## P0 Smoke Notes

- Keep real API smoke runs small, typically 1-2 requests per runner.
- For P0-B observability validation, check `metadata.internal_total_tokens`, `metadata.internal_usage`, and `metadata.call_ledger_summary` in both `answers.jsonl` and `summary.json` outputs.

## Current Memory: P0-B Observability Closure

- As of 2026-06-11 11:23:11 +0800, P0-B observability closure has passed on `4A100`.
- `benchmarks/data/modelnet_claim_injected_errors.jsonl` was removed from the ignored `benchmarks/data/` path. The tracked fixture path is now `benchmarks/fixtures/modelnet_claim_injected_errors.jsonl`.
- `modelnet_router/test_adaptive_auto.py` reads the injected-error fixture from `benchmarks/fixtures/`.
- `benchmarks/run_load_balancing_modelnet.py` now writes a `summary.json` `observability` block with per-system internal call count, internal tokens, internal usage, and stage latency distribution.
- The running `modelnet-router` container was rebuilt and recreated so the live API endpoint loads the P0-A call-ledger code from the current working tree.
- Latest real smoke output: `benchmarks/results/p0b-observability-smoke-20260611-02/`.
- Latest smoke status: `3/3` requests ok.
- Latest smoke runners:
  - `single_best` -> `route.once`: 1 internal call, 229 internal tokens, 4228 ms.
  - `adaptive_sparse_graph` -> `auto.rank_fuse`: 3 internal calls, 939 internal tokens, 6892 ms.
  - `parallel_consensus` -> `response.parallel`: 4 internal calls, 1049 internal tokens, 11207 ms.
- Latest smoke field check passed for both `answers.jsonl` and `summary.json`: `metadata.internal_total_tokens`, `metadata.internal_usage`, and `metadata.call_ledger_summary` are present.
- Verification passed:
  - `/tmp/modelnet-router-test-venv/bin/python -m unittest modelnet_router/test_adaptive_auto.py`
  - `python3 -m py_compile modelnet_router/app.py benchmarks/run_mtbench_modelnet.py benchmarks/run_pressure_modelnet.py benchmarks/run_load_balancing_modelnet.py`
- Do not start P1 work until this P0-B state is committed or explicitly accepted.
- P1 first slice should remain read-only Claim Memory: SQLite schema, manual strong-evidence writes, verified/contested retrieval and injection. Do not implement model automatic promotion in the first P1 slice.

<!-- codex-memory:modelnet-public-chain:start -->
## Current Memory: Public TOC/Dify Exposure and ModelNet Request Chain

- As of 2026-06-17, public traffic enters through Aliyun `aliyunM` (`123.56.135.150`) and reaches 4A100 over Tailscale. Aliyun Tailscale IP is `100.76.239.10`; 4A100 currently appears as `wnds-server` with Tailscale IP `100.116.34.3`.
- Aliyun Nginx config is `/etc/nginx/conf.d/toc-dify-tailscale.conf`.
  - `http://123.56.135.150/` and `http://toc.123.56.135.150.sslip.io/` proxy to `100.116.34.3:3081` (TOC).
  - `http://123.56.135.150:8080/` and `http://tob.123.56.135.150.sslip.io/` proxy to `100.116.34.3:80` (Dify / TOB).
  - Aliyun does **not** proxy ModelNet gateway ports `3090` or `3092`; public access to `123.56.135.150:3090` and `:3092` should fail.
- Current 4A100 project root is `/home/duxianghe/ModelNet-toc`; all development for this project happens there.
- TOC compose chain:
  - `lobehub-toc-lb` (`toc-lb`) publishes `0.0.0.0:3081 -> 80` and uses `haproxy.cfg`.
  - HAProxy frontend `toc_http` forwards to backend `lobe_apps`, server `lobe:3210`.
  - `lobehub-toc-lobe` (`lobe`) runs the Lobe/TOC app on internal port `3210`.
  - `.env` currently sets `APP_URL=http://123.56.135.150`; this was required so auth callbacks stop pointing at `http://10.154.22.10:3081`.
- ModelNet internal chain from TOC:
  - Lobe chat code adds ModelNet payload controls in `lobehub/src/services/chat/index.ts` and ModelNet constants live in `lobehub/src/features/ModelNetParallel/index.ts`.
  - Lobe calls internal `modelnet-litellm` on the compose network. LiteLLM also publishes `127.0.0.1:3090->8000` only for local debugging.
  - LiteLLM config is `litellm/modelnet-config.yaml`. It defines `modelnet` and `modelnet-auto` as `openai/*` aliases with `api_base: http://modelnet-router:8000/v1` and `allowed_openai_params: [modelnet]`.
  - `modelnet-router` is exposed only as `127.0.0.1:3092->8000` and as compose alias `modelnet-gateway` on `lobe-network` and `dify-default`.
  - Router registry is mounted from `/home/duxianghe/dify/api/configs/model_net.yaml` into `/app/model_net.yaml`.
  - Router source of truth is `modelnet_router/app.py`; runner aliases are registered in `modelnet_router/modelnet_gateway/plugins.py`.
- Current model naming / API behavior:
  - `modelnet_router/app.py` defines `PUBLIC_MODEL_NAME=modelnet` and `PUBLIC_AUTO_MODEL_NAME=modelnet-auto`.
  - Current code treats `modelnet` as retired for automatic networking and says to use `modelnet-auto`.
  - Existing LiteLLM config still contains both aliases, so UI/model selection may still send `model=modelnet`.
- Current public-error diagnosis:
  - The observed public URL error `litellm.MidStreamFallbackError ... Received Model Group=modelnet` is **not** caused by needing to expose LiteLLM publicly.
  - The request reaches TOC and internal LiteLLM. Logs show LiteLLM forwarding `/v1/responses` to concrete backends such as llama.cpp endpoints, e.g. `.../v1/responses`, where some backends return `404 File Not Found`.
  - Likely root class: Responses API compatibility / model alias selection / backend capability mismatch, not Aliyun or Tailscale routing.
  - First debug direction: reproduce locally on this 4A100 device against `modelnet-litellm` and `modelnet-router`, compare `modelnet` vs `modelnet-auto`, and either route Responses API only to compatible backends or force chat-completions-compatible flow for incompatible llama.cpp backends.
- Useful verification commands:
  - `ssh aliyunM "nginx -t && systemctl is-active nginx && tailscale status"`
  - `ssh aliyunM "curl -sS -L -o /tmp/toc.html -w '%{http_code}\n' http://127.0.0.1/"`
  - `ssh aliyunM "curl -sS -L -o /tmp/dify.html -w '%{http_code}\n' http://127.0.0.1:8080/"`
  - `cd /home/duxianghe/ModelNet-toc && docker compose ps`
  - `cd /home/duxianghe/ModelNet-toc && docker compose logs --tail=200 litellm modelnet-router`
<!-- codex-memory:modelnet-public-chain:end -->
