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

2. Recreate only the dev Router with the registry overlay:

   ```bash
   docker compose --env-file .env --env-file .env.dev \
     -f docker-compose.dev.yml \
     -f docker-compose.registry-dev.yml \
     up -d --no-build --pull never --no-deps --force-recreate modelnet-router
   ```

3. Verify that dev Router reports the registry path, version, and manifest
   checksum from `/etc/modelnet/registry/current` through `/healthz`.

## Capability Registry Runtime

- The dev registry bundle uses `capability-registry.yaml` as the single
  registry source. The file has schema `modelnet.capabilities.v1`, capability
  groups, and an embedded `models` inventory formerly carried by `model_net.yaml`.
- Dev Router points `MODELNET_REGISTRY_PATH` at
  `/etc/modelnet/registry/current/capability-registry.yaml`.
- Published bundles contain only `capability-registry.yaml`, `version.json`,
  and `checksums.sha256`.
- Dev ModelNet app/TOC should use the `.env.modelnet` generated from the same capability
  registry; router-direct dev overlay points `OPENAI_PROXY_URL` at Router.

## Production/Dify Hold

- Do not edit `docker-compose.yml` until dev verification is accepted.
- Do not edit `/home/duxianghe/dify/docker/docker-compose.yaml` in this phase.
- Do not edit production or Dify `.env` files in this phase.
- Do not restart production `modelnet-router` or Dify
  `api`/`worker`/`worker_beat` containers in this phase.

## Future Production Direction

- Mount the registry root directory, not a single YAML file.
- Point Router at `/etc/modelnet/registry/current/capability-registry.yaml`.
- Keep OpenAI-compatible model access on Router; do not reintroduce an outer project proxy.
- Prefer Dify calling ModelNet Gateway with `MODELNET_GATEWAY_ENABLED=true`.
- If Dify must keep local registry compatibility, mount the same registry root
  and consume `/etc/modelnet/registry/current/capability-registry.yaml`.
