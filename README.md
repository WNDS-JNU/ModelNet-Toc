# ModelNet ToC

Self-hosted LobeHub ToC deployment for ModelNet, with:

- LobeHub as the consumer-facing UI
- HAProxy entry load balancing on `:3081`
- A public ModelNet capability leaderboard at `/leaderboard`
- PostgreSQL, Redis, RustFS/S3, and Searxng for the full LobeHub stack
- ModelNet access through the existing LiteLLM OpenAI-compatible gateway

## Runtime Layout

- Public ToC entry: `http://<server>:3081/`
- Public leaderboard: `http://<server>:3081/leaderboard`
- HAProxy service: `toc-lb`
- LobeHub replicas: `lobe`, scaled by `LOBE_REPLICAS`
- Leaderboard service: `leaderboard`, backed by OpenCompass data
- Model gateway dependency: Docker network `librechat-toc_default`, service `modelnet-litellm`

## Bootstrap

Create production env files from the examples:

```bash
cp .env.example .env
cp .env.modelnet.example .env.modelnet
```

Fill `.env` with generated secrets and the server IP. Do not commit `.env` or `.env.modelnet`.

Generate the ModelNet model list from the Dify registry:

```bash
python3 scripts/sync_modelnet_lobehub.py
python3 scripts/sync_opencompass_leaderboard.py
```

Start the stack:

```bash
docker compose up -d --scale lobe=${LOBE_REPLICAS:-2}
```

## Reload ModelNet Models

After Dify refreshes `api/configs/model_net.yaml`, run:

```bash
scripts/reload_modelnet.sh
```

This regenerates `.env.modelnet`, recreates the LobeHub replicas, and keeps HAProxy in front.
It also refreshes `leaderboard/public/leaderboard/data/opencompass-leaderboard.json`
from OpenCompass public leaderboard data and marks models currently available in ModelNet.

## Verify

```bash
docker compose ps
curl -s -L -o /tmp/lobehub.html -w "%{http_code}\n" http://<server>:3081/
curl -s -L -o /tmp/leaderboard.html -w "%{http_code}\n" http://<server>:3081/leaderboard
curl -s -o /tmp/leaderboard.json -w "%{http_code}\n" http://<server>:3081/leaderboard/data/opencompass-leaderboard.json
curl -s -o /tmp/rustfs-health.txt -w "%{http_code}\n" http://<server>:9100/health
```

Expected:

- `toc-lb` is running
- two `lobe` replicas are healthy
- ToC entry returns `200`
- leaderboard HTML and JSON return `200`
- RustFS health returns `200`
