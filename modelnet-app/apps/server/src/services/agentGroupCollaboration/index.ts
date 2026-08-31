import type {
  AgentGroupRunBudgetSnapshot,
  AgentGroupRunPlanNodeInput,
  AgentGroupRunPolicySnapshot,
  AgentGroupRunProtocol,
} from '@lobechat/types';
import { TRPCError } from '@trpc/server';

import type {
  ClaimReadyAgentGroupRunNodesParams,
  CompleteAgentGroupRunAttemptParams,
  CreateAgentGroupRunAttemptParams,
  CreateClaimedAgentGroupRunAttemptParams,
  FailAgentGroupRunNodeStartParams,
  ReleaseAgentGroupRunDispatchClaimParams,
  StartAgentGroupRunNodeRetryParams,
} from '@/database/models/agentGroupRun';
import { AgentGroupRunRepository } from '@/database/repositories/agentGroupRun';
import type { LobeChatDatabase } from '@/database/type';
import { appEnv } from '@/envs/app';

import { compileAgentGroupRunPlan } from './plan';

export interface CreateAgentGroupCollaborationRunInput {
  budgetSnapshot?: AgentGroupRunBudgetSnapshot;
  chatGroupId: string;
  idempotencyKey: string;
  nodes: AgentGroupRunPlanNodeInput[];
  policySnapshot?: AgentGroupRunPolicySnapshot;
  protocol: AgentGroupRunProtocol;
  supervisorAgentId: string;
  supervisorOperationId: string;
  threadId?: string | null;
  topicId?: string | null;
}

/** Application boundary for creating the new collaboration projection. */
export class AgentGroupCollaborationService {
  private readonly repository: AgentGroupRunRepository;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.repository = new AgentGroupRunRepository(db, userId, workspaceId);
  }

  createRun = async (input: CreateAgentGroupCollaborationRunInput) => {
    if (!appEnv.enableAgentGroupDurableRuns) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Durable Agent Group runs are disabled for this deployment.',
      });
    }

    const context = await this.repository.getExecutionContext(input.chatGroupId);
    if (!context) throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent Group not found.' });

    const { roster } = context;

    const supervisor = roster.find((member) => member.role === 'supervisor');
    if (!supervisor || supervisor.agentId !== input.supervisorAgentId) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'The supplied supervisor is not the enabled supervisor for this Agent Group.',
      });
    }

    const { planHash, planSnapshot } = compileAgentGroupRunPlan({
      allowedAgentIds: roster.map((member) => member.agentId),
      nodes: input.nodes,
      protocol: input.protocol,
      supervisorAgentId: input.supervisorAgentId,
    });

    return this.repository.createRun({
      budgetSnapshot: input.budgetSnapshot,
      chatGroupId: input.chatGroupId,
      idempotencyKey: input.idempotencyKey,
      planHash,
      planSnapshot,
      policySnapshot: input.policySnapshot,
      supervisorAgentId: input.supervisorAgentId,
      supervisorOperationId: input.supervisorOperationId,
      threadId: input.threadId,
      topicId: input.topicId,
    });
  };

  completeAttempt = (params: CompleteAgentGroupRunAttemptParams) =>
    this.repository.completeAttempt(params);

  claimReadyNodes = (params: ClaimReadyAgentGroupRunNodesParams, now?: Date) =>
    this.repository.claimReadyNodes(params, now);

  parkAttemptForIntervention = (params: CreateAgentGroupRunAttemptParams) =>
    this.repository.parkAttemptForIntervention(params);

  beginCancellation = (runId: string) => this.repository.beginCancellation(runId);

  createAttempt = (params: CreateAgentGroupRunAttemptParams) =>
    this.repository.createAttempt(params);

  createClaimedAttempt = (params: CreateClaimedAgentGroupRunAttemptParams) =>
    this.repository.createClaimedAttempt(params);

  failNodeStart = (params: FailAgentGroupRunNodeStartParams) =>
    this.repository.failNodeStart(params);

  finalizeCancellation = (runId: string) => this.repository.finalizeCancellation(runId);

  getRun = (runId: string) => this.repository.getRun(runId);

  listEvents = (runId: string, limit?: number) => this.repository.listEvents(runId, limit);

  listRuns = (chatGroupId: string, limit?: number) => this.repository.listRuns(chatGroupId, limit);

  pauseAtBarrier = (runId: string) => this.repository.pauseAtBarrier(runId);

  resumeFromBarrier = (runId: string) => this.repository.resumeFromBarrier(runId);

  releaseDispatchClaim = (params: ReleaseAgentGroupRunDispatchClaimParams) =>
    this.repository.releaseDispatchClaim(params);

  isLatestAttempt = (
    params: Pick<CreateAgentGroupRunAttemptParams, 'attemptNo' | 'operationId' | 'runNodeId'>,
  ) => this.repository.isLatestAttempt(params);

  startRetryAttempt = (params: StartAgentGroupRunNodeRetryParams) =>
    this.repository.startRetryAttempt(params);
}
