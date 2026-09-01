import { createHash } from 'node:crypto';

import type { AgentState } from '@lobechat/agent-runtime';

import type {
  AgentGroupRunDispatchClaim,
  AgentGroupRunSnapshot,
  RecoverableAgentGroupRunRef,
} from '@/database/models/agentGroupRun';
import { AgentInterventionModel } from '@/database/models/agentIntervention';
import { AgentOperationModel } from '@/database/models/agentOperation';
import { ExternalAgentBindingModel } from '@/database/models/externalAgentBinding';
import { WorkModel } from '@/database/models/work';
import type { ExternalAgentBindingItem } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { AgentGroupCollaborationService } from '@/server/services/agentGroupCollaboration';
import type { AgentGroupPipelineLaunchBridge } from '@/server/services/agentGroupCollaboration/pipelineDispatcher';
import { AiAgentService } from '@/server/services/aiAgent';
import { QueueService } from '@/server/services/queue';

import { A2AHttpJsonAdapter } from './A2AHttpJsonAdapter';

const EXTERNAL_EXECUTION_ENDPOINT = '/api/agent/external-a2a-run';

export interface ExternalAgentOperationMetadata {
  agentId: string;
  bindingId: string;
  bridge: AgentGroupPipelineLaunchBridge;
  collaboration: {
    attemptNo: number;
    runId: string;
    runNodeId: string;
    runtimeKind: 'external';
  };
  continuationNo?: number;
  dispatch: {
    deduplicationId: string;
    messageId?: string;
    scheduledAt?: string;
    state: 'ready' | 'scheduled';
  };
  instruction: string;
  kind: 'a2a-outbound-v1';
  remote?: { contextId?: string; taskId: string };
  topicId?: string;
}

export interface PrepareExternalAgentOperationParams {
  bridge: AgentGroupPipelineLaunchBridge;
  claim: AgentGroupRunDispatchClaim;
  instruction: string;
  snapshot: AgentGroupRunSnapshot;
}

export interface PreparedExternalAgentOperation {
  executionTargetSnapshot: Record<string, unknown>;
  operationId: string;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const operationIdFor = (runId: string, runNodeId: string, attemptNo: number): string =>
  `op_a2a_${digest(`${runId}:${runNodeId}:${attemptNo}`).slice(0, 32)}`;
const dispatchIdFor = (operationId: string): string => `agent-group:a2a:${operationId}`;
const safeError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4000);

export const parseExternalAgentOperationMetadata = (
  value: unknown,
): ExternalAgentOperationMetadata | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const metadata = value as Partial<ExternalAgentOperationMetadata>;
  if (
    metadata.kind !== 'a2a-outbound-v1' ||
    typeof metadata.agentId !== 'string' ||
    typeof metadata.bindingId !== 'string' ||
    typeof metadata.instruction !== 'string' ||
    !metadata.bridge ||
    !metadata.collaboration ||
    metadata.collaboration.runtimeKind !== 'external' ||
    !metadata.dispatch ||
    !['ready', 'scheduled'].includes(metadata.dispatch.state ?? '') ||
    typeof metadata.dispatch.deduplicationId !== 'string'
  ) {
    return undefined;
  }
  return metadata as ExternalAgentOperationMetadata;
};

const publicBindingSnapshot = (binding: ExternalAgentBindingItem) => ({
  bindingId: binding.id,
  endpointOrigin: new URL(binding.endpointUrl).origin,
  interactionMode: binding.interactionMode,
  protocolVersion: binding.protocolVersion,
  transportProfile: binding.transportProfile,
});

/** Durable A2A producer using the same AgentOperation/Run/Node/Attempt control plane. */
export class ExternalAgentExecutionService {
  private readonly bindingModel: ExternalAgentBindingModel;
  private readonly collaborationService: AgentGroupCollaborationService;
  private readonly operationModel: AgentOperationModel;
  private readonly queue: QueueService;

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly owner: RecoverableAgentGroupRunRef,
    queue = new QueueService(),
  ) {
    this.bindingModel = new ExternalAgentBindingModel(
      db,
      owner.userId,
      owner.workspaceId ?? undefined,
    );
    this.collaborationService = new AgentGroupCollaborationService(
      db,
      owner.userId,
      owner.workspaceId ?? undefined,
    );
    this.operationModel = new AgentOperationModel(db, owner.userId, owner.workspaceId ?? undefined);
    this.queue = queue;
  }

  prepare = async (
    params: PrepareExternalAgentOperationParams,
  ): Promise<PreparedExternalAgentOperation> => {
    const agentId = params.claim.node.agentId;
    if (!agentId) throw new Error('External A2A node has no local Agent identity.');
    const binding = await this.bindingModel.findEnabledByAgentId(agentId);
    if (!binding) throw new Error('External A2A Agent binding is missing or disabled.');

    // Construction revalidates the current deployment trust ceiling before any durable dispatch.
    new A2AHttpJsonAdapter(binding);
    const operationId = operationIdFor(
      params.snapshot.run.id,
      params.claim.node.id,
      params.claim.attemptNo,
    );
    const metadata: ExternalAgentOperationMetadata = {
      agentId,
      bindingId: binding.id,
      bridge: params.bridge,
      collaboration: {
        attemptNo: params.claim.attemptNo,
        runId: params.snapshot.run.id,
        runNodeId: params.claim.node.id,
        runtimeKind: 'external',
      },
      dispatch: {
        deduplicationId: dispatchIdFor(operationId),
        state: 'ready',
      },
      instruction: params.instruction,
      kind: 'a2a-outbound-v1',
      topicId: params.snapshot.run.topicId ?? undefined,
    };
    await this.operationModel.recordStart({
      agentId,
      chatGroupId: params.snapshot.run.chatGroupId,
      metadata: { externalAgentExecution: metadata },
      operationId,
      parentOperationId: params.bridge.parentOperationId,
      provider: 'a2a',
      topicId: params.snapshot.run.topicId,
      trigger: 'agent_group_external',
    });

    return {
      executionTargetSnapshot: {
        ...publicBindingSnapshot(binding),
        kind: 'external_a2a',
      },
      operationId,
    };
  };

  ensureScheduled = async (operationId: string): Promise<'already_started' | 'scheduled'> => {
    if (this.queue.isLocalExecution()) {
      throw new Error('External A2A execution requires a distributed queue.');
    }
    const operation = await this.operationModel.findById(operationId);
    const metadata = parseExternalAgentOperationMetadata(
      operation?.metadata?.externalAgentExecution,
    );
    if (!metadata) throw new Error(`External A2A operation metadata is invalid: ${operationId}`);
    if (metadata.dispatch.state === 'scheduled') return 'already_started';

    const messageId = await this.queue.scheduleMessage({
      deduplicationId: metadata.dispatch.deduplicationId,
      endpoint: EXTERNAL_EXECUTION_ENDPOINT,
      operationId,
      priority: 'high',
      retries: 8,
      retryDelay: '5s',
      stepIndex: 0,
    });
    const updated: ExternalAgentOperationMetadata = {
      ...metadata,
      dispatch: {
        ...metadata.dispatch,
        messageId,
        scheduledAt: new Date().toISOString(),
        state: 'scheduled',
      },
    };
    if (
      !(await this.operationModel.mergeMetadata(operationId, { externalAgentExecution: updated }))
    ) {
      throw new Error(`External A2A dispatch acknowledgement was not persisted: ${operationId}`);
    }
    return 'scheduled';
  };

  interruptOperation = async (operationId: string): Promise<boolean> => {
    const operation = await this.operationModel.findById(operationId);
    if (!operation || !['running', 'waiting_for_human'].includes(operation.status)) return false;
    const metadata = parseExternalAgentOperationMetadata(
      operation.metadata?.externalAgentExecution,
    );
    if (!metadata) return false;
    const binding = await this.bindingModel.findEnabledByAgentId(metadata.agentId);
    if (binding?.id === metadata.bindingId && metadata.remote?.taskId) {
      try {
        await new A2AHttpJsonAdapter(binding).cancelTask(metadata.remote.taskId);
      } catch {
        // Local cancellation remains authoritative; recovery can retry the remote call separately.
      }
    }
    return this.operationModel.recordCompletion(operationId, {
      completedAt: new Date(),
      completionReason: 'interrupted',
      interruption: {
        canResume: false,
        interruptedAt: new Date().toISOString(),
        reason: 'Agent Group run cancelled',
      },
      status: 'interrupted',
    });
  };

  resumeWithInput = async (operationId: string, input: string): Promise<void> => {
    const operation = await this.operationModel.findById(operationId);
    if (!operation || operation.status !== 'waiting_for_human') {
      throw new Error('External A2A operation is not waiting for input.');
    }
    const metadata = parseExternalAgentOperationMetadata(
      operation.metadata?.externalAgentExecution,
    );
    if (!metadata?.remote?.taskId) {
      throw new Error('External A2A operation has no resumable remote task.');
    }
    const continuationNo = (metadata.continuationNo ?? 0) + 1;
    const next: ExternalAgentOperationMetadata = {
      ...metadata,
      continuationNo,
      dispatch: {
        deduplicationId: `${dispatchIdFor(operationId)}:continue:${continuationNo}`,
        state: 'ready',
      },
      instruction: input.slice(0, 100_000),
    };
    if (
      !(await this.operationModel.resumeWaitingForHuman(operationId, {
        externalAgentExecution: next,
      }))
    ) {
      throw new Error('External A2A continuation lost its waiting-state lease.');
    }
    await this.ensureScheduled(operationId);
    await new AgentInterventionModel(
      this.db,
      this.owner.userId,
      this.owner.workspaceId ?? undefined,
    ).resolvePendingRuntimeOperation(operationId);
  };

  execute = async (operationId: string): Promise<{ outcome: string; resumed: boolean }> => {
    const operation = await this.operationModel.findById(operationId);
    if (!operation) throw new Error('External A2A operation not found.');
    if (operation.status !== 'running') {
      return { outcome: operation.status, resumed: false };
    }
    const metadata = parseExternalAgentOperationMetadata(
      operation.metadata?.externalAgentExecution,
    );
    if (!metadata) throw new Error('External A2A operation metadata is invalid.');
    const binding = await this.bindingModel.findEnabledByAgentId(metadata.agentId);
    if (!binding || binding.id !== metadata.bindingId) {
      throw new Error('External A2A binding is missing, disabled, or changed.');
    }

    let result;
    try {
      result = await new A2AHttpJsonAdapter(binding).execute(
        {
          contextId: metadata.remote?.contextId,
          instruction: metadata.instruction,
          messageId: `msg_${digest(`${operationId}:${metadata.continuationNo ?? 0}`).slice(0, 32)}`,
          taskId: metadata.remote?.taskId,
        },
        {
          onTaskBound: async (remote) => {
            const ref = { contextId: remote.contextId, taskId: remote.taskId };
            const persisted = await this.collaborationService.updateExternalExecutionRef({
              ...metadata.collaboration,
              externalExecutionRef: ref,
              operationId,
            });
            if (!persisted) throw new Error('External A2A Attempt no longer owns its remote task.');
            if (
              !(await this.operationModel.mergeMetadata(operationId, {
                externalAgentExecution: { ...metadata, remote },
              }))
            ) {
              throw new Error('External A2A operation no longer owns its durable task state.');
            }
          },
        },
      );
    } catch (error) {
      const message = safeError(error);
      await this.operationModel.recordCompletion(operationId, {
        completedAt: new Date(),
        completionReason: 'error',
        error: { message, type: 'external_a2a_error' },
        status: 'error',
      });
      const resumed = await this.completeBridge(metadata, operationId, 'error', message);
      return { outcome: 'failed', resumed };
    }

    if (result.taskId) {
      const remote = { contextId: result.contextId, taskId: result.taskId };
      const persisted = await this.collaborationService.updateExternalExecutionRef({
        ...metadata.collaboration,
        externalExecutionRef: remote,
        operationId,
      });
      if (!persisted) throw new Error('External A2A Attempt no longer owns its remote task.');
      if (
        !(await this.operationModel.mergeMetadata(operationId, {
          externalAgentExecution: { ...metadata, remote },
        }))
      ) {
        throw new Error('External A2A operation no longer owns its durable task state.');
      }
    }
    await this.registerArtifacts(metadata, operationId, result.artifacts);

    if (result.outcome === 'input_required' || result.outcome === 'auth_required') {
      await this.operationModel.recordCompletion(operationId, {
        completionReason: 'waiting_for_human',
        status: 'waiting_for_human',
      });
      await this.createInputIntervention(metadata, operationId, result.statusMessage);
      await this.completeBridge(metadata, operationId, 'waiting_for_human', result.statusMessage);
      return { outcome: result.outcome, resumed: false };
    }
    if (result.outcome === 'cancelled') {
      await this.operationModel.recordCompletion(operationId, {
        completedAt: new Date(),
        completionReason: 'interrupted',
        status: 'interrupted',
      });
      const resumed = await this.completeBridge(
        metadata,
        operationId,
        'interrupted',
        result.summary,
      );
      return { outcome: result.outcome, resumed };
    }
    if (result.outcome === 'failed') {
      const message = result.statusMessage ?? 'External A2A task failed.';
      await this.operationModel.recordCompletion(operationId, {
        completedAt: new Date(),
        completionReason: 'error',
        error: { message, type: 'external_a2a_task_failed' },
        status: 'error',
      });
      const resumed = await this.completeBridge(metadata, operationId, 'error', message);
      return { outcome: result.outcome, resumed };
    }

    await this.operationModel.recordCompletion(operationId, {
      completedAt: new Date(),
      completionReason: 'done',
      status: 'done',
    });
    const resumed = await this.completeBridge(metadata, operationId, 'done', result.summary);
    return { outcome: result.outcome, resumed };
  };

  private completeBridge = async (
    metadata: ExternalAgentOperationMetadata,
    operationId: string,
    reason: string,
    summary?: string,
  ): Promise<boolean> => {
    const state = {
      messages: summary
        ? [{ content: summary, id: `${operationId}:answer`, role: 'assistant' }]
        : [],
      status:
        reason === 'done' ? 'done' : reason === 'waiting_for_human' ? 'waiting_for_human' : 'error',
    } as unknown as AgentState;
    return new AiAgentService(this.db, this.owner.userId, {
      workspaceId: this.owner.workspaceId ?? undefined,
    }).completeGroupActionMember({
      ...metadata.bridge,
      collaboration: metadata.collaboration,
      finalState: state,
      operationId,
      reason,
    });
  };

  private createInputIntervention = async (
    metadata: ExternalAgentOperationMetadata,
    operationId: string,
    prompt?: string,
  ) => {
    const revision = metadata.continuationNo ?? 0;
    const batchId = `a2a:${operationId}:${revision}`;
    const requestRevisionHash = digest(
      `${batchId}:${metadata.remote?.taskId ?? 'unbound'}:${prompt ?? ''}`,
    );
    await new AgentInterventionModel(
      this.db,
      this.owner.userId,
      this.owner.workspaceId ?? undefined,
    ).createBatch({
      activityKey: digest(`${batchId}:activity`),
      approvalMode: 'manual',
      batchId,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      items: [
        {
          allowedActions: ['submit_answers', 'stop'],
          interactionKind: 'question',
          provider: 'a2a',
          requestRevisionHash,
          reviewContext: {
            summary: prompt ?? 'The remote Agent requires additional input.',
            title: 'External Agent requires input',
          },
          reviewTokenHash: digest(`${batchId}:review`),
          risk: { level: 'low', summary: 'Input is sent to the configured trusted A2A endpoint.' },
          sanitizedRequest: {
            answerPolicy: { allowFreeform: true },
            apiName: 'a2a.input_required',
            prompt: prompt ?? 'Provide the information requested by the external Agent.',
            questions: [
              {
                allowCustomAnswer: true,
                id: 'response',
                options: [],
                question: prompt ?? 'What should be sent to the external Agent?',
              },
            ],
          },
          surface: 'form',
          toolCallId: `a2a-input-${revision}`,
        },
      ],
      operationId,
      provider: 'a2a',
      source: 'runtime',
      stepIndex: revision,
      systemActionEligibility: 'review_only',
    });
  };

  private registerArtifacts = async (
    metadata: ExternalAgentOperationMetadata,
    operationId: string,
    artifacts: Array<{
      artifactId: string;
      content: string;
      description?: string;
      mediaTypes: string[];
      name?: string;
    }>,
  ) => {
    const workModel = new WorkModel(
      this.db,
      this.owner.userId,
      this.owner.workspaceId ?? undefined,
    );
    for (const artifact of artifacts) {
      await workModel.registerExternal({
        agentId: metadata.agentId,
        changeType: 'updated',
        content: artifact.content,
        description: artifact.description ?? (artifact.mediaTypes.join(', ') || null),
        patchFields: ['content', 'description', 'identifier', 'status', 'title'],
        resourceId: `${metadata.bindingId}:${artifact.artifactId}`,
        resourceType: 'a2a_artifact',
        rootOperationId: operationId,
        status: 'completed',
        title: artifact.name ?? `A2A Artifact ${artifact.artifactId}`,
        toolCallId: `a2a:${operationId}:${metadata.continuationNo ?? 0}:${artifact.artifactId}`,
        toolIdentifier: 'a2a',
        toolName: 'artifact',
        topicId: metadata.topicId,
      });
    }
  };
}

export const createExternalAgentExecutionService = (
  db: LobeChatDatabase,
  owner: RecoverableAgentGroupRunRef,
) => new ExternalAgentExecutionService(db, owner);
