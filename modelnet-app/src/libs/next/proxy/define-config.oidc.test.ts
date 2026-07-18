/**
 * @vitest-environment node
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock('@/auth', () => ({
  auth: { api: { getSession } },
}));

import { defineConfig } from './define-config';

const { middleware } = defineConfig();

describe('OIDC public metadata routes', () => {
  beforeEach(() => getSession.mockClear());

  it.each(['/oidc/jwks', '/oidc/.well-known/openid-configuration'])(
    'does not session-gate %s',
    async (path) => {
      const response = await middleware(new NextRequest(`http://localhost:3010${path}`));

      expect(response?.status).toBe(200);
      expect(response?.headers.get('location')).toBeNull();
      expect(getSession).not.toHaveBeenCalled();
    },
  );
});
