import { z } from 'zod';

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

const positiveInteger = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  DEVICE_GATEWAY_ALLOWED_SERVER_ORIGINS: z.string().default(''),
  DEVICE_GATEWAY_AUTH_TIMEOUT_MS: positiveInteger(10_000),
  DEVICE_GATEWAY_HEARTBEAT_SWEEP_MS: positiveInteger(30_000),
  DEVICE_GATEWAY_HEARTBEAT_TIMEOUT_MS: positiveInteger(90_000),
  DEVICE_GATEWAY_INTERNAL_APP_URL: z.string().url(),
  DEVICE_GATEWAY_MAX_CONNECTIONS_PER_PRINCIPAL: positiveInteger(64),
  DEVICE_GATEWAY_MAX_PAYLOAD_BYTES: positiveInteger(DEFAULT_MAX_PAYLOAD_BYTES),
  DEVICE_GATEWAY_MAX_PENDING_PER_PRINCIPAL: positiveInteger(256),
  DEVICE_GATEWAY_MAX_REQUEST_TIMEOUT_MS: positiveInteger(300_000),
  DEVICE_GATEWAY_OIDC_JWKS_URL: z.string().url(),
  DEVICE_GATEWAY_SERVICE_TOKEN: z.string().min(32),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
});

export interface GatewayConfig {
  allowedServerOrigins: ReadonlySet<string>;
  authTimeoutMs: number;
  heartbeatSweepMs: number;
  heartbeatTimeoutMs: number;
  host: string;
  internalAppUrl: string;
  maxConnectionsPerPrincipal: number;
  maxPayloadBytes: number;
  maxPendingPerPrincipal: number;
  maxRequestTimeoutMs: number;
  oidcJwksUrl: string;
  port: number;
  serviceToken: string;
}

const normalizeOrigin = (value: string): string => new URL(value).origin;

export const loadGatewayConfig = (
  env: Record<string, string | undefined> = process.env,
): GatewayConfig => {
  const parsed = envSchema.parse(env);
  const allowedServerOrigins = new Set(
    parsed.DEVICE_GATEWAY_ALLOWED_SERVER_ORIGINS.split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map(normalizeOrigin),
  );

  return {
    allowedServerOrigins,
    authTimeoutMs: parsed.DEVICE_GATEWAY_AUTH_TIMEOUT_MS,
    heartbeatSweepMs: parsed.DEVICE_GATEWAY_HEARTBEAT_SWEEP_MS,
    heartbeatTimeoutMs: parsed.DEVICE_GATEWAY_HEARTBEAT_TIMEOUT_MS,
    host: parsed.HOST,
    internalAppUrl: parsed.DEVICE_GATEWAY_INTERNAL_APP_URL.replace(/\/$/, ''),
    maxConnectionsPerPrincipal: parsed.DEVICE_GATEWAY_MAX_CONNECTIONS_PER_PRINCIPAL,
    maxPayloadBytes: parsed.DEVICE_GATEWAY_MAX_PAYLOAD_BYTES,
    maxPendingPerPrincipal: parsed.DEVICE_GATEWAY_MAX_PENDING_PER_PRINCIPAL,
    maxRequestTimeoutMs: parsed.DEVICE_GATEWAY_MAX_REQUEST_TIMEOUT_MS,
    oidcJwksUrl: parsed.DEVICE_GATEWAY_OIDC_JWKS_URL,
    port: parsed.PORT,
    serviceToken: parsed.DEVICE_GATEWAY_SERVICE_TOKEN,
  };
};
