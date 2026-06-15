# ModelNet High-Load Pressure Benchmark

- Generated at: `2026-06-09T17:17:16+08:00`
- Questions: `[81, 111]`
- Judge: `deepseek:deepseek-v4-flash`

## Performance

### Concurrency 2
| System | OK/Total | p50 ms | p95 ms | p99 ms | max ms | throughput/min |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `modelnet_auto` | 2/2 | 37394.0 | 37410.0 | 37410.0 | 37410.0 | 3.21 |
| `single_best` | 2/2 | 2251.0 | 14813.0 | 14813.0 | 14813.0 | 8.10 |
| `fixed_qwen35b` | 2/2 | 19812.0 | 19813.0 | 19813.0 | 19813.0 | 6.06 |
| `parallel_consensus` | 2/2 | 35112.0 | 43917.0 | 43917.0 | 43917.0 | 2.73 |

## Quality: modelnet_auto Pairwise Score

### Concurrency 2
| Baseline | Questions | Avg | 95% CI | Win/Tie/Loss |
| --- | ---: | ---: | --- | --- |
| `single_best` | 1 | 0.250 | [0.250, 0.250] | 0/0/1 |
| `fixed_qwen35b` | 1 | 0.500 | [0.500, 0.500] | 0/1/0 |
| `parallel_consensus` | 1 | 0.500 | [0.500, 0.500] | 0/1/0 |

## Routing Mix

- `modelnet_auto`: auto.role_graph: 2, route.once: 2
- `single_best`: route.once: 4
- `fixed_qwen35b`: fixed.direct: 4
- `parallel_consensus`: response.parallel: 4
