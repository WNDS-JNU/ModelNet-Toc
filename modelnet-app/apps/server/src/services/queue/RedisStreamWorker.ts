import type Redis from 'ioredis';

import {
  type RedisStreamQueueEnvelope,
  type RedisStreamQueueKeys,
  resolveRedisStreamQueueKeys,
} from './redisStreamProtocol';

type StreamEntry = [id: string, fields: string[]];

const PROMOTE_DUE_MESSAGES = `
local messages = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local promoted = 0
for _, body in ipairs(messages) do
  if redis.call('ZREM', KEYS[1], body) == 1 then
    local envelope = cjson.decode(body)
    redis.call('XADD', KEYS[2], '*', 'id', envelope.id, 'body', body)
    promoted = promoted + 1
  end
end
return promoted
`;

const SETTLE_SUCCESS = `
redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
redis.call('XDEL', KEYS[1], ARGV[2])
redis.call('INCR', KEYS[2])
return 1
`;

const MOVE_TO_DELAYED = `
redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
redis.call('XDEL', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
return 1
`;

const MOVE_TO_DEAD_LETTER = `
redis.call(
  'XADD',
  KEYS[2],
  '*',
  'sourceId',
  ARGV[2],
  'body',
  ARGV[3],
  'error',
  ARGV[4],
  'failedAt',
  ARGV[5]
)
redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
redis.call('XDEL', KEYS[1], ARGV[2])
redis.call('INCR', KEYS[3])
return 1
`;

const ACK_CANCELLED = `
redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
redis.call('XDEL', KEYS[1], ARGV[2])
return 1
`;

export interface RedisStreamWorkerConfig {
  appUrl: string;
  batchSize?: number;
  blockMs?: number;
  consumer: string;
  heartbeatTtlSeconds?: number;
  leaseMs?: number;
  prefix?: string;
  reclaimIntervalMs?: number;
  requestTimeoutMs?: number;
  token: string;
}

export interface RedisStreamWorkerDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  onError?: (error: unknown) => void;
  readRedis: Redis;
  redis: Redis;
}

const fieldsToRecord = (fields: string[]): Record<string, string> => {
  const record: Record<string, string> = {};
  for (let index = 0; index < fields.length; index += 2) {
    record[fields[index]] = fields[index + 1];
  }
  return record;
};

export const decodeRedisStreamEntry = (
  entry: StreamEntry,
): { envelope: RedisStreamQueueEnvelope; streamId: string } => {
  const [streamId, fields] = entry;
  const body = fieldsToRecord(fields).body;
  if (!body) throw new Error(`Redis Stream entry ${streamId} has no body`);

  const envelope = JSON.parse(body) as RedisStreamQueueEnvelope;
  if (!envelope.id || !envelope.message?.operationId || !envelope.message.endpoint) {
    throw new Error(`Redis Stream entry ${streamId} has an invalid envelope`);
  }

  return { envelope, streamId };
};

export const resolveWorkerEndpoint = (endpoint: string, appUrl: string): string => {
  const internalApp = new URL(appUrl);
  const queued = new URL(endpoint, internalApp);
  if (!queued.pathname.startsWith('/api/agent/')) {
    throw new Error(`Worker refuses non-Agent endpoint: ${queued.pathname}`);
  }

  return new URL(`${queued.pathname}${queued.search}`, internalApp).toString();
};

export const resolveRedisStreamRetryDelay = (deliveryAttempt: number): number =>
  Math.min(60_000, 1000 * 2 ** Math.max(0, deliveryAttempt));

/**
 * Consumer-group worker for RedisStreamQueueServiceImpl.
 *
 * HTTP delivery is at-least-once. While a request is active, XCLAIM refreshes
 * its idle time; after a worker crash another consumer can XAUTOCLAIM it. The
 * Agent Runtime's operation/step lock remains the final execute-once guard.
 */
export class RedisStreamWorker {
  readonly keys: RedisStreamQueueKeys;
  private readonly appUrl: string;
  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly consumer: string;
  private readonly fetchImpl: typeof fetch;
  private readonly heartbeatTtlSeconds: number;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;
  private readonly reclaimIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly token: string;
  private running = false;

  constructor(
    private readonly dependencies: RedisStreamWorkerDependencies,
    config: RedisStreamWorkerConfig,
  ) {
    if (!config.token) throw new Error('AGENT_WORKER_TOKEN is required');
    this.appUrl = config.appUrl;
    this.batchSize = config.batchSize ?? 10;
    this.blockMs = config.blockMs ?? 5000;
    this.consumer = config.consumer;
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.heartbeatTtlSeconds = config.heartbeatTtlSeconds ?? 15;
    this.keys = resolveRedisStreamQueueKeys(config.prefix);
    this.leaseMs = config.leaseMs ?? 90_000;
    this.now = dependencies.now ?? Date.now;
    this.onError = dependencies.onError ?? ((error) => console.error(error));
    this.reclaimIntervalMs = config.reclaimIntervalMs ?? 30_000;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15 * 60_000;
    this.token = config.token;
  }

  async ensureConsumerGroup(): Promise<void> {
    try {
      await this.dependencies.redis.xgroup(
        'CREATE',
        this.keys.stream,
        this.keys.group,
        '0',
        'MKSTREAM',
      );
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error;
    }
  }

  async promoteDueMessages(): Promise<number> {
    const result = await this.dependencies.redis.eval(
      PROMOTE_DUE_MESSAGES,
      2,
      this.keys.delayed,
      this.keys.stream,
      this.now().toString(),
      this.batchSize.toString(),
    );
    return Number(result) || 0;
  }

  async writeHeartbeat(): Promise<void> {
    await this.dependencies.redis.set(
      this.keys.heartbeat,
      this.consumer,
      'EX',
      this.heartbeatTtlSeconds,
    );
  }

  async processEntry(entry: StreamEntry): Promise<void> {
    let decoded: ReturnType<typeof decodeRedisStreamEntry>;
    try {
      decoded = decodeRedisStreamEntry(entry);
    } catch (error) {
      const [streamId, fields] = entry;
      await this.moveToDeadLetter(
        streamId,
        fieldsToRecord(fields).body ?? '{}',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const { envelope, streamId } = decoded;
    const cancelled = await this.dependencies.redis.get(
      `${this.keys.cancelledPrefix}${envelope.id}`,
    );
    if (cancelled) {
      await this.dependencies.redis.eval(
        ACK_CANCELLED,
        1,
        this.keys.stream,
        this.keys.group,
        streamId,
      );
      return;
    }

    const leaseHeartbeat = setInterval(
      () => {
        this.dependencies.redis
          .xclaim(
            this.keys.stream,
            this.keys.group,
            this.consumer,
            0,
            streamId,
            'IDLE',
            0,
            'JUSTID',
          )
          .catch(this.onError);
      },
      Math.max(1000, Math.floor(this.leaseMs / 3)),
    );

    try {
      const endpoint = resolveWorkerEndpoint(envelope.message.endpoint, this.appUrl);
      const response = await this.fetchImpl(endpoint, {
        body: JSON.stringify({
          context: envelope.message.context,
          operationId: envelope.message.operationId,
          payload: envelope.message.payload,
          priority: envelope.message.priority,
          stepIndex: envelope.message.stepIndex,
          timestamp: this.now(),
        }),
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'Upstash-Message-Id': envelope.id,
          'Upstash-Retried': envelope.deliveryAttempt.toString(),
          'X-Agent-Operation-Id': envelope.message.operationId,
          'X-Agent-Step-Index': envelope.message.stepIndex.toString(),
        },
        method: 'POST',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

      if (!response.ok) {
        const responseBody = (await response.text()).slice(0, 2000);
        throw new Error(
          `Agent worker delivery returned ${response.status}: ${responseBody || response.statusText}`,
        );
      }

      await this.dependencies.redis.eval(
        SETTLE_SUCCESS,
        2,
        this.keys.stream,
        this.keys.completedCount,
        this.keys.group,
        streamId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maxRetries = Math.max(0, envelope.message.retries ?? 3);
      if (envelope.deliveryAttempt < maxRetries) {
        const nextEnvelope: RedisStreamQueueEnvelope = {
          ...envelope,
          deliveryAttempt: envelope.deliveryAttempt + 1,
          enqueuedAt: this.now(),
        };
        const dueAt = this.now() + resolveRedisStreamRetryDelay(nextEnvelope.deliveryAttempt - 1);
        await this.dependencies.redis.eval(
          MOVE_TO_DELAYED,
          2,
          this.keys.stream,
          this.keys.delayed,
          this.keys.group,
          streamId,
          dueAt.toString(),
          JSON.stringify(nextEnvelope),
        );
      } else {
        await this.moveToDeadLetter(streamId, JSON.stringify(envelope), message);
      }
    } finally {
      clearInterval(leaseHeartbeat);
    }
  }

  async reclaimStaleMessages(): Promise<number> {
    const result = (await this.dependencies.redis.xautoclaim(
      this.keys.stream,
      this.keys.group,
      this.consumer,
      this.leaseMs,
      '0-0',
      'COUNT',
      this.batchSize,
    )) as unknown as [string, StreamEntry[]];
    const entries = result?.[1] ?? [];
    for (const entry of entries) await this.processEntry(entry);
    return entries.length;
  }

  async start(): Promise<void> {
    await this.ensureConsumerGroup();
    this.running = true;
    let lastReclaimAt = 0;

    while (this.running) {
      try {
        await this.writeHeartbeat();
        await this.promoteDueMessages();

        if (this.now() - lastReclaimAt >= this.reclaimIntervalMs) {
          await this.reclaimStaleMessages();
          lastReclaimAt = this.now();
        }

        const result = (await this.dependencies.readRedis.xreadgroup(
          'GROUP',
          this.keys.group,
          this.consumer,
          'COUNT',
          this.batchSize,
          'BLOCK',
          this.blockMs,
          'STREAMS',
          this.keys.stream,
          '>',
        )) as unknown as [string, StreamEntry[]][] | null;

        const entries = result?.[0]?.[1] ?? [];
        for (const entry of entries) await this.processEntry(entry);
      } catch (error) {
        this.onError(error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async moveToDeadLetter(streamId: string, body: string, error: string): Promise<void> {
    await this.dependencies.redis.eval(
      MOVE_TO_DEAD_LETTER,
      3,
      this.keys.stream,
      this.keys.deadLetter,
      this.keys.failedCount,
      this.keys.group,
      streamId,
      body,
      error.slice(0, 4000),
      new Date(this.now()).toISOString(),
    );
  }
}
