export const A2A_TASK_STATES = [
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
] as const;

export type A2ATaskState = (typeof A2A_TASK_STATES)[number];

export interface A2APart {
  data?: unknown;
  filename?: string;
  mediaType?: string;
  raw?: string;
  text?: string;
  url?: string;
}

export interface A2AMessage {
  contextId?: string;
  messageId: string;
  parts: A2APart[];
  role: 'ROLE_AGENT' | 'ROLE_USER';
  taskId?: string;
}

export interface A2AArtifact {
  artifactId: string;
  description?: string;
  name?: string;
  parts: A2APart[];
}

export interface A2ATaskStatus {
  message?: A2AMessage;
  state: A2ATaskState;
  timestamp?: string;
}

export interface A2ATask {
  artifacts?: A2AArtifact[];
  contextId: string;
  history?: A2AMessage[];
  id: string;
  status: A2ATaskStatus;
}

export interface A2AStreamResponse {
  artifactUpdate?: {
    artifact: A2AArtifact;
    contextId?: string;
    taskId: string;
  };
  message?: A2AMessage;
  statusUpdate?: {
    contextId?: string;
    status: A2ATaskStatus;
    taskId: string;
  };
  task?: A2ATask;
}

export interface ExternalAgentArtifactSnapshot {
  artifactId: string;
  content: string;
  description?: string;
  mediaTypes: string[];
  name?: string;
}

export type ExternalAgentExecutionOutcome =
  'auth_required' | 'cancelled' | 'completed' | 'failed' | 'input_required';

export interface ExternalAgentExecutionResult {
  artifacts: ExternalAgentArtifactSnapshot[];
  contextId?: string;
  outcome: ExternalAgentExecutionOutcome;
  statusMessage?: string;
  summary?: string;
  taskId?: string;
}

export interface ExternalAgentExecuteInput {
  contextId?: string;
  instruction: string;
  messageId: string;
  taskId?: string;
}

export interface ExternalAgentExecutionHooks {
  onTaskBound?: (ref: { contextId?: string; taskId: string }) => Promise<void> | void;
}
