#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

python3 scripts/sync_modelnet_app.py
python3 scripts/sync_opencompass_leaderboard.py
docker compose up -d --build --force-recreate modelnet-router
docker compose up -d --build --scale modelnet-app=1 modelnet-app toc-lb
docker compose ps modelnet-router modelnet-app toc-lb
