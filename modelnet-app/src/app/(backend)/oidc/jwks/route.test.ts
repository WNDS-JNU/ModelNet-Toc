/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';

const getJWKS = vi.hoisted(() => vi.fn());

vi.mock('@/libs/oidc-provider/jwt', () => ({ getJWKS }));

describe('OIDC public JWKS route', () => {
  it('returns an allowlisted RS256 public key without private RSA fields', async () => {
    getJWKS.mockReturnValue({
      keys: [
        {
          alg: 'RS256',
          d: 'private-d',
          dp: 'private-dp',
          dq: 'private-dq',
          e: 'AQAB',
          kid: 'test',
          kty: 'RSA',
          n: 'public-modulus',
          oth: [{ d: 'private-other' }],
          p: 'private-p',
          q: 'private-q',
          qi: 'private-qi',
          use: 'sig',
        },
      ],
    });

    const { GET } = await import('./route');
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/jwk-set+json');
    await expect(response.json()).resolves.toEqual({
      keys: [
        {
          alg: 'RS256',
          e: 'AQAB',
          kid: 'test',
          kty: 'RSA',
          n: 'public-modulus',
          use: 'sig',
        },
      ],
    });
  });
});
