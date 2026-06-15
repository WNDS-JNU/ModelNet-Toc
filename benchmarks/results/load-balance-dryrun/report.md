# ModelNet Load-Balancing Benchmark

- Generated at: `2026-06-10T19:27:24+08:00`
- Workload: `synthetic`
- Requests: `5`
- Scheduled duration: `0.55s`
- SLO: `120000 ms`

## Performance

| System | OK/Total | p50 ms | p95 ms | p99 ms | e2e p95 ms | queue p95 ms | SLO violation | req/min | out tok/s | peak in-flight |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `modelnet_auto` | 0/0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | 0 |
| `single_best` | 0/0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | 0 |

## Backend Load Balance

| System | Used backends | Backend selections | Max share | Gini | CV | Jain fairness |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `modelnet_auto` | 0 | 0 | n/a | n/a | n/a | n/a |
| `single_best` | 0 | 0 | n/a | n/a | n/a | n/a |

## Top Selected Backends

- `modelnet_auto`: n/a
- `single_best`: n/a

## Routing Mix
