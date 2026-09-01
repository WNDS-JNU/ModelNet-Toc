interface RunAttemptObservation {
  error?: { code?: string } | null;
  operationId: string;
  outputSnapshot?: {
    verifyRunId?: string;
    workVersionRefs?: { workVersionId: string }[];
  } | null;
  runtimeKind: string;
  status: string;
}

interface RunEventObservation {
  type: string;
}

interface RunNodeObservation {
  dispatchClaimExpiresAt?: Date | string | null;
  dispatchClaimId?: string | null;
  status: string;
}

interface RunOperationObservation {
  currency?: string | null;
  humanInterventions?: number | null;
  humanWaitingTimeMs?: number | null;
  id: string;
  llmCalls?: number | null;
  processingTimeMs?: number | null;
  toolCalls?: number | null;
  totalCost?: number | string | null;
  totalTokens?: number | null;
  traceS3Key?: string | null;
}

export interface AgentGroupRunObservability {
  activeLeaseCount: number;
  attemptCount: number;
  currencies: string[];
  deviceOfflineCount: number;
  expiredLeaseCount: number;
  failedAttemptCount: number;
  humanInterventionCount: number;
  humanWaitingTimeMs: number;
  llmCallCount: number;
  processingTimeMs: number;
  remoteFailureCount: number;
  toolCallCount: number;
  totalCost: number;
  totalTokens: number;
  traceCount: number;
  verifyRunIds: string[];
  waitingBarrierCount: number;
  workVersionIds: string[];
}

export const buildAgentGroupRunObservability = (
  snapshot: {
    attempts: RunAttemptObservation[];
    nodes: RunNodeObservation[];
    operations: RunOperationObservation[];
  },
  events: RunEventObservation[] = [],
  now = Date.now(),
): AgentGroupRunObservability => {
  const operations = [
    ...new Map(snapshot.operations.map((operation) => [operation.id, operation])).values(),
  ];
  const verifyRunIds = new Set<string>();
  const workVersionIds = new Set<string>();

  for (const attempt of snapshot.attempts) {
    const output = attempt.outputSnapshot;
    if (output?.verifyRunId) verifyRunIds.add(output.verifyRunId);
    for (const reference of output?.workVersionRefs ?? []) {
      workVersionIds.add(reference.workVersionId);
    }
  }

  return {
    activeLeaseCount: snapshot.nodes.filter((node) => {
      if (!node.dispatchClaimId || !node.dispatchClaimExpiresAt) return false;
      return new Date(node.dispatchClaimExpiresAt).getTime() > now;
    }).length,
    attemptCount: snapshot.attempts.length,
    currencies: [
      ...new Set(operations.map(({ currency }) => currency).filter(Boolean) as string[]),
    ],
    deviceOfflineCount: snapshot.attempts.filter(({ error }) =>
      ['DEVICE_DISCONNECTED', 'DEVICE_OFFLINE', 'DEVICE_REQUEST_TIMEOUT'].includes(
        error?.code ?? '',
      ),
    ).length,
    expiredLeaseCount: events.filter(({ type }) => type === 'node.dispatch_lease_expired').length,
    failedAttemptCount: snapshot.attempts.filter(({ status }) =>
      ['failed', 'timed_out'].includes(status),
    ).length,
    humanInterventionCount: operations.reduce(
      (total, operation) => total + (operation.humanInterventions ?? 0),
      0,
    ),
    humanWaitingTimeMs: operations.reduce(
      (total, operation) => total + (operation.humanWaitingTimeMs ?? 0),
      0,
    ),
    llmCallCount: operations.reduce((total, operation) => total + (operation.llmCalls ?? 0), 0),
    processingTimeMs: operations.reduce(
      (total, operation) => total + (operation.processingTimeMs ?? 0),
      0,
    ),
    remoteFailureCount: snapshot.attempts.filter(
      ({ runtimeKind, status }) =>
        runtimeKind !== 'normal' && ['failed', 'timed_out'].includes(status),
    ).length,
    toolCallCount: operations.reduce((total, operation) => total + (operation.toolCalls ?? 0), 0),
    totalCost: operations.reduce(
      (total, operation) => total + (Number(operation.totalCost) || 0),
      0,
    ),
    totalTokens: operations.reduce((total, operation) => total + (operation.totalTokens ?? 0), 0),
    traceCount: operations.filter(({ traceS3Key }) => Boolean(traceS3Key)).length,
    verifyRunIds: [...verifyRunIds],
    waitingBarrierCount: snapshot.nodes.filter(({ status }) => status === 'waiting').length,
    workVersionIds: [...workVersionIds],
  };
};
