# ModelNet Desktop macOS ARM64 Release Design

## Goal

Produce an unsigned, Apple Silicon-native `ModelNet Desktop` DMG from the
current ModelNet ToC source on the supplied Tailscale-connected Mac.

## Scope

- The desktop client remains an Electron shell for the deployed ModelNet ToC.
- Its baked default server is `http://123.56.135.150`.
- The output targets macOS `arm64` only and is intentionally neither signed nor
  notarized. Users install it with the Finder right-click **Open** flow.
- The backend stack, deployment configuration, code signing, notarization, and
  automatic updates are out of scope.

## Source and Build Flow

1. Split the existing worktree into focused commits, then push the current
   branch to `origin`.
2. The Mac clones that branch and checks out the recorded commit SHA, so the
   build input is traceable and excludes uncommitted workstation state.
3. Install a private Node.js 22+ ARM64 toolchain under the Mac user's home
   directory, activate `pnpm@10.33.0`, and install the root and desktop
   workspaces with the configured mirror endpoints.
4. Set `MODELNET_DESKTOP=1` and run the existing macOS Electron packaging
   command. The project's Electron Builder configuration detects `arm64`,
   disables signing when no `CSC_LINK` exists, and emits both a DMG and ZIP.
5. Rename the DMG handoff copy to
   `ModelNet-Desktop-v0.1-macos-arm64.dmg` on the Mac desktop. Keep the
   Electron Builder release directory intact for diagnostics.

## Verification and Handoff

- Record the remote Git SHA, Node and pnpm versions, and package command exit
  status.
- Confirm the DMG mounts with `hdiutil`, the bundled executable is `arm64`, and
  the archive has a SHA-256 checksum.
- Confirm no Developer ID is present and report the expected Gatekeeper manual
  approval requirement rather than treating it as a build failure.
