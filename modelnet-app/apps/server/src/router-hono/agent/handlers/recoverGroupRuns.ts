import type { Context } from 'hono';

import { getServerDB } from '@/database/core/db-adaptor';
import { AgentGroupRunRecoveryCoordinator } from '@/server/services/agentGroupCollaboration/recovery';

const boundedLimit = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 100;
  return Math.min(Math.floor(parsed), 500);
};

/**
 * Run one durable collaboration recovery sweep inside the application server.
 *
 * The Redis Stream worker triggers this endpoint, but the application process
 * owns database/runtime construction. Keeping that boundary prevents the
 * standalone worker bundle from importing the complete AI service graph.
 */
export async function recoverGroupRuns(c: Context): Promise<Response> {
  if (!/^(?:1|true)$/i.test(process.env.AGENT_GROUP_DURABLE_RUNS ?? '')) {
    return c.json({ enabled: false, skipped: true });
  }

  let body: { limit?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    // An empty body is valid and uses the conservative default batch size.
  }

  const db = await getServerDB();
  const result = await new AgentGroupRunRecoveryCoordinator(db, {
    limit: boundedLimit(body.limit),
  }).sweepOnce();

  return c.json({ enabled: true, ...result });
}
