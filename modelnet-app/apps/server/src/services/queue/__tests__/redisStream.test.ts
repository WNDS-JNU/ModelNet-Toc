// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RedisStreamQueueServiceImpl } from '../impls/redisStream';

const createRedis = () =>
  ({
    eval: vi.fn(),
    get: vi.fn(),
    ping: vi.fn(),
    set: vi.fn(),
    xadd: vi.fn(),
    xlen: vi.fn(),
    xpending: vi.fn(),
    zadd: vi.fn(),
    zcard: vi.fn(),
  }) as any;

describe('RedisStreamQueueServiceImpl', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('publishes an immediate message to the stream', async () => {
    const redis = createRedis();
    redis.xadd.mockResolvedValue('1-0');
    const queue = new RedisStreamQueueServiceImpl(redis, { prefix: 'test' });

    const id = await queue.scheduleMessage({
      delay: 0,
      endpoint: 'http://app/api/agent/run',
      operationId: 'op-1',
      stepIndex: 2,
    });

    expect(id).toMatch(/^redis-stream-/);
    expect(redis.xadd).toHaveBeenCalledWith(
      'test:agent-runtime:queue',
      '*',
      'id',
      id,
      'body',
      expect.stringContaining('"operationId":"op-1"'),
    );
    expect(redis.zadd).not.toHaveBeenCalled();
  });

  it('stores delayed messages in the sorted set', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const redis = createRedis();
    redis.zadd.mockResolvedValue(1);
    const queue = new RedisStreamQueueServiceImpl(redis, { prefix: 'test' });

    await queue.scheduleMessage({
      delay: 2500,
      endpoint: 'http://app/api/agent/run',
      operationId: 'op-delayed',
      stepIndex: 0,
    });

    expect(redis.zadd).toHaveBeenCalledWith(
      'test:agent-runtime:delayed',
      1_700_000_002_500,
      expect.stringContaining('"operationId":"op-delayed"'),
    );
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('atomically deduplicates enqueue retries', async () => {
    const redis = createRedis();
    redis.eval.mockResolvedValue('redis-stream-existing');
    const queue = new RedisStreamQueueServiceImpl(redis, {
      deduplicationTtlSeconds: 60,
      prefix: 'test',
    });

    const id = await queue.scheduleMessage({
      deduplicationId: 'operation:step:1',
      delay: 0,
      endpoint: 'http://app/api/agent/run',
      operationId: 'op-dedupe',
      stepIndex: 1,
    });

    expect(id).toBe('redis-stream-existing');
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      3,
      'test:agent-runtime:dedupe:operation:step:1',
      'test:agent-runtime:queue',
      'test:agent-runtime:delayed',
      expect.stringMatching(/^redis-stream-/),
      '60',
      'stream',
      expect.any(String),
      expect.stringContaining('"operationId":"op-dedupe"'),
    );
  });

  it('reports stream, delayed, pending and terminal counters', async () => {
    const redis = createRedis();
    redis.xlen.mockResolvedValueOnce(7).mockResolvedValueOnce(2);
    redis.zcard.mockResolvedValue(2);
    redis.get.mockResolvedValueOnce('11').mockResolvedValueOnce('3');
    redis.xpending.mockResolvedValue([4, '1-0', '4-0', []]);
    const queue = new RedisStreamQueueServiceImpl(redis, { prefix: 'test' });

    await expect(queue.getQueueStats()).resolves.toEqual({
      completedCount: 11,
      deadLetterCount: 2,
      failedCount: 3,
      pendingCount: 5,
      processingCount: 4,
    });
  });

  it('marks cancellation durably and surfaces Redis health failures', async () => {
    const redis = createRedis();
    redis.set.mockResolvedValue('OK');
    redis.ping.mockRejectedValue(new Error('redis unavailable'));
    const queue = new RedisStreamQueueServiceImpl(redis, { prefix: 'test' });

    await queue.cancelScheduledTask('message-1');
    expect(redis.set).toHaveBeenCalledWith(
      'test:agent-runtime:cancelled:message-1',
      '1',
      'EX',
      604_800,
    );
    await expect(queue.healthCheck()).resolves.toEqual({
      healthy: false,
      message: 'redis unavailable',
    });
  });
});
