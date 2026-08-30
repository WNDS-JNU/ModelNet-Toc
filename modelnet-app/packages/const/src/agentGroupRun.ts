/** Explicit collaboration protocols persisted on an Agent Group Run. */
export const agentGroupRunProtocols = [
  'single',
  'broadcast',
  'parallel_tasks',
  'pipeline',
  'debate',
] as const;

export type AgentGroupRunProtocol = (typeof agentGroupRunProtocols)[number];

/** Lifecycle of the collaboration run as a whole. */
export const agentGroupRunStatuses = [
  'pending',
  'running',
  'waiting',
  'cancelling',
  'cancelled',
  'completed',
  'failed',
] as const;

export type AgentGroupRunStatus = (typeof agentGroupRunStatuses)[number];

/** Lifecycle of one stable node in the persisted collaboration plan. */
export const agentGroupRunNodeStatuses = [
  'pending',
  'ready',
  'running',
  'waiting',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'skipped',
] as const;

export type AgentGroupRunNodeStatus = (typeof agentGroupRunNodeStatuses)[number];

/** Lifecycle of one concrete execution attempt for a plan node. */
export const agentGroupRunAttemptStatuses = [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const;

export type AgentGroupRunAttemptStatus = (typeof agentGroupRunAttemptStatuses)[number];
