# ModelNet ToC

Self-hosted LobeHub ToC deployment for ModelNet, with:

- LobeHub as the consumer-facing UI
- HAProxy entry load balancing on `:3081`
- A login-protected ModelNet capability leaderboard embedded at `/leaderboard`
- PostgreSQL, Redis, RustFS/S3, and Searxng for the full LobeHub stack
- A ModelNet-owned OpenAI-compatible gateway: LobeHub -> LiteLLM -> modelnet-router -> K8S model backends

## Runtime Layout

- Public ToC entry: `http://<server>:3081/`
- Embedded leaderboard: `http://<server>:3081/leaderboard`
- HAProxy service: `toc-lb`
- LobeHub replicas: `lobe`, scaled by `LOBE_REPLICAS`
- Leaderboard API: `GET /api/modelnet/leaderboard`, served by the custom LobeHub image
- Model gateway services: `modelnet-litellm` and `modelnet-router`, owned by this compose project

The stack builds the custom LobeHub image from the vendored source tree at `./lobehub` by default.
Override it with `LOBEHUB_TOC_SRC=/path/to/lobehub-source` only when testing another checkout.

## Bootstrap

Create production env files from the examples:

```bash
cp .env.example .env
cp .env.modelnet.example .env.modelnet
```

Fill `.env` with generated secrets and the server IP. Do not commit `.env` or `.env.modelnet`.

Generate the ModelNet model list from the Dify registry:

```bash
python3 scripts/sync_modelnet_litellm.py
python3 scripts/sync_modelnet_lobehub.py
python3 scripts/sync_opencompass_leaderboard.py
```

Start the stack:

```bash
docker compose build lobe
docker compose up -d --scale lobe=${LOBE_REPLICAS:-2}
```

`docker-compose.yml` tags the custom image as `modelnet/lobehub-toc:2.2.0-modelnet` by
default. Override the tag with `LOBE_IMAGE=...` if you publish it to a registry.

## Local Benchmarks

OpenCompass data is generated at `leaderboard/data/opencompass-leaderboard.json`.
ModelNet self-test results can be written to `leaderboard/data/local-benchmarks.json`:

```json
{
  "generated_at": "2026-05-24T00:00:00+08:00",
  "source": {
    "name": {
      "zh-CN": "ModelNet 自测",
      "en-US": "ModelNet Benchmark"
    },
    "url": "",
    "version": "v1"
  },
  "items": [
    {
      "model": "Qwen3-8B-BF16",
      "aliases": ["llama-cpp-deploy-jetson-64g-3-qwen3-8b-bf16"],
      "rank": 1,
      "scores": [
        { "key": "Average", "label": { "zh-CN": "综合", "en-US": "Average" }, "value": 72.3 }
      ],
      "dimensions": [
        {
          "key": "Latency",
          "label": { "zh-CN": "延迟", "en-US": "Latency" },
          "average": 86.0,
          "scores": []
        }
      ],
      "metadata": {
        "hardware": "Jetson 64G",
        "dataset": "custom-v1"
      }
    }
  ]
}
```

Benchmark drivers live under `benchmarks/`:

- `run_mtbench_modelnet.py`: full MT-Bench quality comparison.
- `run_pressure_modelnet.py`: sampled MT-Bench pressure test with fixed concurrency levels.
- `run_load_balancing_modelnet.py`: request-rate, bursty, or trace replay workload for routing and load-balance analysis.

Example load-balancing run:

```bash
python3 benchmarks/run_load_balancing_modelnet.py \
  --workload-source mtbench \
  --num-requests 40 \
  --request-rate 0.5 \
  --arrival-mode poisson \
  --max-client-concurrency 16 \
  --output-dir benchmarks/results/load-balance-mtbench-$(date +%Y%m%d-%H%M%S)
```

The load-balancing report includes p50/p95/p99 latency, queue delay, throughput, SLO violation rate,
selected backend counts, Gini/CV/Jain fairness, and ModelNet runner mix. See `benchmarks/README.md`
for synthetic and BurstGPT-style trace replay examples.

## Reload ModelNet Models

After Dify refreshes `api/configs/model_net.yaml`, run:

```bash
scripts/reload_modelnet.sh
```

This regenerates LiteLLM config, `.env.modelnet`, and `leaderboard/data/opencompass-leaderboard.json`,
then recreates `modelnet-router`, `modelnet-litellm`, and the LobeHub replicas behind HAProxy.

## Verify

```bash
docker compose ps
curl -s -o /tmp/modelnet-models.json -w "%{http_code}\n" http://127.0.0.1:3090/v1/models
curl -s -L -o /tmp/lobehub.html -w "%{http_code}\n" http://<server>:3081/
curl -s -L -o /tmp/leaderboard.html -w "%{http_code}\n" http://<server>:3081/leaderboard
curl -s -o /tmp/leaderboard.json -w "%{http_code}\n" http://<server>:3081/api/modelnet/leaderboard
curl -s -o /tmp/rustfs-health.txt -w "%{http_code}\n" http://<server>:9100/health
```

Expected:

- `toc-lb` is running
- two `lobe` replicas are healthy
- `modelnet-router` is healthy and `modelnet-litellm` is running
- ToC entry returns `200`
- leaderboard HTML and JSON return `200` for a logged-in session
- RustFS health returns `200`
