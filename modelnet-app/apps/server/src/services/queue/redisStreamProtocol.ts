import type { QueueMessage } from './types';

export interface RedisStreamQueueEnvelope {
  deliveryAttempt: number;
  enqueuedAt: number;
  id: string;
  message: QueueMessage;
}

export interface RedisStreamQueueKeys {
  cancelledPrefix: string;
  completedCount: string;
  deadLetter: string;
  deduplicationPrefix: string;
  delayed: string;
  failedCount: string;
  group: string;
  heartbeat: string;
  stream: string;
}

export const resolveRedisStreamQueueKeys = (prefix = 'lobechat'): RedisStreamQueueKeys => {
  const normalizedPrefix = prefix.replace(/:+$/, '') || 'lobechat';
  const root = `${normalizedPrefix}:agent-runtime`;

  return {
    cancelledPrefix: `${root}:cancelled:`,
    completedCount: `${root}:completed-count`,
    deadLetter: `${root}:dead-letter`,
    deduplicationPrefix: `${root}:dedupe:`,
    delayed: `${root}:delayed`,
    failedCount: `${root}:failed-count`,
    group: `${root}:workers`,
    heartbeat: `${root}:worker-heartbeat`,
    stream: `${root}:queue`,
  };
};
