import { recordUpstashWorkflowEvent } from '@lobechat/observability-otel/modules/upstash-workflow';
import { errorNameFrom } from '@lobechat/utils';
import debug from 'debug';
import type { MiddlewareHandler } from 'hono';

import { verifyQStashSignature } from '@/libs/qstash';

const log = debug('lobe-server:agent:queue-worker-or-qstash-auth');

/**
 * Accepts either a QStash signature or the internal Redis Stream worker token.
 * The token path is restricted by routing to Agent Runtime steps and their
 * internal completion-bridge callbacks.
 */
export const queueWorkerOrQstashAuth = (): MiddlewareHandler => async (c, next) => {
  const rawBody = await c.req.text();
  const isValidQStash = await verifyQStashSignature(c.req.raw, rawBody);
  const workerToken = process.env.AGENT_WORKER_TOKEN;
  const isValidWorker =
    Boolean(workerToken) && c.req.header('authorization') === `Bearer ${workerToken}`;

  if (!isValidQStash && !isValidWorker) {
    log('Rejected: neither QStash nor Agent worker auth matched on %s', c.req.path);
    recordUpstashWorkflowEvent({
      errorType: 'InvalidSignature',
      interface: 'qstash',
      operation: 'serve',
      path: c.req.path,
      status: 'error',
    });
    return c.json({ error: 'Invalid queue delivery credentials' }, 401);
  }

  try {
    await next();
    if (isValidQStash) {
      recordUpstashWorkflowEvent({
        interface: 'qstash',
        operation: 'serve',
        path: c.req.path,
        status: 'success',
      });
    }
  } catch (error) {
    if (isValidQStash) {
      recordUpstashWorkflowEvent({
        errorType: errorNameFrom(error) ?? typeof error,
        interface: 'qstash',
        operation: 'serve',
        path: c.req.path,
        status: 'error',
      });
    }
    throw error;
  }
};
