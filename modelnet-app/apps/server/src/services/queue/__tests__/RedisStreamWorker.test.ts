// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decodeRedisStreamEntry,
  RedisStreamWorker,
  resolveRedisStreamRetryDelay,
  resolveWorkerEndpoint,
} from '../RedisStreamWorker';

const now = 1_700_000_000_000;

const envelope = (overrides?: Record<string, unknown>) => ({
  deliveryAttempt: 0,
  enqueuedAt: now,
  id: 'message-1',
  message: {
    endpoint: 'http://public.example/api/agent/run',
    operationId: 'op-1',
    retries: 2,
    stepIndex: 0,
  },
  ...overrides,
});

const entry = (value = envelope()): [string, string[]] => [
  '123-0',
  ['id', 'message-1', 'body', JSON.stringify(value)],
];

const createRedis = () =>
  ({
    eval: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    xautoclaim: vi.fn().mockResolvedValue(['0-0', []]),
    xclaim: vi.fn().mockResolvedValue([]),
    xgroup: vi.fn().mockResolvedValue('OK'),
  }) as any;

const createWorker = (options?: { fetch?: typeof fetch; redis?: any }) => {
  const redis = options?.redis ?? createRedis();
  const fetchImpl =
    options?.fetch ?? vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  const worker = new RedisStreamWorker(
    { fetch: fetchImpl, now: () => now, readRedis: redis, redis },
    {
      appUrl: 'http://modelnet-app:3210',
      consumer: 'worker-test',
      leaseMs: 90_000,
      prefix: 'test',
      token: 'worker-secret',
    },
  );
  return { fetchImpl, redis, worker };
};

describe('RedisStreamWorker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes envelopes and pins delivery to the internal app origin', () => {
    expect(decodeRedisStreamEntry(entry())).toMatchObject({
      envelope: { id: 'message-1' },
      streamId: '123-0',
    });
    expect(
      resolveWorkerEndpoint(
        'https://untrusted.example/api/agent/run?source=queue',
        'http://modelnet-app:3210',
      ),
    ).toBe('http://modelnet-app:3210/api/agent/run?source=queue');
    expect(resolveWorkerEndpoint('/api/agent/run', 'http://modelnet-app:3210')).toBe(
      'http://modelnet-app:3210/api/agent/run',
    );
    expect(() =>
      resolveWorkerEndpoint('https://untrusted.example/webhook', 'http://modelnet-app:3210'),
    ).toThrow('Worker refuses non-Agent endpoint');
  });

  it('delivers with worker auth and atomically acknowledges success', async () => {
    const { fetchImpl, redis, worker } = createWorker();

    await worker.processEntry(entry());

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://modelnet-app:3210/api/agent/run',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer worker-secret',
          'Upstash-Message-Id': 'message-1',
          'Upstash-Retried': '0',
        }),
        method: 'POST',
      }),
    );
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('XACK'"),
      2,
      'test:agent-runtime:queue',
      'test:agent-runtime:completed-count',
      'test:agent-runtime:workers',
      '123-0',
    );
  });

  it('moves a failed delivery to delayed retry with an incremented attempt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));
    const { redis, worker } = createWorker({ fetch: fetchImpl });

    await worker.processEntry(entry());

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('ZADD'"),
      2,
      'test:agent-runtime:queue',
      'test:agent-runtime:delayed',
      'test:agent-runtime:workers',
      '123-0',
      (now + 1000).toString(),
      expect.stringContaining('"deliveryAttempt":1'),
    );
  });

  it('dead-letters exhausted deliveries', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection refused'));
    const { redis, worker } = createWorker({ fetch: fetchImpl });

    await worker.processEntry(entry(envelope({ deliveryAttempt: 2 })));

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("'failedAt'"),
      3,
      'test:agent-runtime:queue',
      'test:agent-runtime:dead-letter',
      'test:agent-runtime:failed-count',
      'test:agent-runtime:workers',
      '123-0',
      expect.any(String),
      'connection refused',
      new Date(now).toISOString(),
    );
  });

  it('reclaims and processes messages whose worker lease expired', async () => {
    const redis = createRedis();
    redis.xautoclaim.mockResolvedValue(['0-0', [entry()]]);
    const { fetchImpl, worker } = createWorker({ redis });

    await expect(worker.reclaimStaleMessages()).resolves.toBe(1);
    expect(redis.xautoclaim).toHaveBeenCalledWith(
      'test:agent-runtime:queue',
      'test:agent-runtime:workers',
      'worker-test',
      90_000,
      '0-0',
      'COUNT',
      10,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses bounded exponential retry delays', () => {
    expect(resolveRedisStreamRetryDelay(0)).toBe(1000);
    expect(resolveRedisStreamRetryDelay(3)).toBe(8000);
    expect(resolveRedisStreamRetryDelay(20)).toBe(60_000);
  });
});
