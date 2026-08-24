import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = resolve(desktopRoot, '../..');

const visibleTextSurfaces = [
  'electron-builder.mjs',
  'package.json',
  'README.md',
  'README.zh-CN.md',
  'src/main/env.ts',
  'src/main/controllers/CliCtr.ts',
  'src/main/core/infrastructure/BinaryManager.ts',
  'src/main/libs/mcp/client.ts',
  'src/main/libs/acp/client.ts',
  'src/main/modules/heterogeneousAgent/codexQuota.ts',
  'src/main/menus/impls/macOS.ts',
  'src/main/menus/impls/windows.ts',
  'src/main/menus/impls/linux.ts',
  'src/main/core/infrastructure/UpdaterManager.ts',
  'src/main/controllers/NotificationCtr.ts',
].map((file) => resolve(desktopRoot, file));

const modelnetAssets = [
  'resources/modelnet-dmg.png',
  'resources/modelnet-tray.png',
  'resources/modelnet-trayTemplate.png',
  'resources/modelnet-trayTemplate@2x.png',
  'build/modelnet-icon.icns',
  'build/modelnet-icon.ico',
  'build/modelnet-icon.png',
  'build/modelnet-nsis-header.bmp',
  'build/modelnet-nsis-sidebar.bmp',
].map((file) => resolve(desktopRoot, file));

modelnetAssets.push(resolve(repoRoot, 'public/avatars/modelnet.png'));

const retiredLobeAssets = [
  'resources/dmg.png',
  'resources/tray.png',
  'resources/trayTemplate.png',
  'resources/trayTemplate@2x.png',
  'resources/bin/lobe-cli.js',
  'build/icon.png',
  'build/icon.ico',
  'build/icon-dev.png',
  'build/icon-dev.ico',
  'build/icon-nightly.png',
  'build/icon-nightly.ico',
  'build/icon-beta.png',
  'build/icon-beta.ico',
  'build/Icon.icns',
  'build/Icon-nightly.icns',
  'build/Icon-beta.icns',
  'build/Icon.Assets.car',
  'build/Icon-dev.Assets.car',
  'build/Icon-nightly.Assets.car',
  'build/Icon-beta.Assets.car',
  'build/nsis-header.bmp',
  'build/nsis-sidebar.bmp',
].map((file) => resolve(desktopRoot, file));

retiredLobeAssets.push(resolve(repoRoot, 'public/avatars/lobe-ai.png'));

describe('ModelNet-only visible branding', () => {
  it('does not expose LobeHub websites, repositories, or product names', () => {
    const offenders = visibleTextSurfaces.filter((file) =>
      /LobeHub|LobeChat|lobehub\.com|github\.com\/lobehub/.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  it('ships every ModelNet installer and runtime icon asset', () => {
    expect(modelnetAssets.filter((file) => !existsSync(file))).toEqual([]);
  });

  it('does not retain legacy Lobe visual assets', () => {
    expect(retiredLobeAssets.filter(existsSync)).toEqual([]);
  });
});
