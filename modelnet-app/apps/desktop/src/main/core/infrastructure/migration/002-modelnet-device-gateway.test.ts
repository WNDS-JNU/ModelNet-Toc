import { describe, expect, it, vi } from 'vitest';

vi.mock('@/const/env', () => ({ IS_MODELNET_DESKTOP: true }));

import migration from './002-modelnet-device-gateway';

const run = (gatewayUrl: string | undefined) => {
  const store = {
    get: vi.fn(() => gatewayUrl),
    set: vi.fn(),
  } as any;
  migration.up(store);
  return store;
};

describe('002-modelnet-device-gateway migration', () => {
  it.each([undefined, '', 'https://device-gateway.lobehub.com'])(
    'moves an empty or legacy default URL (%s) to ModelNet',
    (gatewayUrl) => {
      const store = run(gatewayUrl);
      expect(store.set).toHaveBeenCalledWith('gatewayUrl', 'https://123.56.135.150');
    },
  );

  it('preserves a user-customized gateway URL', () => {
    const store = run('https://gateway.example.com');
    expect(store.set).not.toHaveBeenCalled();
  });
});
