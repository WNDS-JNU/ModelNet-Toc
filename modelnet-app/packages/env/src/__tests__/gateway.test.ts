// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gatewayVariables = [
  'DEVICE_GATEWAY_SERVICE_TOKEN',
  'DEVICE_GATEWAY_URL',
  'MESSAGE_GATEWAY_SERVICE_TOKEN',
  'MESSAGE_GATEWAY_URL',
] as const;

describe('getGatewayConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const name of gatewayVariables) delete process.env[name];
  });

  afterEach(() => {
    for (const name of gatewayVariables) delete process.env[name];
  });

  it('treats empty compose values as disabled gateway configuration', async () => {
    process.env.DEVICE_GATEWAY_SERVICE_TOKEN = '';
    process.env.DEVICE_GATEWAY_URL = '';
    process.env.MESSAGE_GATEWAY_SERVICE_TOKEN = '';
    process.env.MESSAGE_GATEWAY_URL = '';

    const { getGatewayConfig } = await import('../gateway');
    expect(getGatewayConfig()).toMatchObject({
      DEVICE_GATEWAY_SERVICE_TOKEN: undefined,
      DEVICE_GATEWAY_URL: undefined,
      MESSAGE_GATEWAY_SERVICE_TOKEN: undefined,
      MESSAGE_GATEWAY_URL: undefined,
    });
  });

  it('preserves valid gateway URLs and service tokens', async () => {
    process.env.DEVICE_GATEWAY_SERVICE_TOKEN = 'device-token';
    process.env.DEVICE_GATEWAY_URL = 'http://device-gateway:3000';

    const { getGatewayConfig } = await import('../gateway');
    expect(getGatewayConfig()).toMatchObject({
      DEVICE_GATEWAY_SERVICE_TOKEN: 'device-token',
      DEVICE_GATEWAY_URL: 'http://device-gateway:3000',
    });
  });
});
