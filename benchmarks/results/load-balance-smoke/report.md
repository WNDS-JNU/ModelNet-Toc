# ModelNet Load-Balancing Benchmark

- Generated at: `2026-06-10T19:28:32+08:00`
- Workload: `synthetic`
- Requests: `1`
- Scheduled duration: `0.00s`
- SLO: `120000 ms`

## Performance

| System | OK/Total | p50 ms | p95 ms | p99 ms | e2e p95 ms | queue p95 ms | SLO violation | req/min | out tok/s | peak in-flight |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `modelnet_auto` | 1/1 | 33584.00 | 33584.00 | 33584.00 | 33585.00 | 1.00 | 0.000 | 1.79 | 19.80 | 1 |
| `single_best` | 1/1 | 2417.00 | 2417.00 | 2417.00 | 2417.00 | 0.00 | 0.000 | 24.81 | 14.47 | 1 |

## Backend Load Balance

| System | Used backends | Backend selections | Max share | Gini | CV | Jain fairness |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `modelnet_auto` | 3 | 3 | 0.333 | 0.833 | 2.236 | 0.167 |
| `single_best` | 1 | 1 | 1.000 | 0.944 | 4.123 | 0.056 |

## Top Selected Backends

- `modelnet_auto`: inference-cyankiwi-granite-4-0-h-micro-awq-4bit: 1, llama-cpp-deploy-jetson-16g-6-hunyuan-7b-instruct-q5km: 1, llama-cpp-deploy-pc-3090-qwen3-8b-bf16: 1
- `single_best`: llama-cpp-deploy-jetson-64g-1-qwen3-4b-instruct-2507-q4km: 1

## Routing Mix

- `modelnet_auto`: auto.role_graph: 1
- `single_best`: route.once: 1
