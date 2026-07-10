# ModelNet Desktop macOS Logo Design

## Goal

Make the Apple Silicon ModelNet Desktop application and its DMG display the same Jinan University logo used by the current ModelNet website.

## Canonical asset

The website branding constant points at `/icons/icon-192x192.png`. The matching higher-resolution source at `lobehub/public/icons/icon-512x512.png` is the canonical input for the desktop icon. No new logo artwork is created or substituted.

## Options considered

1. Generate a dedicated ModelNet macOS `.icns` from the website's 512px logo and select it only for the ModelNet preset. This preserves the upstream LobeHub icon for non-ModelNet builds and is the selected approach.
2. Overwrite `build/Icon.icns`. This would change every upstream desktop build, so it is rejected.
3. Keep only the website PNG. macOS package metadata requires a multi-resolution `.icns` for a reliable App, Dock, and DMG icon, so it is rejected.

## Design

- Add a committed, generated `lobehub/apps/desktop/build/modelnet-icon.icns` containing the standard macOS icon sizes from the website's 512px logo.
- Add a small macOS-only generator script so the `.icns` can be regenerated from the tracked website logo with `sips` and `iconutil`.
- In `electron-builder.mjs`, select `build/modelnet-icon.icns` only when `MODELNET_DESKTOP=1`; keep the existing icon for normal LobeHub builds.
- Do not copy the upstream `Icon.Assets.car` into a ModelNet build. If a ModelNet-specific asset catalog is not present, macOS uses the selected `.icns` fallback consistently.
- The Finder DMG shows the packaged app's icon, so no replacement artwork is added to the DMG background.

## Verification

- A desktop configuration test proves that the ModelNet preset resolves to the dedicated `.icns` and that the artifact exists.
- A native Apple Silicon package build succeeds on the Mac.
- The packaged `ModelNet Desktop.app` contains the dedicated `.icns`, reports an arm64 executable, and the copied DMG passes `hdiutil verify` before its SHA-256 is recorded.
