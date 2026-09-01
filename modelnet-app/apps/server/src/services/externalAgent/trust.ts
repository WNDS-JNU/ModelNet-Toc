import type { ExternalAgentTrustPolicy } from '@lobechat/types';

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000;
const CREDENTIAL_REF_PATTERN = /^env:(A2A_[A-Z0-9_]{1,120})$/;

const originSet = (value: string | undefined): Set<string> => {
  const origins = new Set<string>();
  for (const item of value?.split(',') ?? []) {
    const candidate = item.trim();
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // Invalid deployment entries contribute no authority.
    }
  }
  return origins;
};

const positiveInteger = (value: string | undefined, fallback: number, ceiling: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, ceiling) : fallback;
};

export const normalizeExternalAgentEndpoint = (raw: string): string => {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('A2A endpoint must not contain credentials, query parameters, or fragments.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('A2A endpoint must use HTTP or HTTPS.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.toString();
};

export const validateExternalAgentCredentialRef = (
  authScheme: 'bearer' | 'none',
  credentialRef?: null | string,
): string | undefined => {
  if (authScheme === 'none') {
    if (credentialRef) throw new Error('A2A no-auth binding cannot carry a credentialRef.');
    return undefined;
  }
  const match = credentialRef?.match(CREDENTIAL_REF_PATTERN);
  if (!match) throw new Error('A2A bearer binding requires an env:A2A_* credentialRef.');
  return credentialRef ?? undefined;
};

/**
 * Resolve the effective policy from deployment-owned allowlists.
 * A binding can never widen this ceiling by changing its database JSON.
 */
export const resolveExternalAgentTrustPolicy = (endpointUrl: string): ExternalAgentTrustPolicy => {
  const endpoint = new URL(normalizeExternalAgentEndpoint(endpointUrl));
  const trusted = originSet(process.env.A2A_TRUSTED_ORIGINS);
  if (!trusted.has(endpoint.origin)) throw new Error('A2A endpoint origin is not trusted.');

  const trustedPrivate = originSet(process.env.A2A_TRUSTED_PRIVATE_ORIGINS);
  const allowPrivateNetwork = trustedPrivate.has(endpoint.origin);
  const allowInsecureHttp =
    endpoint.protocol === 'http:' &&
    process.env.A2A_DEPLOYMENT_ENV === 'development' &&
    process.env.A2A_ALLOW_INSECURE_HTTP === '1';
  if (endpoint.protocol !== 'https:' && !allowInsecureHttp) {
    throw new Error('A2A endpoint must use HTTPS.');
  }

  return {
    allowedOrigin: endpoint.origin,
    allowInsecureHttp,
    allowPrivateNetwork,
    maxResponseBytes: positiveInteger(
      process.env.A2A_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
      8 * 1024 * 1024,
    ),
    requestTimeoutMs: positiveInteger(
      process.env.A2A_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      30 * 60_000,
    ),
  };
};

export const assertExternalAgentBindingPolicy = (
  endpointUrl: string,
  snapshot: ExternalAgentTrustPolicy,
): ExternalAgentTrustPolicy => {
  const current = resolveExternalAgentTrustPolicy(endpointUrl);
  if (
    snapshot.allowedOrigin !== current.allowedOrigin ||
    snapshot.allowInsecureHttp !== current.allowInsecureHttp ||
    snapshot.allowPrivateNetwork !== current.allowPrivateNetwork
  ) {
    throw new Error('A2A binding trust policy no longer matches deployment policy.');
  }
  return {
    ...current,
    maxResponseBytes: Math.min(snapshot.maxResponseBytes, current.maxResponseBytes),
    requestTimeoutMs: Math.min(snapshot.requestTimeoutMs, current.requestTimeoutMs),
  };
};

export const resolveExternalAgentCredential = (credentialRef: string): string => {
  const match = credentialRef.match(CREDENTIAL_REF_PATTERN);
  if (!match) throw new Error('A2A credentialRef is invalid.');
  const value = process.env[match[1]];
  if (!value || value.length > 16_384 || /[\r\n]/.test(value)) {
    throw new Error('A2A credential is unavailable.');
  }
  return value;
};
