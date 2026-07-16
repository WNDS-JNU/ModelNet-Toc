import { timingSafeEqual } from 'node:crypto';

import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';

import type { GatewayConfig } from './config.js';
import { GatewayError } from './errors.js';
import type { ParsedAuthMessage, SocketQuery } from './schemas.js';

export interface AuthResult {
  expiresAt?: number;
  principalId: string;
  principalKey: string;
  principalType: 'user' | 'workspace';
}

export interface Authenticator {
  authenticate: (message: ParsedAuthMessage, query: SocketQuery) => Promise<AuthResult>;
}

export interface AuthenticatorDependencies {
  fetch?: typeof globalThis.fetch;
  jwksCooldownDurationMs?: number;
  verifyJwt?: (token: string) => Promise<JWTPayload>;
}

const secureEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const principalForQuery = (query: SocketQuery): AuthResult => {
  if (query.workspaceId) {
    return {
      principalId: query.workspaceId,
      principalKey: `workspace:${query.workspaceId}`,
      principalType: 'workspace',
    };
  }

  return {
    principalId: query.userId!,
    principalKey: `user:${query.userId}`,
    principalType: 'user',
  };
};

const extractApiUserId = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.id === 'string') return record.id;
  if (record.data && typeof record.data === 'object') {
    const data = record.data as Record<string, unknown>;
    if (typeof data.id === 'string') return data.id;
    if (typeof data.userId === 'string') return data.userId;
  }
  if (typeof record.userId === 'string') return record.userId;
  return undefined;
};

export const createAuthenticator = (
  config: GatewayConfig,
  dependencies: AuthenticatorDependencies = {},
): Authenticator => {
  const remoteJwks = createRemoteJWKSet(new URL(config.oidcJwksUrl), {
    cooldownDuration: dependencies.jwksCooldownDurationMs,
  });
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const verifyJwt =
    dependencies.verifyJwt ??
    (async (token: string) => {
      const result = await jwtVerify(token, remoteJwks, { algorithms: ['RS256'] });
      return result.payload;
    });

  const authenticateJwt = async (
    message: ParsedAuthMessage,
    query: SocketQuery,
  ): Promise<AuthResult> => {
    try {
      const payload = await verifyJwt(message.token);
      const principal = principalForQuery(query);

      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
        throw new GatewayError(
          401,
          'AUTH_EXPIRY_REQUIRED',
          'Authentication token must contain a valid expiration time',
        );
      }
      const expiresAt = payload.exp * 1000;
      if (expiresAt <= Date.now()) {
        throw new GatewayError(401, 'AUTH_EXPIRED', 'Authentication token expired');
      }

      if (payload.sub !== principal.principalId) {
        throw new GatewayError(
          401,
          'AUTH_CLAIM_MISMATCH',
          'Token subject does not match principal',
        );
      }

      if (principal.principalType === 'workspace') {
        if (
          payload.purpose !== 'workspace-device-connect' ||
          payload.workspace_id !== principal.principalId
        ) {
          throw new GatewayError(
            401,
            'AUTH_CLAIM_MISMATCH',
            'Workspace token claims do not match principal',
          );
        }
      } else if (payload.purpose === 'workspace-device-connect') {
        throw new GatewayError(
          401,
          'AUTH_CLAIM_MISMATCH',
          'Workspace token cannot enroll a user device',
        );
      }

      return {
        ...principal,
        expiresAt,
      };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (error instanceof joseErrors.JWTExpired) {
        throw new GatewayError(401, 'AUTH_EXPIRED', 'Authentication token expired');
      }
      throw new GatewayError(401, 'AUTH_FAILED', 'Invalid authentication token');
    }
  };

  const authenticateApiKey = async (
    message: ParsedAuthMessage,
    query: SocketQuery,
  ): Promise<AuthResult> => {
    if (!query.userId || query.workspaceId) {
      throw new GatewayError(401, 'AUTH_FAILED', 'API keys can only enroll a user device');
    }
    if (!message.serverUrl) {
      throw new GatewayError(
        401,
        'AUTH_FAILED',
        'serverUrl is required for API key authentication',
      );
    }

    let origin: string;
    try {
      origin = new URL(message.serverUrl).origin;
    } catch {
      throw new GatewayError(401, 'AUTH_FAILED', 'Invalid serverUrl');
    }
    if (!config.allowedServerOrigins.has(origin)) {
      throw new GatewayError(401, 'AUTH_SERVER_NOT_ALLOWED', 'serverUrl origin is not allowed');
    }

    let response: Response;
    try {
      response = await fetchImpl(`${config.internalAppUrl}/api/v1/users/me?includeCount=0`, {
        headers: { Authorization: `Bearer ${message.token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GatewayError(
        503,
        'AUTH_BACKEND_UNAVAILABLE',
        'API key authentication is unavailable',
      );
    }

    if (!response.ok) {
      throw new GatewayError(401, 'AUTH_FAILED', 'Invalid API key');
    }
    const userId = extractApiUserId(await response.json().catch(() => null));
    if (!userId || userId !== query.userId) {
      throw new GatewayError(401, 'AUTH_CLAIM_MISMATCH', 'API key user does not match principal');
    }

    return principalForQuery(query);
  };

  return {
    authenticate: async (message, query) => {
      if (message.tokenType === 'serviceToken') {
        if (!secureEquals(message.token, config.serviceToken)) {
          throw new GatewayError(401, 'AUTH_FAILED', 'Invalid service token');
        }
        if (query.channel !== 'cli' && query.channel !== 'cli-dev') {
          throw new GatewayError(
            401,
            'AUTH_CHANNEL_NOT_ALLOWED',
            'Service token connections require a CLI channel',
          );
        }
        return principalForQuery(query);
      }
      if (message.tokenType === 'apiKey') return authenticateApiKey(message, query);
      return authenticateJwt(message, query);
    },
  };
};

export const serviceTokenMatches = (authorization: string | undefined, token: string): boolean => {
  if (!authorization?.startsWith('Bearer ')) return false;
  return secureEquals(authorization.slice('Bearer '.length), token);
};
