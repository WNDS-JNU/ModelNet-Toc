# ModelNet Auto MT-Bench Benchmark

- Generated at: `2026-06-10T14:31:29+08:00`
- Dataset: MT-Bench, 80 questions
- Judge: `inference-qwen-qwen3-5-35b-a3b-gptq-int4`

## Pairwise Results

| Baseline | Questions | Avg score | 95% CI | Win/Tie/Loss | Criterion |
| --- | ---: | ---: | --- | --- | --- |
| `adaptive_sparse_graph` | 80 | 0.603 | [0.516, 0.688] | 35/27/18 | met |
| `single_best` | 80 | 0.497 | [0.425, 0.569] | 20/40/20 | not met |
| `fixed_qwen35b` | 80 | 0.550 | [0.456, 0.644] | 33/22/25 | not met |
| `parallel_consensus` | 80 | 0.706 | [0.619, 0.791] | 49/15/16 | met |

## Routing Mix

- `single_best`: route.once: 160
- `modelnet_auto`: auto.role_graph: 101, route.once: 59
- `parallel_consensus`: response.parallel: 160
- `fixed_qwen35b`: unknown: 160
- `adaptive_sparse_graph`: auto.cascade_verify: 103, route.once: 57

## Latency

- `adaptive_sparse_graph`: p50=44184.0 ms, p95=96223.0 ms, mean=47221.5 ms
- `fixed_qwen35b`: p50=69436.0 ms, p95=80922.0 ms, mean=63932.8 ms
- `modelnet_auto`: p50=78099.0 ms, p95=176109.0 ms, mean=86892.3 ms
- `parallel_consensus`: p50=79397.0 ms, p95=171958.0 ms, mean=86989.0 ms
- `single_best`: p50=24077.0 ms, p95=72550.0 ms, mean=31600.0 ms

## Category Breakdown

### modelnet_auto vs adaptive_sparse_graph
- `coding`: 0.450
- `extraction`: 0.675
- `humanities`: 0.400
- `math`: 0.600
- `reasoning`: 0.500
- `roleplay`: 0.700
- `stem`: 0.650
- `writing`: 0.850

### modelnet_auto vs single_best
- `coding`: 0.500
- `extraction`: 0.700
- `humanities`: 0.375
- `math`: 0.350
- `reasoning`: 0.450
- `roleplay`: 0.500
- `stem`: 0.400
- `writing`: 0.700

### modelnet_auto vs fixed_qwen35b
- `coding`: 0.300
- `extraction`: 0.600
- `humanities`: 0.750
- `math`: 0.600
- `reasoning`: 0.150
- `roleplay`: 0.700
- `stem`: 0.450
- `writing`: 0.850

### modelnet_auto vs parallel_consensus
- `coding`: 0.700
- `extraction`: 0.675
- `humanities`: 0.550
- `math`: 0.700
- `reasoning`: 0.750
- `roleplay`: 0.950
- `stem`: 0.525
- `writing`: 0.800
