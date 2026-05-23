#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

python3 scripts/sync_modelnet_lobehub.py
docker compose up -d --force-recreate --scale "lobe=${LOBE_REPLICAS:-2}" lobe toc-lb
docker compose ps lobe toc-lb
