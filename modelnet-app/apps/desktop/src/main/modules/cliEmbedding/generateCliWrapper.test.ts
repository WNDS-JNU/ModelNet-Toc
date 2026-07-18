import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  chmod: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  symlink: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

const appMock = vi.hoisted(() => ({
  getAppPath: vi.fn(() => '/app/apps/desktop'),
  getPath: vi.fn((name: string) => (name === 'userData' ? '/user-data' : '/electron')),
  isPackaged: true,
}));

vi.mock('node:fs/promises', () => fsMocks);
vi.mock('electron', () => ({ app: appMock }));
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn() }),
}));

import { generateCliWrapper } from './generateCliWrapper';

const originalPlatform = process.platform;

describe('generateCliWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/resources' });
    fsMocks.unlink.mockResolvedValue(undefined);
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('creates modelnet.cmd and Windows compatibility aliases', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });

    await generateCliWrapper();

    const destinations = fsMocks.rename.mock.calls.map(([, destination]) => destination);
    expect(destinations).toEqual(
      expect.arrayContaining([
        '/user-data/bin/modelnet.cmd',
        '/user-data/bin/lobehub.cmd',
        '/user-data/bin/lobe.cmd',
        '/user-data/bin/lh.cmd',
      ]),
    );
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('/resources/bin/modelnet-cli.js'),
      'utf8',
    );
  });

  it('creates modelnet and Unix compatibility symlinks', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });

    await generateCliWrapper();

    expect(fsMocks.rename).toHaveBeenCalledWith(expect.any(String), '/user-data/bin/modelnet');
    expect(fsMocks.chmod).toHaveBeenCalledWith('/user-data/bin/modelnet', 0o755);
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('/resources/bin/modelnet-cli.js'),
      'utf8',
    );
    expect(fsMocks.symlink.mock.calls).toEqual([
      ['modelnet', '/user-data/bin/lobehub'],
      ['modelnet', '/user-data/bin/lobe'],
      ['modelnet', '/user-data/bin/lh'],
    ]);
  });
});
