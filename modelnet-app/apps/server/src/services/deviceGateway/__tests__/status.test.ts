import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  DEVICE_GATEWAY_SERVICE_TOKEN: undefined as string | undefined,
  DEVICE_GATEWAY_URL: undefined as string | undefined,
}));

const mockClient = vi.hoisted(() => ({
  queryDeviceList: vi.fn(),
  queryDeviceListStrict: vi.fn(),
  queryDeviceStatus: vi.fn(),
  queryDeviceStatusStrict: vi.fn(),
}));

vi.mock('@/envs/gateway', () => ({ gatewayEnv: mockEnv }));
vi.mock('@lobechat/device-gateway-client', () => ({
  GatewayHttpClient: vi.fn(() => mockClient),
}));

import { DeviceGateway } from '../index';

const configure = () => {
  mockEnv.DEVICE_GATEWAY_URL = 'http://device-gateway:3000';
  mockEnv.DEVICE_GATEWAY_SERVICE_TOKEN = 'service-token';
};

describe('DeviceGateway status classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.DEVICE_GATEWAY_URL = undefined;
    mockEnv.DEVICE_GATEWAY_SERVICE_TOKEN = undefined;
  });

  it('requires both URL and service token', () => {
    const gateway = new DeviceGateway();
    expect(gateway.isConfigured).toBe(false);

    mockEnv.DEVICE_GATEWAY_URL = 'http://device-gateway:3000';
    expect(gateway.isConfigured).toBe(false);

    mockEnv.DEVICE_GATEWAY_URL = undefined;
    mockEnv.DEVICE_GATEWAY_SERVICE_TOKEN = 'service-token';
    expect(gateway.isConfigured).toBe(false);

    configure();
    expect(gateway.isConfigured).toBe(true);
  });

  it('distinguishes not configured, offline, and online', async () => {
    const unconfigured = new DeviceGateway();
    await expect(unconfigured.queryGatewayStatus('user-1')).resolves.toEqual({
      deviceCount: 0,
      online: false,
      status: 'not_configured',
    });

    configure();
    mockClient.queryDeviceStatusStrict.mockResolvedValueOnce({ deviceCount: 0, online: false });
    await expect(new DeviceGateway().queryGatewayStatus('user-1')).resolves.toEqual({
      deviceCount: 0,
      online: false,
      status: 'offline',
    });

    mockClient.queryDeviceStatusStrict.mockResolvedValueOnce({ deviceCount: 2, online: true });
    await expect(new DeviceGateway().queryGatewayStatus('user-1')).resolves.toEqual({
      deviceCount: 2,
      online: true,
      status: 'online',
    });
  });

  it('distinguishes authentication failure from network unavailability', async () => {
    configure();
    mockClient.queryDeviceStatusStrict.mockRejectedValueOnce({ code: 'UNAUTHORIZED', status: 401 });
    await expect(new DeviceGateway().queryGatewayStatus('user-1')).resolves.toMatchObject({
      status: 'unauthorized',
    });

    mockClient.queryDeviceStatusStrict.mockRejectedValueOnce({
      code: 'GATEWAY_UNAVAILABLE',
      status: 0,
    });
    await expect(new DeviceGateway().queryGatewayStatus('user-1')).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it('keeps soft list queries empty but makes explicit list failures actionable', async () => {
    configure();
    mockClient.queryDeviceList.mockRejectedValueOnce(new Error('network'));
    await expect(new DeviceGateway().queryDeviceList('user-1')).resolves.toEqual([]);

    mockClient.queryDeviceListStrict.mockRejectedValueOnce({ code: 'UNAUTHORIZED', status: 401 });
    await expect(new DeviceGateway().queryDeviceListStrict('user-1')).rejects.toMatchObject({
      gatewayStatus: 'unauthorized',
      message: 'Device Gateway authentication failed',
    });
  });

  it('throws not_configured before an explicit gateway request', async () => {
    await expect(new DeviceGateway().queryDeviceListStrict('user-1')).rejects.toEqual(
      expect.objectContaining({
        gatewayStatus: 'not_configured',
        message: 'Device Gateway is not configured',
      }),
    );
  });
});
