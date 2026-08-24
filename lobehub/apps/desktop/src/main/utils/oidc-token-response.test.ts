import { describe, expect, it } from 'vitest';

import { parseOIDCTokenResponse } from './oidc-token-response';

describe('parseOIDCTokenResponse', () => {
  it('surfaces OAuth errors even when a broken server marks them as HTTP 200', async () => {
    const result = await parseOIDCTokenResponse(
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Authorization code is invalid',
        }),
      ),
      'Failed to get token',
    );

    expect(result).toMatchObject({
      error: 'Failed to get token: 200: invalid_grant: Authorization code is invalid',
      success: false,
    });
  });

  it('keeps OAuth protocol errors distinct from token-field validation', async () => {
    const result = await parseOIDCTokenResponse(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      'Token refresh failed',
    );

    expect(result).toMatchObject({
      error: 'Token refresh failed: 400: invalid_grant',
      success: false,
    });
  });

  it('identifies a missing refresh token without logging its value', async () => {
    const result = await parseOIDCTokenResponse(
      new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 })),
      'Failed to get token',
    );

    expect(result).toMatchObject({
      error: 'Invalid token response: missing refresh_token',
      metadata: {
        fields: ['access_token', 'expires_in'],
        hasAccessToken: true,
        hasRefreshToken: false,
      },
      success: false,
    });
  });

  it('accepts a complete access and refresh token response', async () => {
    const result = await parseOIDCTokenResponse(
      new Response(
        JSON.stringify({
          access_token: 'access-token',
          expires_in: 3600,
          refresh_token: 'refresh-token',
        }),
      ),
      'Failed to get token',
    );

    if ('error' in result) throw new Error(result.error);

    expect(result).toMatchObject({
      accessToken: 'access-token',
      expiresIn: 3600,
      refreshToken: 'refresh-token',
    });
  });
});
