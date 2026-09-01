// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeExternalAgentEndpoint,
  resolveExternalAgentCredential,
  resolveExternalAgentTrustPolicy,
  validateExternalAgentCredentialRef,
} from './trust';

afterEach(() => vi.unstubAllEnvs());

describe('external Agent trust policy', () => {
  it('requires an exact deployment allowlist origin', () => {
    vi.stubEnv('A2A_TRUSTED_ORIGINS', 'https://trusted.example');

    expect(resolveExternalAgentTrustPolicy('https://trusted.example/a2a')).toMatchObject({
      allowedOrigin: 'https://trusted.example',
      allowPrivateNetwork: false,
    });
    expect(() => resolveExternalAgentTrustPolicy('https://evil.example/a2a')).toThrow(
      'origin is not trusted',
    );
  });

  it('allows private HTTP only through explicit dev policy', () => {
    vi.stubEnv('A2A_DEPLOYMENT_ENV', 'development');
    vi.stubEnv('A2A_TRUSTED_ORIGINS', 'http://a2a-dev-mock:3400');
    vi.stubEnv('A2A_TRUSTED_PRIVATE_ORIGINS', 'http://a2a-dev-mock:3400');
    vi.stubEnv('A2A_ALLOW_INSECURE_HTTP', '1');

    expect(resolveExternalAgentTrustPolicy('http://a2a-dev-mock:3400/a2a')).toMatchObject({
      allowInsecureHttp: true,
      allowPrivateNetwork: true,
    });
  });

  it('rejects URL secrets and only accepts env:A2A_* credential references', () => {
    expect(() => normalizeExternalAgentEndpoint('https://user:pass@example.com/a2a')).toThrow(
      'must not contain credentials',
    );
    expect(validateExternalAgentCredentialRef('bearer', 'env:A2A_PARTNER_TOKEN')).toBe(
      'env:A2A_PARTNER_TOKEN',
    );
    expect(() => validateExternalAgentCredentialRef('bearer', 'env:OTHER_TOKEN')).toThrow(
      'env:A2A_*',
    );
    expect(() => validateExternalAgentCredentialRef('none', 'env:A2A_PARTNER_TOKEN')).toThrow(
      'cannot carry',
    );
  });

  it('resolves a credential without accepting multiline header injection', () => {
    vi.stubEnv('A2A_PARTNER_TOKEN', 'secret-value');
    expect(resolveExternalAgentCredential('env:A2A_PARTNER_TOKEN')).toBe('secret-value');
    vi.stubEnv('A2A_PARTNER_TOKEN', 'secret\nforged-header');
    expect(() => resolveExternalAgentCredential('env:A2A_PARTNER_TOKEN')).toThrow(
      'credential is unavailable',
    );
  });
});
