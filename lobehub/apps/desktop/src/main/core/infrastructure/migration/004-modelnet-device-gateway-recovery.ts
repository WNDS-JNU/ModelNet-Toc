import { IS_MODELNET_DESKTOP } from '@/const/env';
import {
  LEGACY_MODELNET_DEVICE_GATEWAY_URL,
  LOBEHUB_DEVICE_GATEWAY_URL,
  MODELNET_DEVICE_GATEWAY_URL,
} from '@/const/gateway';

import { defineMigration } from './defineMigration';

// Some early ModelNet builds recorded migrations 002/003 while still using the
// upstream product preset. Run this once for those already-marked installs so
// their known defaults converge without changing a user-selected Gateway.
export default defineMigration({
  id: '004-modelnet-device-gateway-recovery',
  up: (store) => {
    if (!IS_MODELNET_DESKTOP) return;

    const gatewayUrl = store.get('gatewayUrl');
    if (
      gatewayUrl === LOBEHUB_DEVICE_GATEWAY_URL ||
      gatewayUrl === LEGACY_MODELNET_DEVICE_GATEWAY_URL
    ) {
      store.set('gatewayUrl', MODELNET_DEVICE_GATEWAY_URL);
    }
  },
});
