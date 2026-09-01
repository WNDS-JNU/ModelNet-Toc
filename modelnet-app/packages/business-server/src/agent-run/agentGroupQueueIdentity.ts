export interface AgentGroupQueuePreparation {
  attemptNo: number;
  deduplicationId: string;
  runId: string;
  runNodeId: string;
  source: 'agent_group';
  stepIndex: number;
}

export const deriveAgentGroupQueueDeduplicationId = (
  preparation: Pick<AgentGroupQueuePreparation, 'attemptNo' | 'runId' | 'runNodeId' | 'stepIndex'>,
) =>
  `agent-group:${preparation.runId}:${preparation.runNodeId}:attempt:${preparation.attemptNo}:step:${preparation.stepIndex}`;

export const createAgentGroupQueuePreparation = (
  preparation: Omit<AgentGroupQueuePreparation, 'deduplicationId' | 'source'>,
): AgentGroupQueuePreparation => ({
  ...preparation,
  deduplicationId: deriveAgentGroupQueueDeduplicationId(preparation),
  source: 'agent_group',
});

export const matchesAgentGroupQueuePreparation = (
  value: unknown,
  expected: AgentGroupQueuePreparation,
): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  if (
    keys.length !== 7 ||
    keys[0] !== 'attemptNo' ||
    keys[1] !== 'deduplicationId' ||
    keys[2] !== 'runId' ||
    keys[3] !== 'runNodeId' ||
    keys[4] !== 'source' ||
    keys[5] !== 'state' ||
    keys[6] !== 'stepIndex'
  ) {
    return false;
  }
  return (
    marker.source === expected.source &&
    marker.state === 'ready' &&
    marker.runId === expected.runId &&
    marker.runNodeId === expected.runNodeId &&
    marker.attemptNo === expected.attemptNo &&
    marker.stepIndex === expected.stepIndex &&
    marker.deduplicationId === expected.deduplicationId
  );
};
