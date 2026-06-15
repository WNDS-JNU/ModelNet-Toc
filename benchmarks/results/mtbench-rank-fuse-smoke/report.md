# ModelNet Auto MT-Bench Benchmark

- Generated at: `2026-06-10T19:51:48+08:00`
- Dataset: MT-Bench, 8 questions
- Judge: `inference-qwen-qwen3-5-35b-a3b-gptq-int4`

## Pairwise Results

| Baseline | Questions | Avg score | 95% CI | Win/Tie/Loss | Criterion |
| --- | ---: | ---: | --- | --- | --- |
| `adaptive_sparse_graph` | 8 | 0.500 | [0.250, 0.750] | 2/4/2 | not met |
| `single_best` | 8 | 0.594 | [0.312, 0.844] | 4/2/2 | not met |
| `fixed_qwen35b` | 8 | 0.750 | [0.500, 1.000] | 5/2/1 | not met |
| `parallel_consensus` | 8 | 0.656 | [0.438, 0.875] | 4/3/1 | not met |

## Direct Pairwise Results

| Target vs Comparison | Questions | Avg score | 95% CI | Win/Tie/Loss | Criterion |
| --- | ---: | ---: | --- | --- | --- |
| `adaptive_sparse_graph_vs_single_best` | 8 | 0.750 | [0.500, 0.938] | 5/2/1 | not met |

## Routing Mix

- `adaptive_sparse_graph`: auto.rank_fuse: 9, route.once: 7
- `single_best`: route.once: 16
- `fixed_qwen35b`: unknown: 16
- `parallel_consensus`: response.parallel: 16
- `modelnet_auto`: auto.role_graph: 16

## Latency

- `adaptive_sparse_graph`: p50=27892.0 ms, p95=77667.0 ms, mean=36241.6 ms
- `fixed_qwen35b`: p50=25931.0 ms, p95=26093.0 ms, mean=24336.6 ms
- `modelnet_auto`: p50=89648.0 ms, p95=130986.0 ms, mean=96804.6 ms
- `parallel_consensus`: p50=36309.0 ms, p95=80777.0 ms, mean=47392.9 ms
- `single_best`: p50=4653.0 ms, p95=29768.0 ms, mean=10429.5 ms

## Category Breakdown

### modelnet_auto vs adaptive_sparse_graph
- `math`: 0.750
- `reasoning`: 0.250
- `roleplay`: 0.250
- `writing`: 0.750

### modelnet_auto vs single_best
- `math`: 1.000
- `reasoning`: 0.250
- `roleplay`: 0.500
- `writing`: 0.625

### modelnet_auto vs fixed_qwen35b
- `math`: 1.000
- `reasoning`: 0.500
- `roleplay`: 0.500
- `writing`: 1.000

### modelnet_auto vs parallel_consensus
- `math`: 0.500
- `reasoning`: 0.875
- `roleplay`: 0.250
- `writing`: 1.000
