# ModelNet ToC

Self-hosted LobeHub ToC deployment for ModelNet, with:

- LobeHub as the consumer-facing UI
- HAProxy entry load balancing on `:3081`
- PostgreSQL, Redis, RustFS/S3, and Searxng for the full LobeHub stack
- ModelNet access through the existing LiteLLM OpenAI-compatible gateway

## Runtime Layout

- Public ToC entry: `http://<server>:3081/`
- HAProxy service: `toc-lb`
- LobeHub replicas: `lobe`, scaled by `LOBE_REPLICAS`
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

## Verify

```bash
docker compose ps
curl -s -L -o /tmp/lobehub.html -w "%{http_code}\n" http://<server>:3081/
curl -s -o /tmp/rustfs-health.txt -w "%{http_code}\n" http://<server>:9100/health
```

Expected:

- `toc-lb` is running
- two `lobe` replicas are healthy
- ToC entry returns `200`
- RustFS health returns `200`
