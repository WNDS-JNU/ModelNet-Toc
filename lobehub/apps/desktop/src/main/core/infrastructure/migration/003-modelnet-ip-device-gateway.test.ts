import { describe, expect, it, vi } from 'vitest';

vi.mock('@/const/env', () => ({ IS_MODELNET_DESKTOP: true }));

import migration from './003-modelnet-ip-device-gateway';

const run = (gatewayUrl: string | undefined) => {
  const store = {
    get: vi.fn(() => gatewayUrl),
    set: vi.fn(),
  } as any;
  migration.up(store);
  return store;
};

describe('003-modelnet-ip-device-gateway migration', () => {
  it('moves the former ModelNet sslip.io gateway to the public IP', () => {
    const store = run('https://gateway.123.56.135.150.sslip.io');
    expect(store.set).toHaveBeenCalledWith('gatewayUrl', 'https://123.56.135.150');
  });

  it.each([
    undefined,
    '',
    'https://device-gateway.lobehub.com',
    'https://123.56.135.150',
    'https://gateway.example.com',
  ])('preserves any non-legacy gateway URL (%s)', (gatewayUrl) => {
    const store = run(gatewayUrl);
    expect(store.set).not.toHaveBeenCalled();
  });
});
