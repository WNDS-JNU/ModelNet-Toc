import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Electron main-process build environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('bakes the ModelNet desktop preset and server URL and selects its macOS icon', async () => {
    vi.stubEnv('MODELNET_DESKTOP', '1');
    vi.stubEnv('MODELNET_DESKTOP_SERVER_URL', 'http://123.56.135.150');

    const { default: builderConfig } = await import('./electron-builder.mjs');
    const { default: viteConfig } = await import('./electron.vite.config');

    expect(viteConfig.main?.define).toMatchObject({
      'process.env.MODELNET_DESKTOP': JSON.stringify('1'),
      'process.env.MODELNET_DESKTOP_SERVER_URL': JSON.stringify('http://123.56.135.150'),
    });
    expect(builderConfig.mac?.icon).toBe('build/modelnet-icon.icns');
  });
});
