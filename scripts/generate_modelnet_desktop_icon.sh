#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_icon="$repo_root/lobehub/public/icons/icon-512x512.png"
output_icon="$repo_root/lobehub/apps/desktop/build/modelnet-icon.icns"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/modelnet-icon.XXXXXX")"
iconset_dir="$tmp_dir/modelnet-icon.iconset"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

for tool in iconutil sips; do
  command -v "$tool" >/dev/null || {
    echo "Missing required macOS tool: $tool" >&2
    exit 1
  }
done

test -f "$source_icon" || {
  echo "Missing website logo source: $source_icon" >&2
  exit 1
}

mkdir -p "$iconset_dir"

resize() {
  local pixels="$1"
  local filename="$2"

  sips -z "$pixels" "$pixels" "$source_icon" --out "$iconset_dir/$filename" >/dev/null
}

resize 16 icon_16x16.png
resize 32 icon_16x16@2x.png
resize 32 icon_32x32.png
resize 64 icon_32x32@2x.png
resize 128 icon_128x128.png
resize 256 icon_128x128@2x.png
resize 256 icon_256x256.png
resize 512 icon_256x256@2x.png
resize 512 icon_512x512.png
resize 1024 icon_512x512@2x.png

iconutil -c icns "$iconset_dir" -o "$output_icon"
echo "Generated $output_icon from $source_icon"
