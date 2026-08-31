import { randomUUID } from 'node:crypto';

import type Redis from 'ioredis';

import { getAgentRuntimeRedisClient } from '@/server/modules/AgentRuntime/redis';

import {
  type RedisStreamQueueEnvelope,
  type RedisStreamQueueKeys,
  resolveRedisStreamQueueKeys,
} from '../redisStreamProtocol';
import { type HealthCheckResult, type QueueMessage, type QueueStats } from '../types';
import { type QueueServiceImpl } from './type';

const DEFAULT_DEDUPLICATION_TTL_SECONDS = 7 * 24 * 60 * 60;

const ENQUEUE_DEDUPLICATED = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
if ARGV[3] == 'delayed' then
  redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5])
else
  redis.call('XADD', KEYS[2], '*', 'id', ARGV[1], 'body', ARGV[5])
end
return ARGV[1]
`;

export { resolveRedisStreamQueueKeys } from '../redisStreamProtocol';

/**
 * Redis Streams queue used by the self-hosted Agent Runtime worker.
 *
 * The application process only publishes immutable message envelopes. A
 * separate worker owns delivery, retry, lease refresh, reclaim, and DLQ
 * transitions. Redis failures are surfaced to callers; this implementation
 * never falls back to the in-process queue.
 */
export class RedisStreamQueueServiceImpl implements QueueServiceImpl {
  readonly keys: RedisStreamQueueKeys;
  private readonly deduplicationTtlSeconds: number;

  constructor(
    private readonly redis: Redis,
    options?: { deduplicationTtlSeconds?: number; prefix?: string },
  ) {
    this.keys = resolveRedisStreamQueueKeys(options?.prefix ?? process.env.REDIS_PREFIX);
    this.deduplicationTtlSeconds =
      options?.deduplicationTtlSeconds ?? DEFAULT_DEDUPLICATION_TTL_SECONDS;
  }

  static fromEnvironment(): RedisStreamQueueServiceImpl {
    const redis = getAgentRuntimeRedisClient();
    if (!redis) {
      throw new Error('REDIS_URL is required when AGENT_RUNTIME_QUEUE_PROVIDER=redis-stream');
    }

    return new RedisStreamQueueServiceImpl(redis);
  }

  async scheduleMessage(message: QueueMessage): Promise<string> {
    const now = Date.now();
    const id = `redis-stream-${randomUUID()}`;
    const envelope: RedisStreamQueueEnvelope = {
      deliveryAttempt: 0,
      enqueuedAt: now,
      id,
      message,
    };
    const body = JSON.stringify(envelope);
    const dueAt = now + Math.max(0, message.delay ?? 0);
    const destination = dueAt > now ? 'delayed' : 'stream';

    if (message.deduplicationId) {
      const result = await this.redis.eval(
        ENQUEUE_DEDUPLICATED,
        3,
        `${this.keys.deduplicationPrefix}${message.deduplicationId}`,
        this.keys.stream,
        this.keys.delayed,
        id,
        this.deduplicationTtlSeconds.toString(),
        destination,
        dueAt.toString(),
        body,
      );

      return String(result);
    }

    if (destination === 'delayed') {
      await this.redis.zadd(this.keys.delayed, dueAt, body);
    } else {
      await this.redis.xadd(this.keys.stream, '*', 'id', id, 'body', body);
    }

    return id;
  }

  async scheduleBatchMessages(messages: QueueMessage[]): Promise<string[]> {
    return Promise.all(messages.map((message) => this.scheduleMessage(message)));
  }

  async cancelScheduledTask(taskId: string): Promise<void> {
    await this.redis.set(`${this.keys.cancelledPrefix}${taskId}`, '1', 'EX', 7 * 24 * 60 * 60);
  }

  async getQueueStats(): Promise<QueueStats> {
    const [streamLength, delayedCount, completedRaw, failedRaw] = await Promise.all([
      this.redis.xlen(this.keys.stream),
      this.redis.zcard(this.keys.delayed),
      this.redis.get(this.keys.completedCount),
      this.redis.get(this.keys.failedCount),
    ]);

    let processingCount = 0;
    try {
      const pending = await this.redis.xpending(this.keys.stream, this.keys.group);
      processingCount = Number(Array.isArray(pending) ? pending[0] : 0) || 0;
    } catch (error) {
      if (!String(error).includes('NOGROUP')) throw error;
    }

    return {
      completedCount: Number(completedRaw) || 0,
      failedCount: Number(failedRaw) || 0,
      pendingCount: Math.max(0, streamLength - processingCount) + delayedCount,
      processingCount,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const pong = await this.redis.ping();
      return {
        healthy: pong === 'PONG',
        message:
          pong === 'PONG' ? 'Redis Stream queue is ready' : `Unexpected Redis reply: ${pong}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
