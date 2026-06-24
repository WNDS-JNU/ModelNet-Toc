# ModelNet Versioned Registry Runbook

This runbook describes the promotion path after the independent registry source and dev registry bundle flow are
verified. Do not use it as implicit approval to change production or Dify live
services.

## Dev Flow

1. Publish a dev bundle:

   ```bash
   python3 scripts/publish_modelnet_registry.py \
     --source /home/duxianghe/modelnet-runtime/registry-source/capability-registry.yaml \
     --root /home/duxianghe/modelnet-runtime/registry-dev
   ```

2. Start the dev stack with the registry overlay:

   ```bash
   docker compose --env-file .env --env-file .env.dev \
     -f docker-compose.dev.yml \
     -f docker-compose.registry-dev.yml \
     up -d --build --no-deps modelnet-router litellm lobe toc-lb
   ```

3. Verify that dev Router and LiteLLM read from
   `/etc/modelnet/registry/current`.

## Capability Registry Runtime

- The dev registry bundle uses `capability-registry.yaml` as the single
  registry source. The file has schema `modelnet.capabilities.v1`, capability
  groups, and an embedded `models` inventory formerly carried by `model_net.yaml`.
- Dev Router points `MODELNET_REGISTRY_PATH` at
  `/etc/modelnet/registry/current/capability-registry.yaml`.
- Dev LiteLLM uses `/etc/modelnet/registry/current/litellm/modelnet-config.yaml`,
  generated from the same capability registry.
- Dev Lobe/TOC should use the `.env.modelnet` generated from the same capability
  registry; router-direct dev overlay points `OPENAI_PROXY_URL` at Router.

## Production/Dify Hold

- Do not edit `docker-compose.yml` until dev verification is accepted.
- Do not edit `/home/duxianghe/dify/docker/docker-compose.yaml` in this phase.
- Do not edit production or Dify `.env` files in this phase.
- Do not restart production `modelnet-router`, `modelnet-litellm`, or Dify
  `api`/`worker`/`worker_beat` containers in this phase.

## Future Production Direction

- Mount the registry root directory, not a single YAML file.
- Point Router at `/etc/modelnet/registry/current/capability-registry.yaml`.
- Point LiteLLM at `/etc/modelnet/registry/current/litellm/modelnet-config.yaml`.
- Prefer Dify calling ModelNet Gateway with `MODELNET_GATEWAY_ENABLED=true`.
- If Dify must keep local registry compatibility, mount the same registry root
  and consume `/etc/modelnet/registry/current/capability-registry.yaml`.
