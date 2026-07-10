# ModelNet Desktop macOS Logo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the current website's Jinan University logo in the ModelNet Desktop macOS App, Dock, and DMG without affecting non-ModelNet desktop builds.

**Architecture:** The website's tracked 512px logo is converted into a committed macOS `.icns` asset. Electron Builder chooses that asset only when `MODELNET_DESKTOP=1` and skips the upstream macOS asset catalog for that preset, leaving the fallback `.icns` authoritative.

**Tech Stack:** Electron Builder, macOS `sips`, macOS `iconutil`, Vitest, Apple Silicon macOS.

## Global Constraints

- Canonical logo input: `lobehub/public/icons/icon-512x512.png`.
- Target: unsigned Apple Silicon macOS DMG only.
- Normal LobeHub desktop icon resources must remain unchanged.
- The resulting app must keep the baked public server URL `http://123.56.135.150`.

---

### Task 1: Add a reproducible ModelNet icon asset

**Files:**
- Create: `scripts/generate_modelnet_desktop_icon.sh`
- Create: `lobehub/apps/desktop/build/modelnet-icon.icns`

**Interfaces:**
- Consumes: `lobehub/public/icons/icon-512x512.png`
- Produces: a valid macOS `.icns` at `lobehub/apps/desktop/build/modelnet-icon.icns`

- [ ] **Step 1: Create the icon generator**

```bash
#!/usr/bin/env bash
set -euo pipefail

source_icon="lobehub/public/icons/icon-512x512.png"
output_icon="lobehub/apps/desktop/build/modelnet-icon.icns"
iconset_dir="$(mktemp -d)/modelnet-icon.iconset"
trap 'rm -rf "${iconset_dir%/*.iconset}"' EXIT
mkdir -p "$iconset_dir"

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$source_icon" --out "$iconset_dir/icon_${size}x${size}.png"
done
for size in 16 32 128 256 512; do
  doubled=$((size * 2))
  sips -z "$doubled" "$doubled" "$source_icon" --out "$iconset_dir/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$iconset_dir" -o "$output_icon"
```

- [ ] **Step 2: Run the generator on the Apple Silicon Mac**

Run: `bash scripts/generate_modelnet_desktop_icon.sh`

Expected: `lobehub/apps/desktop/build/modelnet-icon.icns` exists and `file` reports an Apple icon image.

- [ ] **Step 3: Commit the source and generated asset**

```bash
git add scripts/generate_modelnet_desktop_icon.sh lobehub/apps/desktop/build/modelnet-icon.icns
git commit -m "feat(desktop): add ModelNet macOS icon"
```

### Task 2: Select the dedicated icon for ModelNet packaging

**Files:**
- Modify: `lobehub/apps/desktop/electron-builder.mjs:102-108,183-221,289-315`
- Modify: `lobehub/apps/desktop/electron.vite.config.test.ts`

**Interfaces:**
- Consumes: `MODELNET_DESKTOP` and `build/modelnet-icon.icns`
- Produces: a ModelNet-only `mac.icon` setting and no upstream `Assets.car` copy for the ModelNet preset

- [ ] **Step 1: Extend the failing configuration test**

```ts
expect(config.mac?.icon).toBe('build/modelnet-icon.icns');
expect(existsSync(resolve(__dirname, 'build/modelnet-icon.icns'))).toBe(true);
```

- [ ] **Step 2: Run the test to verify it fails before the packaging selection exists**

Run: `./node_modules/.bin/vitest run electron.vite.config.test.ts`

Expected: FAIL because `config.mac.icon` is undefined or uses the generic icon.

- [ ] **Step 3: Implement the ModelNet-only icon selection**

```js
const macIcon = isModelNetDesktop ? 'build/modelnet-icon.icns' : undefined;

mac: {
  ...(macIcon ? { icon: macIcon } : {}),
  // existing macOS settings
}
```

Set the asset-catalog source to a nonexistent ModelNet-specific name when `isModelNetDesktop` is true so the existing guarded copy falls back to the selected `.icns`.

- [ ] **Step 4: Run the focused tests**

Run: `./node_modules/.bin/vitest run electron.vite.config.test.ts src/main/const/env.test.ts src/main/core/browser/__tests__/Browser.test.ts`

Expected: 48 passing tests or more, with no failures.

- [ ] **Step 5: Commit the packaging selection and regression test**

```bash
git add lobehub/apps/desktop/electron-builder.mjs lobehub/apps/desktop/electron.vite.config.test.ts
git commit -m "fix(desktop): use ModelNet macOS icon"
```

### Task 3: Package and verify the final artifact

**Files:**
- Generated: `lobehub/apps/desktop/release/ModelNet Desktop-0.0.0-arm64.dmg`

**Interfaces:**
- Consumes: the committed icon, packaging selection, and baked ModelNet public URL
- Produces: `/Users/xianghedu/Desktop/ModelNet-Desktop-v0.1-macos-arm64.dmg`

- [ ] **Step 1: Push the completed branch**

Run: `git push origin codex/merge-lobehub-canary-20260703`

Expected: remote branch includes the icon changes.

- [ ] **Step 2: Pull and package on the Apple Silicon Mac**

Run:

```bash
git pull --ff-only origin codex/merge-lobehub-canary-20260703
PATH="$HOME/.local/modelnet-node24/bin:$PATH" npm run desktop:package:modelnet:app
```

Expected: an unsigned `ModelNet Desktop-0.0.0-arm64.dmg` is created.

- [ ] **Step 3: Verify the complete package before copying it**

Run:

```bash
hdiutil verify "release/ModelNet Desktop-0.0.0-arm64.dmg"
hdiutil attach -nobrowse -readonly "release/ModelNet Desktop-0.0.0-arm64.dmg"
file "/Volumes/ModelNet Desktop 0.0.0-arm64/ModelNet Desktop.app/Contents/MacOS/ModelNet Desktop"
test -f "/Volumes/ModelNet Desktop 0.0.0-arm64/ModelNet Desktop.app/Contents/Resources/modelnet-icon.icns"
```

Expected: DMG verification succeeds, executable reports arm64, and the dedicated icon exists in the app bundle.

- [ ] **Step 4: Copy and checksum the verified artifact**

Run:

```bash
cp "release/ModelNet Desktop-0.0.0-arm64.dmg" /Users/xianghedu/Desktop/ModelNet-Desktop-v0.1-macos-arm64.dmg
shasum -a 256 /Users/xianghedu/Desktop/ModelNet-Desktop-v0.1-macos-arm64.dmg
```

Expected: the Mac desktop holds a complete, verified unsigned ARM64 DMG and its SHA-256 is recorded.
