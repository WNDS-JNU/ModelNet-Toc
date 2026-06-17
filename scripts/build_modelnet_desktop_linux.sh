#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOBEHUB_DIR="${ROOT_DIR}/lobehub"
NODE_DIR="${MODELNET_NODE_DIR:-${HOME}/.local/modelnet-node22}"
MODELNET_DESKTOP_SERVER_URL="${MODELNET_DESKTOP_SERVER_URL:-http://123.56.135.150}"
NODE_BASE_URL="${MODELNET_NODE_BASE_URL:-https://nodejs.org/dist/latest-v22.x}"

ensure_node22() {
  local arch node_arch work_dir tar_name current major

  if [ -x "${NODE_DIR}/bin/node" ]; then
    current="$("${NODE_DIR}/bin/node" -p "process.versions.node")"
    major="${current%%.*}"
    if [ "${major}" -ge 22 ]; then
      return
    fi
  fi

  arch="$(uname -m)"
  case "${arch}" in
    x86_64) node_arch="x64" ;;
    aarch64 | arm64) node_arch="arm64" ;;
    *)
      echo "Unsupported architecture: ${arch}" >&2
      exit 2
      ;;
  esac

  work_dir="/tmp/modelnet-node22-install-$(date +%Y%m%d%H%M%S)"
  mkdir -p "${work_dir}"

  curl -fsSL "${NODE_BASE_URL}/SHASUMS256.txt" -o "${work_dir}/SHASUMS256.txt"
  tar_name="$(awk "/linux-${node_arch}\\.tar\\.xz\$/ {print \$2; exit}" "${work_dir}/SHASUMS256.txt")"
  if [ -z "${tar_name}" ]; then
    echo "Could not find linux-${node_arch} Node tarball in SHASUMS256.txt" >&2
    exit 3
  fi

  curl -fL "${NODE_BASE_URL}/${tar_name}" -o "${work_dir}/${tar_name}"
  (cd "${work_dir}" && grep "  ${tar_name}\$" SHASUMS256.txt | sha256sum -c -)

  mkdir -p "${NODE_DIR}"
  tar -xJf "${work_dir}/${tar_name}" -C "${NODE_DIR}" --strip-components=1
}

ensure_pnpm() {
  export PATH="${NODE_DIR}/bin:${PATH}"
  corepack prepare pnpm@10.33.0 --activate
  corepack enable --install-directory "${NODE_DIR}/bin"
}

install_dependencies() {
  export PATH="${NODE_DIR}/bin:${PATH}"
  export COREPACK_NPM_REGISTRY="${COREPACK_NPM_REGISTRY:-https://registry.npmmirror.com}"
  export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
  export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
  export SENTRYCLI_CDNURL="${SENTRYCLI_CDNURL:-https://npmmirror.com/mirrors/sentry-cli}"
  export npm_config_registry="${npm_config_registry:-https://registry.npmmirror.com}"
  export npm_config_canvas_binary_host_mirror="${npm_config_canvas_binary_host_mirror:-https://npmmirror.com/mirrors/canvas}"

  cd "${LOBEHUB_DIR}"
  pnpm install --node-linker=hoisted --registry="${npm_config_registry}"

  cd "${LOBEHUB_DIR}/apps/desktop"
  pnpm install --registry="${npm_config_registry}"
}

package_desktop() {
  export PATH="${NODE_DIR}/bin:${PATH}"
  export MODELNET_DESKTOP=1
  export MODELNET_DESKTOP_SERVER_URL
  export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
  export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

  cd "${LOBEHUB_DIR}"
  npm run desktop:package:modelnet:local
  npm run package:linux:appimage --prefix=./apps/desktop
}

ensure_node22
ensure_pnpm
node --version
pnpm --version
install_dependencies
package_desktop
