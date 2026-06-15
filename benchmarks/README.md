# ModelNet Benchmarks

This directory contains local benchmark drivers for the ModelNet OpenAI-compatible gateway.

For the full benchmark design, workload model, output schema, and metric formulas, see
[`BENCHMARK_DESIGN.md`](BENCHMARK_DESIGN.md).

## Quality Benchmarks

Run the full MT-Bench quality comparison:

```bash
python3 benchmarks/run_mtbench_modelnet.py \
  --output-dir benchmarks/results/mtbench-full-$(date +%Y%m%d-%H%M%S)
```

Run the sampled high-load pressure benchmark with pairwise judging:

```bash
python3 benchmarks/run_pressure_modelnet.py \
  --concurrency-levels 1,4,8,16 \
  --output-dir benchmarks/results/pressure-$(date +%Y%m%d-%H%M%S)
```

## Load-Balancing Benchmark

Use `run_load_balancing_modelnet.py` when the question is routing behavior rather than answer quality. It replays the same workload against multiple ModelNet strategies and records latency, client queueing, throughput, SLO violations, selected backend counts, Gini/CV/Jain fairness, and runner mix.

MT-Bench prompt workload with Poisson arrivals:

```bash
python3 benchmarks/run_load_balancing_modelnet.py \
  --workload-source mtbench \
  --num-requests 40 \
  --request-rate 0.5 \
  --arrival-mode poisson \
  --max-client-concurrency 16 \
  --systems modelnet_auto,adaptive_sparse_graph,single_best,parallel_consensus \
  --output-dir benchmarks/results/load-balance-mtbench-$(date +%Y%m%d-%H%M%S)
```

Synthetic bursty workload:

```bash
python3 benchmarks/run_load_balancing_modelnet.py \
  --workload-source synthetic \
  --num-requests 80 \
  --request-rate 1.0 \
  --arrival-mode bursty \
  --burst-size 8 \
  --burst-gap-multiplier 8 \
  --synthetic-input-tokens 512 \
  --synthetic-output-tokens 192 \
  --output-dir benchmarks/results/load-balance-bursty-$(date +%Y%m%d-%H%M%S)
```

Trace replay workload, compatible with BurstGPT-style CSV files and mooncake-style JSONL files:

```bash
python3 benchmarks/run_load_balancing_modelnet.py \
  --workload-source trace \
  --trace-file /path/to/BurstGPT_1.csv \
  --trace-time-scale 0.001 \
  --num-requests 200 \
  --max-client-concurrency 32 \
  --output-dir benchmarks/results/load-balance-burstgpt-$(date +%Y%m%d-%H%M%S)
```

The script writes:

- `workload.jsonl`: normalized workload schedule
- `answers.jsonl`: one record per request and system
- `summary.json`: machine-readable metrics
- `report.md`: human-readable performance and load-balance report
- `MANIFEST.sha256`: archive checksums

Use `--dry-run` to validate workload generation without sending requests to the gateway.

## Useful Metrics

- `latency_ms`: gateway request latency after the client worker starts the request
- `e2e_ms`: scheduled arrival to completion, including client-side queueing
- `queue_delay_ms`: client backlog caused by `--max-client-concurrency`
- `slo_violation_rate`: fraction of successful requests above `--slo-ms`
- `backend_load.gini`: higher means more skewed backend selection
- `backend_load.jain_fairness`: closer to 1 means more even backend selection
- `runner_counts`: how often each ModelNet runner was used
