# ModelNet ToC

Self-hosted ModelNet ToC deployment for ModelNet, with:

- ModelNet as the consumer-facing UI
- HAProxy entry load balancing on `:3081`
- A login-protected ModelNet capability leaderboard embedded at `/leaderboard`
- PostgreSQL, Redis, RustFS/S3, and Searxng for the full ModelNet stack
- A ModelNet-owned OpenAI-compatible gateway: ModelNet -> `modelnet-router` -> registry-backed K8S backend endpoints

## Runtime Layout

- Public ToC entry: `http://<server>:3081/`
- Embedded leaderboard: `http://<server>:3081/leaderboard`
- HAProxy service: `toc-lb`
- ModelNet app service: `modelnet-app`, pinned to a single container
- Leaderboard API: `GET /api/modelnet/leaderboard`, served by the custom ModelNet image
- Model gateway service: `modelnet-router`, owned by this compose project
- The public automatic networking model is `modelnet-auto`; Router discovers concrete backend model IDs from the ModelNet registry.

The stack builds the custom ModelNet image from the vendored source tree at `./modelnet-app` by default.
Override it with `MODELNET_APP_SRC=/path/to/modelnet-app-source` only when testing another checkout.

## Bootstrap

Create production env files from the examples:

```bash
cp .env.example .env
cp .env.modelnet.example .env.modelnet
```

Fill `.env` with generated secrets and the server IP. Do not commit `.env` or `.env.modelnet`.

Generate the ModelNet model list from the Dify registry:

```bash
python3 scripts/sync_modelnet_app.py
python3 scripts/sync_opencompass_leaderboard.py
```

Start the stack:

```bash
docker compose build modelnet-app
docker compose up -d --scale modelnet-app=1
```

`docker-compose.yml` tags the custom image as `modelnet/modelnet-toc:2.2.0-modelnet` by
default. Override the tag with `MODELNET_APP_IMAGE=...` if you publish it to a registry.

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

This regenerates `.env.modelnet` and `leaderboard/data/opencompass-leaderboard.json`,
then rebuilds and recreates `modelnet-router` and the single ModelNet app container behind HAProxy.

## Verify

```bash
docker compose ps
curl -s -o /tmp/modelnet-health.json -w "%{http_code}\n" http://127.0.0.1:3092/healthz
curl -s -L -o /tmp/modelnet.html -w "%{http_code}\n" http://<server>:3081/
curl -s -L -o /tmp/leaderboard.html -w "%{http_code}\n" http://<server>:3081/leaderboard
curl -s -o /tmp/leaderboard.json -w "%{http_code}\n" http://<server>:3081/api/modelnet/leaderboard
curl -s -o /tmp/rustfs-health.txt -w "%{http_code}\n" http://<server>:9100/health
```

Expected:

- `toc-lb` is running
- one `modelnet-app` container is healthy
- `modelnet-router` is healthy
- ToC entry returns `200`
- leaderboard HTML and JSON return `200` for a logged-in session
- RustFS health returns `200`
