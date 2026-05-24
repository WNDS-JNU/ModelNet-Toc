#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

python3 scripts/sync_modelnet_litellm.py
python3 scripts/sync_modelnet_lobehub.py
python3 scripts/sync_opencompass_leaderboard.py
docker compose up -d --build --force-recreate modelnet-router litellm
docker compose up -d --build --scale "lobe=${LOBE_REPLICAS:-2}" lobe toc-lb
docker compose ps modelnet-router litellm lobe toc-lb
