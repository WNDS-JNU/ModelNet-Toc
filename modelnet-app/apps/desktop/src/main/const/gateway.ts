import { IS_MODELNET_DESKTOP } from '@/const/env';

export const LOBEHUB_DEVICE_GATEWAY_URL = 'https://device-gateway.lobehub.com';
export const LEGACY_MODELNET_DEVICE_GATEWAY_URL = 'https://gateway.123.56.135.150.sslip.io';
export const MODELNET_DEVICE_GATEWAY_URL = 'https://123.56.135.150';

export const DEFAULT_DEVICE_GATEWAY_URL = IS_MODELNET_DESKTOP
  ? MODELNET_DEVICE_GATEWAY_URL
  : LOBEHUB_DEVICE_GATEWAY_URL;
