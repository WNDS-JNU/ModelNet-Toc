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
      MESSAGE_GATEWAY_SERVICE_TOKEN: process.env.MESSAGE_GATEWAY_SERVICE_TOKEN,
      MESSAGE_GATEWAY_URL: process.env.MESSAGE_GATEWAY_URL,
    },

    server: {
      DEVICE_GATEWAY_SERVICE_TOKEN: optionalString,
      DEVICE_GATEWAY_URL: optionalUrl,
      MESSAGE_GATEWAY_ENABLED: z.string().optional(),
      MESSAGE_GATEWAY_SERVICE_TOKEN: optionalString,
      MESSAGE_GATEWAY_URL: optionalUrl,
    },
  });
};

export const gatewayEnv = getGatewayConfig();
