# ModelNet Auto MT-Bench Benchmark

- Generated at: `2026-06-09T14:13:39+08:00`
- Dataset: MT-Bench, 1 questions
- Judge: `inference-qwen-qwen3-5-35b-a3b-gptq-int4`

## Pairwise Results

| Baseline | Questions | Avg score | 95% CI | Win/Tie/Loss | Criterion |
| --- | ---: | ---: | --- | --- | --- |
| `single_best` | 1 | 0.500 | [0.500, 0.500] | 0/1/0 | not met |
| `parallel_consensus` | 1 | 0.500 | [0.500, 0.500] | 0/1/0 | not met |

## Routing Mix

- `modelnet_auto`: auto.role_graph: 1, route.once: 1
- `single_best`: route.once: 2
- `parallel_consensus`: response.parallel: 2

## Latency

- `modelnet_auto`: p50=39624.0 ms, p95=39624.0 ms, mean=39624.0 ms
- `parallel_consensus`: p50=52235.0 ms, p95=52235.0 ms, mean=52235.0 ms
- `single_best`: p50=12096.0 ms, p95=12096.0 ms, mean=12096.0 ms

## Category Breakdown

### modelnet_auto vs single_best
- `writing`: 0.500

### modelnet_auto vs parallel_consensus
- `writing`: 0.500
