import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

// Docker Compose represents an intentionally unset variable as an empty
// string. Treat it as absent so a disabled gateway does not fail the URL
// schema at server startup.
const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);
const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional(),
);
export const getGatewayConfig = () => {
  return createEnv({
    runtimeEnv: {
      DEVICE_GATEWAY_SERVICE_TOKEN: process.env.DEVICE_GATEWAY_SERVICE_TOKEN,
      DEVICE_GATEWAY_URL: process.env.DEVICE_GATEWAY_URL,
      MESSAGE_GATEWAY_ENABLED: process.env.MESSAGE_GATEWAY_ENABLED,
      MESSAGE_GATEWAY_NODE_PLATFORMS: process.env.MESSAGE_GATEWAY_NODE_PLATFORMS,
      MESSAGE_GATEWAY_NODE_URL: process.env.MESSAGE_GATEWAY_NODE_URL,
      MESSAGE_GATEWAY_SERVICE_TOKEN: process.env.MESSAGE_GATEWAY_SERVICE_TOKEN,
      MESSAGE_GATEWAY_URL: process.env.MESSAGE_GATEWAY_URL,
    },

    server: {
      DEVICE_GATEWAY_SERVICE_TOKEN: optionalString,
      DEVICE_GATEWAY_URL: optionalUrl,
      MESSAGE_GATEWAY_ENABLED: z.string().optional(),
      /**
       * Comma-separated platform ids whose gateway connections live on the
       * Node message gateway instead of the default one (e.g. `wechat`).
       * Doubles as the migration/rollback switch: remove a platform from the
       * list and the next reconcile moves its connections back.
       */
      MESSAGE_GATEWAY_NODE_PLATFORMS: optionalString,
      /**
       * Base URL of the Node message gateway (long-polling / native-dep
       * platforms). Both gateways share MESSAGE_GATEWAY_SERVICE_TOKEN — the
       * inbound webhook/callback validation only accepts that one value, so a
       * per-gateway token would not actually isolate anything.
       */
      MESSAGE_GATEWAY_NODE_URL: optionalUrl,
      MESSAGE_GATEWAY_SERVICE_TOKEN: optionalString,
      MESSAGE_GATEWAY_URL: optionalUrl,
    },
  });
};

export const gatewayEnv = getGatewayConfig();
