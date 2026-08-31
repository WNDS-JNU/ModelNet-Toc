// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queueWorkerOrQstashAuth } from '../queueWorkerOrQstashAuth';

const mockVerify = vi.fn<(req: Request, body: string) => Promise<boolean>>();
vi.mock('@/libs/qstash', () => ({
  verifyQStashSignature: (req: Request, body: string) => mockVerify(req, body),
}));

const buildContext = (authorization?: string) => {
  const body = '{"operationId":"op-1"}';
  const raw = new Request('http://x/api/agent/run', { body, method: 'POST' });
  return {
    json: (value: unknown, status = 200) => Response.json(value, { status }),
    req: {
      header: (name: string) =>
        name.toLowerCase() === 'authorization' ? authorization : undefined,
      path: '/api/agent/run',
      raw,
      text: async () => body,
    },
  } as any;
};

describe('queueWorkerOrQstashAuth', () => {
  beforeEach(() => {
    mockVerify.mockReset();
    process.env.AGENT_WORKER_TOKEN = 'worker-secret';
  });

  afterEach(() => {
    delete process.env.AGENT_WORKER_TOKEN;
    vi.clearAllMocks();
  });

  it('accepts a valid QStash signature', async () => {
    mockVerify.mockResolvedValue(true);
    const next = vi.fn().mockResolvedValue(undefined);

    await queueWorkerOrQstashAuth()(buildContext(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accepts the internal worker bearer token', async () => {
    mockVerify.mockResolvedValue(false);
    const next = vi.fn().mockResolvedValue(undefined);

    await queueWorkerOrQstashAuth()(buildContext('Bearer worker-secret'), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid queue credentials', async () => {
    mockVerify.mockResolvedValue(false);
    const next = vi.fn();

    const response = await queueWorkerOrQstashAuth()(buildContext('Bearer wrong'), next);

    expect(response?.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
