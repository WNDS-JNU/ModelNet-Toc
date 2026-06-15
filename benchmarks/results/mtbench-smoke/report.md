# ModelNet Auto MT-Bench Benchmark

- Generated at: `2026-06-09T14:09:44+08:00`
- Dataset: MT-Bench, 3 questions
- Judge: `inference-qwen-qwen3-5-35b-a3b-gptq-int4`

## Pairwise Results

| Baseline | Questions | Avg score | 95% CI | Win/Tie/Loss | Criterion |
| --- | ---: | ---: | --- | --- | --- |
| `single_best` | 3 | 0.500 | [0.500, 0.500] | 0/3/0 | not met |
| `parallel_consensus` | 3 | 0.500 | [0.500, 0.500] | 0/3/0 | not met |

## Routing Mix

- `modelnet_auto`: auto.role_graph: 5, route.once: 1
- `single_best`: route.once: 6
- `parallel_consensus`: response.parallel: 6

## Latency

- `modelnet_auto`: p50=67708.0 ms, p95=69060.0 ms, mean=67301.0 ms
- `parallel_consensus`: p50=67042.0 ms, p95=79470.0 ms, mean=67820.3 ms
- `single_best`: p50=8018.0 ms, p95=11777.0 ms, mean=7292.0 ms

## Category Breakdown

### modelnet_auto vs single_best
- `writing`: 0.500

### modelnet_auto vs parallel_consensus
- `writing`: 0.500
