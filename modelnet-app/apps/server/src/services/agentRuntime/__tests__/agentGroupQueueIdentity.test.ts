// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  createAgentGroupQueuePreparation,
  deriveAgentGroupQueueDeduplicationId,
  matchesAgentGroupQueuePreparation,
} from '@/business/server/agent-run/agentGroupQueueIdentity';

describe('agent group queue identity', () => {
  it('derives one stable provider dedupe key from durable Attempt lineage', () => {
    const preparation = createAgentGroupQueuePreparation({
      attemptNo: 2,
      runId: 'run-1',
      runNodeId: 'node-1',
      stepIndex: 0,
    });
    expect(preparation).toEqual({
      attemptNo: 2,
      deduplicationId: 'agent-group:run-1:node-1:attempt:2:step:0',
      runId: 'run-1',
      runNodeId: 'node-1',
      source: 'agent_group',
      stepIndex: 0,
    });
    expect(deriveAgentGroupQueueDeduplicationId(preparation)).toBe(preparation.deduplicationId);
  });

  it('matches only the exact ready marker', () => {
    const preparation = createAgentGroupQueuePreparation({
      attemptNo: 1,
      runId: 'run-1',
      runNodeId: 'node-1',
      stepIndex: 0,
    });
    expect(matchesAgentGroupQueuePreparation({ ...preparation, state: 'ready' }, preparation)).toBe(
      true,
    );
    expect(
      matchesAgentGroupQueuePreparation(
        { ...preparation, runNodeId: 'node-other', state: 'ready' },
        preparation,
      ),
    ).toBe(false);
    expect(
      matchesAgentGroupQueuePreparation(
        { ...preparation, state: 'ready', unexpectedAuthority: true },
        preparation,
      ),
    ).toBe(false);
  });
});
