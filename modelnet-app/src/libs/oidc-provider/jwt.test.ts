import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createRsaKey = (n: string) => ({
  alg: 'RS256',
  d: 'private-d',
  dp: 'private-dp',
  dq: 'private-dq',
  e: 'AQAB',
  kid: 'test-key',
  kty: 'RSA',
  n,
  p: 'private-p',
  q: 'private-q',
  qi: 'private-qi',
  use: 'sig',
});

vi.mock('@/envs/auth', () => ({
  authEnv: {
    JWKS_KEY: JSON.stringify({
      keys: [createRsaKey('_'.repeat(342))],
    }),
  },
}));

const importJWKMock = vi.fn();
const jwtVerifyMock = vi.fn();

vi.mock('jose', () => ({
  importJWK: (...args: unknown[]) => importJWKMock(...args),
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
}));

describe('validateOIDCJWT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    importJWKMock.mockResolvedValue('public-key');
  });

  it('should preserve the original jose error as TRPCError cause', async () => {
    const joseError = Object.assign(new Error('"exp" claim timestamp check failed'), {
      code: 'ERR_JWT_EXPIRED',
    });
    jwtVerifyMock.mockRejectedValueOnce(joseError);

    const { validateOIDCJWT } = await import('./jwt');

    await expect(validateOIDCJWT('header.payload.signature')).rejects.toMatchObject({
      cause: joseError,
      code: 'UNAUTHORIZED',
    });
  });

  it('should not wrap JWKS/public key retrieval failures as TRPCError', async () => {
    importJWKMock.mockRejectedValueOnce(new Error('invalid JWK'));

    const { validateOIDCJWT } = await import('./jwt');

    const error = await validateOIDCJWT('header.payload.signature').catch((error_) => error_);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TRPCError);
    expect((error as Error).message).toBe('JWKS_KEY public key retrieval failed: invalid JWK');
  });
});

describe('JWKS validation', () => {
  it('accepts a 2048-bit RS256 private signing key', async () => {
    const { getJWKS } = await import('./jwt');

    expect(getJWKS().keys).toHaveLength(1);
  });

  it('rejects an RSA signing key below 2048 bits', async () => {
    const { validateJWKS } = await import('./jwt');

    expect(() => validateJWKS({ keys: [createRsaKey('_'.repeat(332))] })).toThrow(
      'modulusLength must be at least 2048 bits',
    );
  });

  it('rejects a public-only RS256 key', async () => {
    const { validateJWKS } = await import('./jwt');

    expect(() =>
      validateJWKS({
        keys: [
          {
            alg: 'RS256',
            e: 'AQAB',
            kty: 'RSA',
            n: 'public-modulus',
            use: 'sig',
          },
        ],
      }),
    ).toThrow('missing private field: d');
  });
});
