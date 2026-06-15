# ModelNet Load-Balancing Benchmark

- Generated at: `2026-06-11T11:04:54+08:00`
- Workload: `synthetic`
- Requests: `1`
- Scheduled duration: `0.00s`
- SLO: `120000 ms`

## Performance

| System | OK/Total | p50 ms | p95 ms | p99 ms | e2e p95 ms | queue p95 ms | SLO violation | req/min | out tok/s | peak in-flight |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `single_best` | 1/1 | 4228.00 | 4228.00 | 4228.00 | 4229.00 | 1.00 | 0.000 | 14.19 | 15.13 | 1 |
| `adaptive_sparse_graph` | 1/1 | 6892.00 | 6892.00 | 6892.00 | 6893.00 | 0.00 | 0.000 | 8.70 | 26.98 | 1 |
| `parallel_consensus` | 1/1 | 11207.00 | 11207.00 | 11207.00 | 11208.00 | 0.00 | 0.000 | 5.35 | 26.59 | 1 |

## Backend Load Balance

| System | Used backends | Backend selections | Max share | Gini | CV | Jain fairness |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `single_best` | 1 | 1 | 1.000 | 0.944 | 4.123 | 0.056 |
| `adaptive_sparse_graph` | 2 | 3 | 0.667 | 0.907 | 3.000 | 0.100 |
| `parallel_consensus` | 3 | 4 | 0.500 | 0.861 | 2.398 | 0.148 |

## Top Selected Backends

- `single_best`: inference-qwen-qwen3-14b-awq: 1
- `adaptive_sparse_graph`: inference-qwen-qwen3-14b-awq: 2, inference-cyankiwi-granite-4-0-h-micro-awq-4bit: 1
- `parallel_consensus`: inference-cyankiwi-granite-4-0-h-micro-awq-4bit: 2, inference-qwen-qwen3-14b-awq: 1, llama-cpp-deploy-jetson-16g-6-hunyuan-7b-instruct-q5km: 1

## Routing Mix

- `single_best`: route.once: 1
- `adaptive_sparse_graph`: auto.rank_fuse: 1
- `parallel_consensus`: response.parallel: 1

## Observability

| System | Missing metadata | Internal calls | Internal tokens | Stage distribution |
| --- | ---: | ---: | ---: | --- |
| `single_best` | 0 | 1 | 229 | route.once: 1 calls, p95 4066.00 ms |
| `adaptive_sparse_graph` | 0 | 3 | 939 | candidate.answer: 2 calls, p95 3502.00 ms, ranker.select: 1 calls, p95 3381.00 ms |
| `parallel_consensus` | 0 | 4 | 1049 | optional.synthesizer.final: 1 calls, p95 4882.00 ms, response.parallel: 3 calls, p95 6313.00 ms |
