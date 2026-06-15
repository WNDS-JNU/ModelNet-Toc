# P0-B Observability Smoke Summary

- Output dir: `/home/duxianghe/ModelNet-toc/benchmarks/results/p0b-observability-smoke-20260611-02`
- Generated at: `2026-06-11T11:04:54+08:00`
- Endpoint: `http://127.0.0.1:3092/v1/chat/completions`
- Deployment note: ModelNet router runs in Docker Compose; model inference backends are reached through K8S.
- Answer status: `3/3` ok

## Field Check

| Artifact | Required fields | Status |
| --- | --- | --- |
| `answers.jsonl` | `metadata.internal_total_tokens`, `metadata.internal_usage`, `metadata.call_ledger_summary` | pass |
| `summary.json` | `observability.*.internal_total_tokens`, `observability.*.internal_usage`, `observability.*.call_ledger_summary` | pass |

## Runner Metrics

| System | Runner | Status | Latency ms | Internal calls | Internal tokens | Answer stages |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `single_best` | `route.once` | `ok` | 4228 | 1 | 229 | route.once |
| `adaptive_sparse_graph` | `auto.rank_fuse` | `ok` | 6892 | 3 | 939 | candidate.answer, candidate.answer, ranker.select |
| `parallel_consensus` | `response.parallel` | `ok` | 11207 | 4 | 1049 | response.parallel, response.parallel, response.parallel, optional.synthesizer.final |

## Stage Latency Distribution

- `single_best`: route.once: 1 calls, p95 4066.0 ms
- `adaptive_sparse_graph`: candidate.answer: 2 calls, p95 3502.0 ms; ranker.select: 1 calls, p95 3381.0 ms
- `parallel_consensus`: optional.synthesizer.final: 1 calls, p95 4882.0 ms; response.parallel: 3 calls, p95 6313.0 ms
