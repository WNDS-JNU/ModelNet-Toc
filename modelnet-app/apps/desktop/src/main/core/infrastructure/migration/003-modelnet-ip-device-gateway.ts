import { IS_MODELNET_DESKTOP } from '@/const/env';
import { LEGACY_MODELNET_DEVICE_GATEWAY_URL, MODELNET_DEVICE_GATEWAY_URL } from '@/const/gateway';

import { defineMigration } from './defineMigration';

export default defineMigration({
  id: '003-modelnet-ip-device-gateway',
  up: (store) => {
    if (!IS_MODELNET_DESKTOP) return;

    if (store.get('gatewayUrl') === LEGACY_MODELNET_DEVICE_GATEWAY_URL) {
      store.set('gatewayUrl', MODELNET_DEVICE_GATEWAY_URL);
    }
  },
});
