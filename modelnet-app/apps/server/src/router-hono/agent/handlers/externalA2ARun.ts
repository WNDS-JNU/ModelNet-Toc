import { eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getServerDB } from '@/database/core/db-adaptor';
import { agentOperations } from '@/database/schemas';
import {
  ExternalAgentExecutionService,
  parseExternalAgentOperationMetadata,
} from '@/server/services/externalAgent';

/** Queue-authenticated outbound A2A execution entrypoint. */
export async function externalA2ARun(c: Context): Promise<Response> {
  let body: { operationId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof body.operationId !== 'string' || !body.operationId) {
    return c.json({ error: 'operationId is required' }, 400);
  }

  const db = await getServerDB();
  const operation = await db.query.agentOperations.findFirst({
    where: eq(agentOperations.id, body.operationId),
  });
  const metadata = parseExternalAgentOperationMetadata(operation?.metadata?.externalAgentExecution);
  if (!operation || !metadata) {
    return c.json({ error: 'External A2A operation not found' }, 404);
  }

  const result = await new ExternalAgentExecutionService(db, {
    id: metadata.collaboration.runId,
    userId: operation.userId,
    workspaceId: operation.workspaceId,
  }).execute(operation.id);
  return c.json({ operationId: operation.id, success: true, ...result });
}
