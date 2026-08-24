import { IS_MODELNET_DESKTOP } from '@/const/env';
import { LOBEHUB_DEVICE_GATEWAY_URL, MODELNET_DEVICE_GATEWAY_URL } from '@/const/gateway';

import { defineMigration } from './defineMigration';

export default defineMigration({
  id: '002-modelnet-device-gateway',
  up: (store) => {
    if (!IS_MODELNET_DESKTOP) return;

    const storedGatewayUrl = store.get('gatewayUrl');
    if (!storedGatewayUrl || storedGatewayUrl === LOBEHUB_DEVICE_GATEWAY_URL) {
      store.set('gatewayUrl', MODELNET_DEVICE_GATEWAY_URL);
    }
  },
});
