import { TRPCError } from '@trpc/server';
import debug from 'debug';
import type { JWK } from 'jose';

import { authEnv } from '@/envs/auth';

const log = debug('oidc-jwt');

/**
 * Get JWKS key string from environment
 * Uses the canonical JWKS_KEY value from authEnv.
 */
const getJwksKeyString = () => {
  return authEnv.JWKS_KEY;
};

type JsonObject = Record<string, unknown>;
export interface JWKS {
  keys: JWK[];
}

const REQUIRED_RSA_PRIVATE_FIELDS = ['d', 'dp', 'dq', 'e', 'n', 'p', 'q', 'qi'] as const;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null;

const getModulusLength = (modulus: string) => {
  const bytes = Buffer.from(modulus, 'base64url');
  if (bytes.length === 0) {
    throw new Error('RSA RS256 signing key modulus must be valid base64url');
  }

  let leadingByte = bytes[0];
  let leadingBits = 0;
  while (leadingByte > 0) {
    leadingBits += 1;
    leadingByte >>= 1;
  }

  return (bytes.length - 1) * 8 + leadingBits;
};
const validateRS256SigningKey = (key: JWK) => {
  if (key.use !== 'sig') {
    throw new Error('RSA RS256 signing key must set use to "sig"');
  }

  for (const field of REQUIRED_RSA_PRIVATE_FIELDS) {
    if (!isNonEmptyString(key[field])) {
      throw new Error(`RSA RS256 signing key is missing private field: ${field}`);
    }
  }

  const modulusLength = getModulusLength(key.n as string);
  if (!modulusLength || modulusLength < 2048) {
    throw new Error('RSA RS256 signing key modulusLength must be at least 2048 bits');
  }
};

export const validateJWKS = (jwks: unknown): JWKS => {
  if (!isJsonObject(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw new Error('Invalid JWKS format: missing or empty keys array');
  }

  const keys = jwks.keys.filter(isJsonObject) as JWK[];
  if (keys.length !== jwks.keys.length) {
    throw new Error('Invalid JWKS format: keys must be objects');
  }

  const signingKeys = keys.filter((key) => key.alg === 'RS256' && key.kty === 'RSA');
  if (signingKeys.length === 0) {
    throw new Error('No RSA key with RS256 algorithm found in JWKS');
  }

  signingKeys.forEach(validateRS256SigningKey);

  return { keys };
};
/**
 * Get JWKS from environment variables
 * This JWKS is a JSON object containing RS256 private keys
 */
export const getJWKS = (): JWKS => {
  try {
    const jwksString = getJwksKeyString();

    if (!jwksString) {
      throw new Error(
        'JWKS_KEY environment variable is required. Please use scripts/generate-oidc-jwk.mjs to generate JWKS.',
      );
    }

    return validateJWKS(JSON.parse(jwksString));
  } catch (error) {
    console.error('Failed to parse JWKS:', error);
    throw new Error(`JWKS_KEY parse error: ${(error as Error).message}`, { cause: error });
  }
};

const getVerificationKey = async () => {
  try {
    const jwks = getJWKS();
    const privateRsaKey = jwks.keys.find((key) => key.alg === 'RS256' && key.kty === 'RSA');
    if (!privateRsaKey) {
      throw new Error('No RSA key with RS256 algorithm found in JWKS');
    }

    // Create a “clean” JWK object containing only public key components.
    // The key fields of an RSA public key are kty, n, e. Others like kid, alg, use are also public.
    const publicKeyJwk = {
      alg: privateRsaKey.alg,
      e: privateRsaKey.e,
      kid: privateRsaKey.kid,
      kty: privateRsaKey.kty,
      n: privateRsaKey.n,
      use: privateRsaKey.use,
    };

    // Remove any undefined fields to keep the object clean
    Object.keys(publicKeyJwk).forEach(
      (key) => (publicKeyJwk as any)[key] === undefined && delete (publicKeyJwk as any)[key],
    );

    const { importJWK } = await import('jose');

    // Now, in any environment, `importJWK` will correctly identify this object as a public key.
    return await importJWK(publicKeyJwk, 'RS256');
  } catch (error) {
    log('Failed to get JWKS public key: %O', error);
    throw new Error(`JWKS_KEY public key retrieval failed: ${(error as Error).message}`, {
      cause: error,
    });
  }
};

/**
 * Validate OIDC JWT Access Token
 * @param token - JWT access token
 * @returns Parsed token payload and user information
 */
export const validateOIDCJWT = async (token: string) => {
  log('Starting OIDC JWT token validation');

  // JWKS / signing key retrieval is an infrastructure concern (misconfigured
  // env, malformed JWKS, key import failure). Let these errors propagate as
  // plain Error so upstream middleware maps them to 500 and triggers ops
  // alerts — treating them as 401 would incorrectly ask clients to re-auth
  // while the real problem is server-side.
  const publicKey = await getVerificationKey();

  try {
    const { jwtVerify } = await import('jose');
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ['RS256'],
    });

    log('JWT validation successful, payload: %O', payload);

    const userId = payload.sub;
    const clientId = payload.client_id;
    const aud = payload.aud;

    if (!userId) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'JWT token is missing user ID (sub)',
      });
    }

    return {
      clientId,
      payload,
      tokenData: {
        aud,
        client_id: clientId,
        exp: payload.exp,
        iat: payload.iat,
        jti: payload.jti,
        purpose: payload.purpose as string | undefined,
        scope: payload.scope,
        sub: userId,
      },
      userId,
    };
  } catch (error) {
    if (error instanceof TRPCError) {
      throw error;
    }

    log('JWT validation failed: %O', error);

    // Preserve the original jose error via `cause` so upstream middleware
    // can still inspect specific codes like `ERR_JWT_EXPIRED`.
    throw new TRPCError({
      cause: error,
      code: 'UNAUTHORIZED',
      message: `JWT token validation failed: ${(error as Error).message}`,
    });
  }
};
