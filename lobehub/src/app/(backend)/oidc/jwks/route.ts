import { NextResponse } from 'next/server';

import { getJWKS, type JWKS } from '@/libs/oidc-provider/jwt';

const PUBLIC_RSA_JWK_FIELDS = [
  'alg',
  'e',
  'key_ops',
  'kid',
  'kty',
  'n',
  'use',
  'x5c',
  'x5t',
  'x5t#S256',
] as const;

export const toPublicRS256JWKS = (jwks: JWKS): JWKS => ({
  keys: jwks.keys
    .filter((key) => key.alg === 'RS256' && key.kty === 'RSA')
    .map((key) =>
      Object.fromEntries(
        PUBLIC_RSA_JWK_FIELDS.flatMap((field) =>
          key[field] === undefined ? [] : [[field, key[field]]],
        ),
      ),
    ),
});

export const dynamic = 'force-dynamic';

export const GET = () =>
  NextResponse.json(toPublicRS256JWKS(getJWKS()), {
    headers: {
      'Cache-Control': 'public, max-age=300, must-revalidate',
      'Content-Type': 'application/jwk-set+json',
    },
  });
