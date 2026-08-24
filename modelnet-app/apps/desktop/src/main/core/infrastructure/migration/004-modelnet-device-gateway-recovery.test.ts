import { describe, expect, it, vi } from 'vitest';

vi.mock('@/const/env', () => ({ IS_MODELNET_DESKTOP: true }));

import migration from './004-modelnet-device-gateway-recovery';

const run = (gatewayUrl: string | undefined) => {
  const store = {
    get: vi.fn(() => gatewayUrl),
    set: vi.fn(),
  } as any;
  migration.up(store);
  return store;
};

describe('004-modelnet-device-gateway-recovery migration', () => {
  it.each(['https://device-gateway.lobehub.com', 'https://gateway.123.56.135.150.sslip.io'])(
    'recovers the prior default URL %s',
    (gatewayUrl) => {
      expect(run(gatewayUrl).set).toHaveBeenCalledWith('gatewayUrl', 'https://123.56.135.150');
    },
  );

  it.each([undefined, '', 'https://123.56.135.150', 'https://gateway.example.com'])(
    'preserves non-default gateway URL %s',
    (gatewayUrl) => {
      expect(run(gatewayUrl).set).not.toHaveBeenCalled();
    },
  );
});
