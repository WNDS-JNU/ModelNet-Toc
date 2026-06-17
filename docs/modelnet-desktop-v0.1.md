# ModelNet Desktop v0.1 Plan

## Product shape

ModelNet Desktop v0.1 is an Electron desktop client for the existing ModelNet ToC deployment.
It does not embed the full backend stack. The backend continues to run on 4A100 and public traffic
continues to enter through the Aliyun gateway.

Default desktop server:

```text
http://123.56.135.150
```

Current runtime chain:

```text
ModelNet Desktop
  -> http://123.56.135.150
  -> Aliyun nginx
  -> Tailscale
  -> 4A100:3081
  -> lobehub-toc-lb
  -> lobehub-toc-lobe
  -> modelnet-litellm / modelnet-router
```

This keeps the first release small: the desktop app is only the UI/client shell, while data,
auth, model routing, leaderboard data, LiteLLM, and router state remain server-side.

## v0.1 scope

Included:

- Electron desktop package built from `lobehub/apps/desktop`.
- Product name and installer artifact name set to `ModelNet Desktop` when built with
  `MODELNET_DESKTOP=1`.
- Linux unpacked executable is `modelnet-desktop`.
- Default self-host server prefilled as `http://123.56.135.150`.
- Packaged Electron metadata uses `modelnet-desktop` / `ModelNet Desktop`.
- Desktop onboarding opens the self-host connection panel when a self-host default exists.
- Existing ModelNet UI customizations remain available, including chat branding and `/leaderboard`.

Deferred:

- Bundling Docker/PostgreSQL/Redis/LiteLLM/modelnet-router inside the desktop app.
- Code signing, notarization, and auto-update publishing.
- Final icon replacement and full removal of upstream LobeHub wording.
- Windows/macOS release builds from their native platforms.

## Server prerequisites

On 4A100:

```bash
cd /home/duxianghe/ModelNet-toc
docker compose ps
```

The service `.env` must use the public Aliyun URL so desktop OIDC callbacks point at the public
entry instead of the private 4A100 address:

```text
APP_URL=http://123.56.135.150
```

`JWKS_KEY` must be a real RSA JWKS value. The placeholder `{"keys":[]}` is not enough for desktop
OIDC token signing and validation.

On Aliyun:

```bash
ssh aliyunM "nginx -t && systemctl is-active nginx && tailscale status"
ssh aliyunM "curl -sS -L -o /tmp/toc.html -w '%{http_code}\n' http://127.0.0.1/"
```

Expected public endpoint:

```text
http://123.56.135.150/
```

## Build commands

Desktop packaging should run with Node.js 22+ or 24+. The reproducible Linux build script installs
a private Node 22 under `${HOME}/.local/modelnet-node22`, enables the project `pnpm@10.33.0`, installs
the root and desktop workspaces, and produces both an unpacked Linux app and an AppImage.

From 4A100:

```bash
cd /home/duxianghe/ModelNet-toc
scripts/build_modelnet_desktop_linux.sh
```

The script defaults to:

```text
MODELNET_DESKTOP_SERVER_URL=http://123.56.135.150
```

If dependencies are already installed, the same ModelNet preset can be rebuilt with:

```bash
npm run desktop:package:modelnet:local
npm run desktop:package:modelnet:linux-appimage
```

The local unpacked app, AppImage, and portable archive are written under:

```text
/home/duxianghe/ModelNet-toc/lobehub/apps/desktop/release
```

A portable archive can be produced with:

```bash
cd /home/duxianghe/ModelNet-toc/lobehub/apps/desktop/release
tar -czf ModelNet-Desktop-v0.1-linux-x64-unpacked.tgz linux-unpacked
sha256sum ModelNet-Desktop-v0.1-linux-x64-unpacked.tgz
```

## Current v0.1 artifacts

Built on 4A100 on 2026-06-17:

```text
/home/duxianghe/ModelNet-toc/lobehub/apps/desktop/release/ModelNet Desktop-0.0.0.AppImage
size: 161M
sha256: e07ace5724016aac9dfd1cea26e64ca4eda604dff5ab77c791c552cb8b9050f4

/home/duxianghe/ModelNet-toc/lobehub/apps/desktop/release/ModelNet-Desktop-v0.1-linux-x64-unpacked.tgz
size: 179M
sha256: 0edab447d73e49e37c0afd6ba8dac19151b292f436ac26409d6dec13196168dc
entry executable: linux-unpacked/modelnet-desktop
```

The AppImage is the preferred Linux v0.1 handoff. The unpacked tarball is useful for debugging,
but direct execution may require either a root-owned `chrome-sandbox` with mode `4755` or launching
with Electron's `--no-sandbox` flag.

For a platform installer on the current build machine:

```bash
cd /home/duxianghe/ModelNet-toc/lobehub
npm run desktop:package:modelnet:app
```

## v0.1 acceptance checks

1. Start from a clean desktop profile or clear the app's previous Electron store.
2. Launch ModelNet Desktop.
3. The onboarding self-host section is visible and prefilled with `http://123.56.135.150`.
4. Click connect and complete browser login through the Aliyun public URL.
5. The desktop app enters the main ModelNet UI.
6. Open `/leaderboard` from navigation and confirm leaderboard data loads.
7. Send one chat request through a ModelNet model and confirm the response reaches the server-side
   ModelNet routing chain.
