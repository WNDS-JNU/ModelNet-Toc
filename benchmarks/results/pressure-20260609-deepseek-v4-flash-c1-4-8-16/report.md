# ModelNet High-Load Pressure Benchmark

- Generated at: `2026-06-10T15:03:37+08:00`
- Questions: `[81, 86, 91, 96, 101, 106, 111, 116, 121, 126, 131, 136, 141, 146, 151, 156]`
- Judge: `deepseek:deepseek-v4-flash`

## Performance

### Concurrency 1
| System | OK/Total | p50 ms | p95 ms | p99 ms | max ms | throughput/min |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `modelnet_auto` | 16/16 | 81511.0 | 132396.0 | 132396.0 | 132396.0 | 7.25 |
| `adaptive_sparse_graph` | 16/16 | 58347.0 | 108928.0 | 108928.0 | 108928.0 | 8.81 |
| `single_best` | 16/16 | 42923.0 | 79850.0 | 79850.0 | 79850.0 | 12.02 |
| `fixed_qwen35b` | 16/16 | 51021.0 | 51337.0 | 51337.0 | 51337.0 | 18.70 |
| `parallel_consensus` | 16/16 | 89671.0 | 152101.0 | 152101.0 | 152101.0 | 6.31 |

### Concurrency 4
| System | OK/Total | p50 ms | p95 ms | p99 ms | max ms | throughput/min |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `modelnet_auto` | 16/16 | 80871.0 | 324480.0 | 324480.0 | 324480.0 | 2.96 |
| `adaptive_sparse_graph` | 16/16 | 35332.0 | 135806.0 | 135806.0 | 135806.0 | 7.07 |
| `single_best` | 16/16 | 15827.0 | 96108.0 | 96108.0 | 96108.0 | 9.99 |
| `fixed_qwen35b` | 16/16 | 71752.0 | 72122.0 | 72122.0 | 72122.0 | 13.31 |
| `parallel_consensus` | 16/16 | 79214.0 | 190200.0 | 190200.0 | 190200.0 | 5.05 |

### Concurrency 8
| System | OK/Total | p50 ms | p95 ms | p99 ms | max ms | throughput/min |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `modelnet_auto` | 16/16 | 93788.0 | 217625.0 | 217625.0 | 217625.0 | 4.41 |
| `adaptive_sparse_graph` | 16/16 | 30613.0 | 99465.0 | 99465.0 | 99465.0 | 9.65 |
| `single_best` | 16/16 | 14983.0 | 91927.0 | 91927.0 | 91927.0 | 10.44 |
| `fixed_qwen35b` | 16/16 | 90074.0 | 90981.0 | 90981.0 | 90981.0 | 10.55 |
| `parallel_consensus` | 16/16 | 96428.0 | 313636.0 | 313636.0 | 313636.0 | 3.06 |

### Concurrency 16
| System | OK/Total | p50 ms | p95 ms | p99 ms | max ms | throughput/min |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `modelnet_auto` | 16/16 | 87984.0 | 276135.0 | 276135.0 | 276135.0 | 3.48 |
| `adaptive_sparse_graph` | 16/16 | 21910.0 | 222014.0 | 222014.0 | 222014.0 | 4.32 |
| `single_best` | 16/16 | 17117.0 | 91047.0 | 91047.0 | 91047.0 | 10.54 |
| `fixed_qwen35b` | 16/16 | 128688.0 | 128852.0 | 128852.0 | 128852.0 | 7.45 |
| `parallel_consensus` | 16/16 | 113059.0 | 230588.0 | 230588.0 | 230588.0 | 4.16 |

## Quality: modelnet_auto Pairwise Score

### Concurrency 1
| Baseline | Questions | Avg | 95% CI | Win/Tie/Loss |
| --- | ---: | ---: | --- | --- |
| `adaptive_sparse_graph` | 8 | 0.562 | [0.500, 0.688] | 1/7/0 |
| `single_best` | 8 | 0.438 | [0.312, 0.500] | 0/7/1 |
| `fixed_qwen35b` | 8 | 0.500 | [0.500, 0.500] | 0/8/0 |
| `parallel_consensus` | 8 | 0.469 | [0.375, 0.562] | 1/5/2 |

### Concurrency 4
| Baseline | Questions | Avg | 95% CI | Win/Tie/Loss |
| --- | ---: | ---: | --- | --- |
| `adaptive_sparse_graph` | 8 | 0.469 | [0.406, 0.500] | 0/7/1 |
| `single_best` | 8 | 0.500 | [0.500, 0.500] | 0/8/0 |
| `fixed_qwen35b` | 8 | 0.531 | [0.500, 0.594] | 1/7/0 |
| `parallel_consensus` | 8 | 0.562 | [0.500, 0.656] | 2/6/0 |

### Concurrency 8
| Baseline | Questions | Avg | 95% CI | Win/Tie/Loss |
| --- | ---: | ---: | --- | --- |
| `adaptive_sparse_graph` | 8 | 0.469 | [0.344, 0.562] | 1/5/2 |
| `single_best` | 8 | 0.438 | [0.344, 0.500] | 0/6/2 |
| `fixed_qwen35b` | 8 | 0.438 | [0.312, 0.500] | 0/7/1 |
| `parallel_consensus` | 8 | 0.438 | [0.344, 0.500] | 0/6/2 |

### Concurrency 16
| Baseline | Questions | Avg | 95% CI | Win/Tie/Loss |
| --- | ---: | ---: | --- | --- |
| `adaptive_sparse_graph` | 8 | 0.562 | [0.500, 0.625] | 2/6/0 |
| `single_best` | 8 | 0.375 | [0.219, 0.531] | 1/4/3 |
| `fixed_qwen35b` | 8 | 0.531 | [0.500, 0.594] | 1/7/0 |
| `parallel_consensus` | 8 | 0.531 | [0.500, 0.594] | 1/7/0 |

## Routing Mix

- `modelnet_auto`: auto.role_graph: 84, route.once: 44
- `adaptive_sparse_graph`: auto.cascade_verify: 83, route.once: 45
- `single_best`: route.once: 128
- `fixed_qwen35b`: fixed.direct: 128
- `parallel_consensus`: response.parallel: 127, route.once: 1
