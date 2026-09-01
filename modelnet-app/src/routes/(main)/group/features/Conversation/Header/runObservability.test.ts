import { describe, expect, it } from 'vitest';

import { buildAgentGroupRunObservability } from './runObservability';

describe('buildAgentGroupRunObservability', () => {
  it('deduplicates operations and summarizes durable run evidence', () => {
    const summary = buildAgentGroupRunObservability(
      {
        attempts: [
          {
            error: { code: 'DEVICE_OFFLINE' },
            operationId: 'op-1',
            outputSnapshot: {
              verifyRunId: 'verify-1',
              workVersionRefs: [{ workVersionId: 'version-1' }],
            },
            runtimeKind: 'heterogeneous',
            status: 'failed',
          },
          {
            operationId: 'op-1',
            outputSnapshot: {
              verifyRunId: 'verify-1',
              workVersionRefs: [{ workVersionId: 'version-1' }],
            },
            runtimeKind: 'heterogeneous',
            status: 'completed',
          },
        ],
        nodes: [
          {
            dispatchClaimExpiresAt: '2026-09-01T00:01:00.000Z',
            dispatchClaimId: 'claim-1',
            status: 'waiting',
          },
        ],
        operations: [
          {
            currency: 'USD',
            humanInterventions: 1,
            humanWaitingTimeMs: 250,
            id: 'op-1',
            llmCalls: 2,
            processingTimeMs: 1000,
            toolCalls: 3,
            totalCost: '0.125',
            totalTokens: 42,
            traceS3Key: 'traces/op-1.json',
          },
        ],
      },
      [{ type: 'node.dispatch_lease_expired' }],
      Date.parse('2026-09-01T00:00:00.000Z'),
    );

    expect(summary).toMatchObject({
      activeLeaseCount: 1,
      attemptCount: 2,
      deviceOfflineCount: 1,
      expiredLeaseCount: 1,
      failedAttemptCount: 1,
      humanInterventionCount: 1,
      humanWaitingTimeMs: 250,
      llmCallCount: 2,
      processingTimeMs: 1000,
      remoteFailureCount: 1,
      toolCallCount: 3,
      totalCost: 0.125,
      totalTokens: 42,
      traceCount: 1,
      waitingBarrierCount: 1,
    });
    expect(summary.verifyRunIds).toEqual(['verify-1']);
    expect(summary.workVersionIds).toEqual(['version-1']);
  });
});
