import { hostname } from 'node:os';

import Redis from 'ioredis';

import { resolveRedisStreamQueueKeys } from './redisStreamProtocol';
import { RedisStreamWorker } from './RedisStreamWorker';

const integerFromEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is required for the Agent worker');

const createRedis = () =>
  new Redis(redisUrl, {
    connectTimeout: 5000,
    maxRetriesPerRequest: null,
  });

if (process.argv.includes('--healthcheck')) {
  const redis = new Redis(redisUrl, {
    connectTimeout: 3000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await redis.connect();
    const heartbeat = await redis.get(
      resolveRedisStreamQueueKeys(process.env.REDIS_PREFIX).heartbeat,
    );
    process.exitCode = heartbeat ? 0 : 1;
  } finally {
    redis.disconnect();
  }
} else {
  const redis = createRedis();
  const readRedis = createRedis();
  const appUrl = process.env.AGENT_WORKER_APP_URL ?? 'http://modelnet-app:3210';
  const token = process.env.AGENT_WORKER_TOKEN ?? '';
  const worker = new RedisStreamWorker(
    {
      onError: (error) => console.error('[agent-worker]', error),
      readRedis,
      redis,
    },
    {
      appUrl,
      batchSize: integerFromEnv('AGENT_WORKER_BATCH_SIZE', 10),
      blockMs: integerFromEnv('AGENT_WORKER_BLOCK_MS', 5000),
      consumer: process.env.AGENT_WORKER_CONSUMER ?? `${hostname()}-${process.pid}`,
      heartbeatTtlSeconds: integerFromEnv('AGENT_WORKER_HEARTBEAT_TTL_SECONDS', 15),
      leaseMs: integerFromEnv('AGENT_WORKER_LEASE_MS', 90_000),
      prefix: process.env.REDIS_PREFIX,
      reclaimIntervalMs: integerFromEnv('AGENT_WORKER_RECLAIM_INTERVAL_MS', 30_000),
      requestTimeoutMs: integerFromEnv('AGENT_WORKER_REQUEST_TIMEOUT_MS', 15 * 60_000),
      token,
    },
  );

  const durableRunsEnabled = /^(?:1|true)$/i.test(process.env.AGENT_GROUP_DURABLE_RUNS ?? '');
  const recoverySweepIntervalMs = integerFromEnv('AGENT_GROUP_RECOVERY_SWEEP_INTERVAL_MS', 30_000);
  let recoverySweepRunning = false;
  const sweepRecovery = async () => {
    if (!durableRunsEnabled || recoverySweepRunning) return;
    recoverySweepRunning = true;
    try {
      const response = await fetch(`${appUrl}/api/agent/recover-group-runs`, {
        body: JSON.stringify({
          limit: integerFromEnv('AGENT_GROUP_RECOVERY_SWEEP_BATCH_SIZE', 100),
        }),
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`Recovery endpoint returned HTTP ${response.status}`);
      }
      const result = (await response.json()) as {
        cancelled?: number;
        dispatched?: number;
        failedRunIds?: string[];
        reconciled?: number;
      };
      if (
        result.dispatched ||
        result.reconciled ||
        result.cancelled ||
        result.failedRunIds?.length
      ) {
        console.info('[agent-worker] collaboration recovery sweep', result);
      }
    } catch (error) {
      console.error('[agent-worker] collaboration recovery sweep failed', error);
    } finally {
      recoverySweepRunning = false;
    }
  };
  const recoveryTimer = setInterval(sweepRecovery, recoverySweepIntervalMs);
  recoveryTimer.unref();
  void sweepRecovery();

  const shutdown = async () => {
    clearInterval(recoveryTimer);
    worker.stop();
    await Promise.all([
      redis.quit().catch(() => redis.disconnect()),
      readRedis.quit().catch(() => readRedis.disconnect()),
    ]);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await worker.start();
}
