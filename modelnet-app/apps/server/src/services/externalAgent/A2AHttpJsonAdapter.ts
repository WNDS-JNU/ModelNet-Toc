import { randomUUID } from 'node:crypto';

import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import type { ExternalAgentTrustPolicy } from '@lobechat/types';

import type { ExternalAgentBindingItem } from '@/database/schemas';

import {
  assertExternalAgentBindingPolicy,
  normalizeExternalAgentEndpoint,
  resolveExternalAgentCredential,
} from './trust';
import type {
  A2AArtifact,
  A2AMessage,
  A2AStreamResponse,
  A2ATask,
  A2ATaskState,
  ExternalAgentArtifactSnapshot,
  ExternalAgentExecuteInput,
  ExternalAgentExecutionHooks,
  ExternalAgentExecutionOutcome,
  ExternalAgentExecutionResult,
} from './types';
import { A2A_TASK_STATES } from './types';

type SafeFetch = typeof ssrfSafeFetch;
type Sleep = (ms: number) => Promise<void>;

const TERMINAL_STATES = new Set<A2ATaskState>([
  'TASK_STATE_AUTH_REQUIRED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
]);

const MAX_ARTIFACTS = 50;
const MAX_ARTIFACT_CONTENT_CHARS = 200_000;
const MAX_SUMMARY_CHARS = 16_000;
const TASK_STATES = new Set<string>(A2A_TASK_STATES);

export class A2AHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'A2AHttpError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const partText = (part: unknown): string => {
  if (!isRecord(part)) return '';
  if (typeof part.text === 'string') return part.text;
  if (part.data !== undefined) return JSON.stringify(part.data) ?? '';
  if (typeof part.url === 'string') {
    try {
      const url = new URL(part.url);
      return `[remote file reference: ${url.origin}${url.pathname}]`;
    } catch {
      return '[remote file reference omitted]';
    }
  }
  if (typeof part.raw === 'string') return `[inline ${String(part.mediaType ?? 'binary')} data]`;
  return '';
};

const messageText = (message: unknown): string | undefined => {
  if (!isRecord(message) || !Array.isArray(message.parts)) return undefined;
  const text = message.parts.map(partText).filter(Boolean).join('\n').trim();
  return text ? text.slice(0, MAX_SUMMARY_CHARS) : undefined;
};

const normalizeArtifacts = (
  artifacts: A2AArtifact[] | undefined,
): ExternalAgentArtifactSnapshot[] =>
  (artifacts ?? []).slice(0, MAX_ARTIFACTS).map((artifact) => ({
    artifactId: artifact.artifactId,
    content: artifact.parts
      .map(partText)
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_ARTIFACT_CONTENT_CHARS),
    description: artifact.description,
    mediaTypes: [
      ...new Set(
        artifact.parts
          .map((part) => part.mediaType)
          .filter((value): value is string => typeof value === 'string'),
      ),
    ],
    name: artifact.name,
  }));

const stateOutcome = (state: A2ATaskState): ExternalAgentExecutionOutcome | undefined => {
  switch (state) {
    case 'TASK_STATE_AUTH_REQUIRED': {
      return 'auth_required';
    }
    case 'TASK_STATE_CANCELED': {
      return 'cancelled';
    }
    case 'TASK_STATE_COMPLETED': {
      return 'completed';
    }
    case 'TASK_STATE_INPUT_REQUIRED': {
      return 'input_required';
    }
    case 'TASK_STATE_FAILED':
    case 'TASK_STATE_REJECTED': {
      return 'failed';
    }
    default: {
      return undefined;
    }
  }
};

const taskResult = (task: A2ATask): ExternalAgentExecutionResult => ({
  artifacts: normalizeArtifacts(task.artifacts),
  contextId: task.contextId,
  outcome: stateOutcome(task.status.state) ?? 'failed',
  statusMessage: messageText(task.status.message),
  summary:
    [...(task.history ?? [])].reverse().map(messageText).find(Boolean) ??
    messageText(task.status.message),
  taskId: task.id,
});

const messageResult = (message: A2AMessage): ExternalAgentExecutionResult => ({
  artifacts: [],
  contextId: message.contextId,
  outcome: 'completed',
  summary: messageText(message),
  taskId: message.taskId,
});

const parseSse = (body: string): unknown[] => {
  const values: unknown[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const payload = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!payload || payload === '[DONE]') continue;
    values.push(JSON.parse(payload));
  }
  return values;
};

const streamResult = (events: unknown[]): ExternalAgentExecutionResult => {
  let task: A2ATask | undefined;
  let message: A2AMessage | undefined;
  const artifacts = new Map<string, A2AArtifact>();
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (isRecord(event.task)) {
      task = event.task as unknown as A2ATask;
      for (const artifact of task.artifacts ?? []) artifacts.set(artifact.artifactId, artifact);
    }
    if (isRecord(event.message)) message = event.message as unknown as A2AMessage;
    if (isRecord(event.artifactUpdate) && isRecord(event.artifactUpdate.artifact)) {
      const artifact = event.artifactUpdate.artifact as unknown as A2AArtifact;
      artifacts.set(artifact.artifactId, artifact);
    }
    if (isRecord(event.statusUpdate) && isRecord(event.statusUpdate.status)) {
      const update = event.statusUpdate as unknown as NonNullable<
        A2AStreamResponse['statusUpdate']
      >;
      task = {
        artifacts: [...artifacts.values()],
        contextId: update.contextId ?? task?.contextId ?? '',
        history: task?.history,
        id: update.taskId,
        status: update.status,
      };
    }
  }
  if (task && TERMINAL_STATES.has(task.status.state)) return taskResult(task);
  if (message) return messageResult(message);
  throw new Error('A2A stream ended without a terminal or interrupted result.');
};

export class A2AHttpJsonAdapter {
  private readonly endpoint: string;
  private readonly policy: ExternalAgentTrustPolicy;

  constructor(
    private readonly binding: ExternalAgentBindingItem,
    private readonly fetchImpl: SafeFetch = ssrfSafeFetch,
    private readonly sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    if (
      binding.protocolVersion !== '1.0' ||
      binding.transportProfile !== 'http-json' ||
      !binding.enabled
    ) {
      throw new Error('A2A binding is disabled or uses an unsupported profile.');
    }
    this.endpoint = normalizeExternalAgentEndpoint(binding.endpointUrl);
    this.policy = assertExternalAgentBindingPolicy(this.endpoint, binding.trustPolicy);
  }

  cancelTask = async (taskId: string): Promise<ExternalAgentExecutionResult> => {
    const value = await this.requestJson(`tasks/${encodeURIComponent(taskId)}:cancel`, {
      body: '{}',
      method: 'POST',
    });
    return taskResult(this.parseTask(value));
  };

  execute = async (
    input: ExternalAgentExecuteInput,
    hooks: ExternalAgentExecutionHooks = {},
  ): Promise<ExternalAgentExecutionResult> => {
    if (this.binding.interactionMode === 'stream') {
      try {
        const result = await this.stream(input);
        if (result.taskId)
          await hooks.onTaskBound?.({ contextId: result.contextId, taskId: result.taskId });
        return result;
      } catch (error) {
        if (!(error instanceof A2AHttpError) || ![404, 405, 501].includes(error.status))
          throw error;
      }
    }
    return this.sendAndPoll(input, hooks);
  };

  getTask = async (taskId: string): Promise<A2ATask> =>
    this.parseTask(
      await this.requestJson(`tasks/${encodeURIComponent(taskId)}`, { method: 'GET' }),
    );

  private buildRequest(input: ExternalAgentExecuteInput, returnImmediately: boolean) {
    return {
      configuration: {
        acceptedOutputModes: ['text/plain', 'application/json'],
        returnImmediately,
      },
      message: {
        ...(input.contextId ? { contextId: input.contextId } : {}),
        messageId: input.messageId || randomUUID(),
        parts: [{ text: input.instruction }],
        role: 'ROLE_USER',
        ...(input.taskId ? { taskId: input.taskId } : {}),
      },
    };
  }

  private headers = (): Record<string, string> => {
    const headers: Record<string, string> = {
      'A2A-Version': '1.0',
      'Accept': 'application/a2a+json, application/json',
      'Content-Type': 'application/a2a+json',
    };
    if (this.binding.authScheme === 'bearer') {
      if (!this.binding.credentialRef) throw new Error('A2A credentialRef is missing.');
      headers.Authorization = `Bearer ${resolveExternalAgentCredential(this.binding.credentialRef)}`;
    }
    return headers;
  };

  private parseSendResponse(value: unknown): A2AMessage | A2ATask {
    if (!isRecord(value)) throw new Error('A2A send response is not an object.');
    if (isRecord(value.task)) return this.parseTask(value.task);
    if (isRecord(value.message)) return value.message as unknown as A2AMessage;
    throw new Error('A2A send response has neither task nor message.');
  }

  private parseTask(value: unknown): A2ATask {
    if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.status)) {
      throw new Error('A2A task response is invalid.');
    }
    const state = value.status.state;
    if (typeof state !== 'string' || !TASK_STATES.has(state)) {
      throw new Error('A2A task state is invalid.');
    }
    return value as unknown as A2ATask;
  }

  private request = async (path: string, init: RequestInit): Promise<Response> => {
    // Prefix with ./ so A2A action names such as `message:send` are paths, not URL schemes.
    const url = new URL(`./${path}`, this.endpoint);
    if (url.origin !== this.policy.allowedOrigin)
      throw new Error('A2A request escaped its origin.');
    const headers = new Headers(this.headers());
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const response = await this.fetchImpl(
      url.toString(),
      {
        ...init,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.policy.requestTimeoutMs),
      },
      {
        allowPrivateIPAddress: this.policy.allowPrivateNetwork,
        maxContentLength: this.policy.maxResponseBytes + 1,
      },
    );
    if (response.status >= 300 && response.status < 400) {
      throw new A2AHttpError(response.status, 'A2A endpoint redirects are forbidden.');
    }
    if (!response.ok) {
      throw new A2AHttpError(response.status, `A2A endpoint returned HTTP ${response.status}.`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.policy.maxResponseBytes) {
      throw new Error('A2A response exceeded the configured size limit.');
    }
    return response;
  };

  private requestJson = async (path: string, init: RequestInit): Promise<unknown> => {
    const response = await this.request(path, init);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('json'))
      throw new Error('A2A endpoint returned a non-JSON response.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.policy.maxResponseBytes) {
      throw new Error('A2A response exceeded the configured size limit.');
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  };

  private sendAndPoll = async (
    input: ExternalAgentExecuteInput,
    hooks: ExternalAgentExecutionHooks,
  ): Promise<ExternalAgentExecutionResult> => {
    const response = this.parseSendResponse(
      await this.requestJson('message:send', {
        body: JSON.stringify(this.buildRequest(input, true)),
        method: 'POST',
      }),
    );
    if ('messageId' in response) return messageResult(response);
    await hooks.onTaskBound?.({ contextId: response.contextId, taskId: response.id });
    if (TERMINAL_STATES.has(response.status.state)) return taskResult(response);

    const deadline = Date.now() + this.policy.requestTimeoutMs;
    let task = response;
    while (Date.now() < deadline) {
      await this.sleep(500);
      task = await this.getTask(task.id);
      if (TERMINAL_STATES.has(task.status.state)) return taskResult(task);
    }
    throw new Error('A2A task polling timed out.');
  };

  private stream = async (
    input: ExternalAgentExecuteInput,
  ): Promise<ExternalAgentExecutionResult> => {
    const response = await this.request('message:stream', {
      body: JSON.stringify(this.buildRequest(input, false)),
      headers: { Accept: 'text/event-stream' },
      method: 'POST',
    });
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('text/event-stream')) {
      throw new Error('A2A stream endpoint returned a non-SSE response.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.policy.maxResponseBytes) {
      throw new Error('A2A stream exceeded the configured size limit.');
    }
    return streamResult(parseSse(new TextDecoder().decode(bytes)));
  };
}
