import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Electron main-process build environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('bakes the ModelNet desktop preset and uses ModelNet-only packaging', async () => {
    vi.stubEnv('MODELNET_DESKTOP', '1');
    vi.stubEnv('MODELNET_DESKTOP_SERVER_URL', 'http://123.56.135.150');
    vi.stubEnv('UPDATE_SERVER_URL', '');

    const { default: builderConfig } = await import('./electron-builder.mjs');
    const { default: viteConfig } = await import('./electron.vite.config');

    expect(viteConfig.main?.define).toMatchObject({
      'process.env.MODELNET_DESKTOP': JSON.stringify('1'),
      'process.env.MODELNET_DESKTOP_SERVER_URL': JSON.stringify('http://123.56.135.150'),
    });
    expect(builderConfig.appId).toBe('cn.edu.jnu.wnds.modelnet-desktop');
    expect(builderConfig.productName).toBe('ModelNet Desktop');
    expect(builderConfig.dmg?.background).toBe('resources/modelnet-dmg.png');
    expect(builderConfig.mac?.icon).toBe('build/modelnet-icon.icns');
    expect(builderConfig.linux).toMatchObject({
      executableName: 'modelnet-desktop',
      icon: 'build/modelnet-icon.png',
    });
    expect(builderConfig.win).toMatchObject({
      executableName: 'ModelNet Desktop',
      icon: 'build/modelnet-icon.ico',
    });
    expect(builderConfig.nsis).toMatchObject({
      installerHeader: './build/modelnet-nsis-header.bmp',
      installerHeaderIcon: './build/modelnet-icon.ico',
      installerIcon: './build/modelnet-icon.ico',
      installerSidebar: './build/modelnet-nsis-sidebar.bmp',
      uninstallerIcon: './build/modelnet-icon.ico',
      uninstallerSidebar: './build/modelnet-nsis-sidebar.bmp',
    });
    expect(builderConfig.protocols?.[0].schemes).toEqual(['modelnet']);
    expect(builderConfig.publish).toBeNull();
  });

  it('uses only the configured generic update server', async () => {
    vi.stubEnv('UPDATE_CHANNEL', 'nightly');
    vi.stubEnv('UPDATE_SERVER_URL', 'https://updates.example.com/stable');

    const { default: builderConfig } = await import('./electron-builder.mjs');

    expect(builderConfig.publish).toEqual([
      { provider: 'generic', url: 'https://updates.example.com/nightly' },
    ]);
  });

  it('keeps package metadata on ModelNet-owned surfaces', () => {
    const packageJSON = JSON.parse(
      readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
    );

    expect(packageJSON).toMatchObject({
      author: 'ModelNet',
      homepage: 'http://123.56.135.150',
      repository: {
        type: 'git',
        url: 'https://github.com/WNDS-JNU/ModelNet-Toc.git',
      },
    });
  });
});
