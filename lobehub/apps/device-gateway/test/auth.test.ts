// @vitest-environment node

import { once } from 'node:events';
import { createServer } from 'node:http';

import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { createAuthenticator } from '../src/auth.js';
import type { GatewayConfig } from '../src/config.js';
import { authMessageSchema, socketQuerySchema } from '../src/schemas.js';

const serviceToken = 'service-token-which-is-at-least-32-bytes-long';

const config: GatewayConfig = {
  allowedServerOrigins: new Set(['https://modelnet.example.com']),
  authTimeoutMs: 100,
  heartbeatSweepMs: 20,
  heartbeatTimeoutMs: 100,
  host: '127.0.0.1',
  internalAppUrl: 'http://modelnet-app:3210',
  maxConnectionsPerPrincipal: 64,
  maxPayloadBytes: 1024 * 1024,
  maxPendingPerPrincipal: 256,
  maxRequestTimeoutMs: 300_000,
  oidcJwksUrl: 'http://modelnet-app:3210/oidc/jwks',
  port: 0,
  serviceToken,
};

const personalQuery = socketQuerySchema.parse({
  channel: 'cli',
  connectionId: 'connection-1',
  deviceId: 'device-1',
  hostname: 'mac.local',
  platform: 'darwin',
  userId: 'user-1',
});

describe('Device Gateway authenticator', () => {
  it('verifies RS256 signatures, expiry, subject, and workspace claims', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const authenticator = createAuthenticator(config, {
      verifyJwt: async (token) => {
        const verified = await jwtVerify(token, publicKey, { algorithms: ['RS256'] });
        return verified.payload;
      },
    });

    const personalToken = await new SignJWT({ purpose: 'cli-sandbox' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('user-1')
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(
      authenticator.authenticate(
        authMessageSchema.parse({ token: personalToken, type: 'auth' }),
        personalQuery,
      ),
    ).resolves.toMatchObject({ principalKey: 'user:user-1', principalType: 'user' });

    const wrongSubjectToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('another-user')
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(
      authenticator.authenticate(
        authMessageSchema.parse({ token: wrongSubjectToken, type: 'auth' }),
        personalQuery,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_CLAIM_MISMATCH' });

    const workspaceQuery = socketQuerySchema.parse({
      connectionId: 'connection-workspace',
      deviceId: 'device-1',
      hostname: 'mac.local',
      platform: 'darwin',
      workspaceId: 'workspace-1',
    });
    const workspaceToken = await new SignJWT({
      purpose: 'workspace-device-connect',
      workspace_id: 'workspace-1',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('workspace-1')
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(
      authenticator.authenticate(
        authMessageSchema.parse({ token: workspaceToken, type: 'auth' }),
        workspaceQuery,
      ),
    ).resolves.toMatchObject({
      principalKey: 'workspace:workspace-1',
      principalType: 'workspace',
    });

    const invalidWorkspaceToken = await new SignJWT({
      purpose: 'workspace-device-connect',
      workspace_id: 'workspace-other',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('workspace-1')
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(
      authenticator.authenticate(
        authMessageSchema.parse({ token: invalidWorkspaceToken, type: 'auth' }),
        workspaceQuery,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_CLAIM_MISMATCH' });
  });

  it('requires a finite future expiration time on RS256 JWTs', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const authenticator = createAuthenticator(config, {
      verifyJwt: async (token) => {
        const verified = await jwtVerify(token, publicKey, { algorithms: ['RS256'] });
        return verified.payload;
      },
    });

    const missingExpiration = await new SignJWT({ purpose: 'cli-sandbox' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('user-1')
      .sign(privateKey);
    await expect(
      authenticator.authenticate(
        authMessageSchema.parse({ token: missingExpiration, type: 'auth' }),
        personalQuery,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRY_REQUIRED' });

    const expired = await new SignJWT({ purpose: 'cli-sandbox' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('user-1')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(privateKey);
    await expect(
      authenticator.authenticate(
        authMessageSchema.parse({ token: expired, type: 'auth' }),
        personalQuery,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });

    const nonFiniteAuthenticator = createAuthenticator(config, {
      verifyJwt: async () => ({ exp: Number.NaN, sub: 'user-1' }),
    });
    await expect(
      nonFiniteAuthenticator.authenticate(
        authMessageSchema.parse({ token: 'synthetic-token', type: 'auth' }),
        personalQuery,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRY_REQUIRED' });
  });

  it('refreshes the remote JWKS after a signing-key rotation', async () => {
    const firstPair = await generateKeyPair('RS256');
    const secondPair = await generateKeyPair('RS256');
    const firstJwk = {
      ...(await exportJWK(firstPair.publicKey)),
      alg: 'RS256',
      kid: 'key-1',
      use: 'sig',
    };
    const secondJwk = {
      ...(await exportJWK(secondPair.publicKey)),
      alg: 'RS256',
      kid: 'key-2',
      use: 'sig',
    };
    let keys = [firstJwk];
    let requestCount = 0;
    const jwksServer = createServer((_request, response) => {
      requestCount += 1;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ keys }));
    });
    jwksServer.listen(0, '127.0.0.1');
    await once(jwksServer, 'listening');
    const address = jwksServer.address();
    if (!address || typeof address === 'string') throw new Error('JWKS server did not bind');

    try {
      const authenticator = createAuthenticator(
        { ...config, oidcJwksUrl: `http://127.0.0.1:${address.port}/oidc/jwks` },
        { jwksCooldownDurationMs: 0 },
      );
      const firstToken = await new SignJWT({ purpose: 'cli-sandbox' })
        .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
        .setSubject('user-1')
        .setExpirationTime('5m')
        .sign(firstPair.privateKey);
      await expect(
        authenticator.authenticate(
          authMessageSchema.parse({ token: firstToken, type: 'auth' }),
          personalQuery,
        ),
      ).resolves.toMatchObject({ principalKey: 'user:user-1' });

      keys = [secondJwk];
      const secondToken = await new SignJWT({ purpose: 'cli-sandbox' })
        .setProtectedHeader({ alg: 'RS256', kid: 'key-2' })
        .setSubject('user-1')
        .setExpirationTime('5m')
        .sign(secondPair.privateKey);
      await expect(
        authenticator.authenticate(
          authMessageSchema.parse({ token: secondToken, type: 'auth' }),
          personalQuery,
        ),
      ).resolves.toMatchObject({ principalKey: 'user:user-1' });
      expect(requestCount).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        jwksServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('validates API keys through the fixed internal app URL and blocks SSRF origins', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'user-1' }));
    const authenticator = createAuthenticator(config, {
      fetch: fetchMock as typeof fetch,
      verifyJwt: vi.fn(),
    });

    await expect(
      authenticator.authenticate(
        authMessageSchema.parse({
          serverUrl: 'https://modelnet.example.com/some/path',
          token: 'api-key-value',
          tokenType: 'apiKey',
          type: 'auth',
        }),
        personalQuery,
      ),
    ).resolves.toMatchObject({ principalKey: 'user:user-1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://modelnet-app:3210/api/v1/users/me?includeCount=0',
      expect.objectContaining({ headers: { Authorization: 'Bearer api-key-value' } }),
    );

    await expect(
      authenticator.authenticate(
        authMessageSchema.parse({
          serverUrl: 'http://169.254.169.254/latest/meta-data',
          token: 'api-key-value',
          tokenType: 'apiKey',
          type: 'auth',
        }),
        personalQuery,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_SERVER_NOT_ALLOWED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires an exact service token, explicit principal, and CLI channel', async () => {
    const authenticator = createAuthenticator(config, { verifyJwt: vi.fn() });
    await expect(
      authenticator.authenticate(
        authMessageSchema.parse({ token: serviceToken, tokenType: 'serviceToken', type: 'auth' }),
        personalQuery,
      ),
    ).resolves.toMatchObject({ principalKey: 'user:user-1' });

    await expect(
      authenticator.authenticate(
        authMessageSchema.parse({ token: serviceToken, tokenType: 'serviceToken', type: 'auth' }),
        socketQuerySchema.parse({ ...personalQuery, channel: 'desktop' }),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_CHANNEL_NOT_ALLOWED' });

    await expect(
      authenticator.authenticate(
        authMessageSchema.parse({
          token: `${serviceToken}-wrong`,
          tokenType: 'serviceToken',
          type: 'auth',
        }),
        personalQuery,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});
