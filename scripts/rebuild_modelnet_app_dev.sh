#!/usr/bin/env bash
set -euo pipefail

EXPECTED_ROOT='/home/duxianghe/ModelNet-toc'
EXPECTED_SOURCE="$EXPECTED_ROOT/modelnet-app"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

if [[ "$REPO_ROOT" != "$EXPECTED_ROOT" ]]; then
  echo "Refusing to run outside $EXPECTED_ROOT (resolved $REPO_ROOT)" >&2
  exit 1
fi

if [[ -n "${MODELNET_APP_SRC+x}" && "$MODELNET_APP_SRC" != "$EXPECTED_SOURCE" ]]; then
  echo "MODELNET_APP_SRC must equal $EXPECTED_SOURCE" >&2
  exit 1
fi
export MODELNET_APP_SRC="$EXPECTED_SOURCE"

for required_file in "$EXPECTED_ROOT/.env" "$EXPECTED_ROOT/.env.dev" "$EXPECTED_ROOT/docker-compose.dev.yml"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Required file does not exist: $required_file" >&2
    exit 1
  fi
done
if [[ ! -d "$EXPECTED_SOURCE" ]]; then
  echo "Required source directory does not exist: $EXPECTED_SOURCE" >&2
  exit 1
fi

COMPOSE=(
  docker compose
  --project-name modelnet-toc-dev
  --env-file "$EXPECTED_ROOT/.env"
  --env-file "$EXPECTED_ROOT/.env.dev"
  -f "$EXPECTED_ROOT/docker-compose.dev.yml"
)

CONFIG_JSON="$("${COMPOSE[@]}" config --format json)"
RESOLVED="$(printf '%s' "$CONFIG_JSON" | python3 -c '
import json
import sys

expected_project = "modelnet-toc-dev"
expected_context = "/home/duxianghe/ModelNet-toc/modelnet-app"
config = json.load(sys.stdin)
service = config.get("services", {}).get("modelnet-app", {})
project = config.get("name")
context = service.get("build", {}).get("context")
image = service.get("image")

if project != expected_project:
    raise SystemExit(f"resolved Compose project must be {expected_project}, got {project!r}")
if context != expected_context:
    raise SystemExit(f"resolved modelnet-app build context must be {expected_context}, got {context!r}")
if not image:
    raise SystemExit("resolved modelnet-app image must be non-empty")

print(project)
print(context)
print(image)
')"
mapfile -t RESOLVED_FIELDS <<< "$RESOLVED"
PROJECT_NAME="${RESOLVED_FIELDS[0]}"
BUILD_CONTEXT="${RESOLVED_FIELDS[1]}"
IMAGE_REF="${RESOLVED_FIELDS[2]}"

echo "Resolved project: $PROJECT_NAME"
echo "Resolved context: $BUILD_CONTEXT"
echo "Resolved image: $IMAGE_REF"

"${COMPOSE[@]}" build modelnet-app

IMAGE_ID="$(docker image inspect "$IMAGE_REF" --format '{{.Id}}')"
if [[ -z "$IMAGE_ID" ]]; then
  echo "Built image has no image ID: $IMAGE_REF" >&2
  exit 1
fi
echo "Post-build image ID: $IMAGE_ID"
