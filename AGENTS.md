# ModelNet ToC Agent Notes

## Remote Server

- SSH: `ssh 4A100`
- Code dir: `/home/duxianghe/ModelNet-toc`
- code_sync: remote working tree
- wandb: false

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
