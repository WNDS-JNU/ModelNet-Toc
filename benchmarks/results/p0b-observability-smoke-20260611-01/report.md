# ModelNet Load-Balancing Benchmark

- Generated at: `2026-06-11T10:57:25+08:00`
- Workload: `synthetic`
- Requests: `1`
- Scheduled duration: `0.00s`
- SLO: `120000 ms`

## Performance

| System | OK/Total | p50 ms | p95 ms | p99 ms | e2e p95 ms | queue p95 ms | SLO violation | req/min | out tok/s | peak in-flight |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `single_best` | 1/1 | 4378.00 | 4378.00 | 4378.00 | 4380.00 | 1.00 | 0.000 | 13.70 | 16.44 | 1 |
| `adaptive_sparse_graph` | 1/1 | 12089.00 | 12089.00 | 12089.00 | 12089.00 | 0.00 | 0.000 | 4.96 | 10.17 | 1 |
| `parallel_consensus` | 1/1 | 7368.00 | 7368.00 | 7368.00 | 7368.00 | 0.00 | 0.000 | 8.14 | 17.24 | 1 |

## Backend Load Balance

| System | Used backends | Backend selections | Max share | Gini | CV | Jain fairness |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `single_best` | 1 | 1 | 1.000 | 0.944 | 4.123 | 0.056 |
| `adaptive_sparse_graph` | 2 | 2 | 0.500 | 0.889 | 2.828 | 0.111 |
| `parallel_consensus` | 3 | 3 | 0.333 | 0.833 | 2.236 | 0.167 |

## Top Selected Backends

- `single_best`: inference-qwen-qwen3-14b-awq: 1
- `adaptive_sparse_graph`: inference-cyankiwi-granite-4-0-h-micro-awq-4bit: 1, inference-qwen-qwen3-14b-awq: 1
- `parallel_consensus`: inference-cyankiwi-granite-4-1-3b-awq-int4: 1, llama-cpp-deploy-jetson-16g-6-hunyuan-7b-instruct-q5km: 1, llama-cpp-deploy-pc-3090-qwen3-8b-bf16: 1

## Routing Mix

- `single_best`: route.once: 1
- `adaptive_sparse_graph`: auto.rank_fuse: 1
- `parallel_consensus`: response.parallel: 1
