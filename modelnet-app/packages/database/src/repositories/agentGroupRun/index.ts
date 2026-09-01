import {
  AgentGroupRunModel,
  type AgentGroupRunSnapshot,
  type ClaimReadyAgentGroupRunNodesParams,
  type CompleteAgentGroupRunAttemptParams,
  type CreateAgentGroupRunAttemptParams,
  type CreateAgentGroupRunParams,
  type CreateClaimedAgentGroupRunAttemptParams,
  type FailAgentGroupRunNodeStartParams,
  type FailClaimedAgentGroupRunNodeStartParams,
  type ParkAgentGroupRunAttemptParams,
  type ReleaseAgentGroupRunDispatchClaimParams,
  type StartAgentGroupRunNodeRetryParams,
} from '../../models/agentGroupRun';
import { ChatGroupModel } from '../../models/chatGroup';
import type { ChatGroupItem } from '../../schemas';
import type { LobeChatDatabase } from '../../type';

export type AgentGroupRunRoster = Awaited<ReturnType<ChatGroupModel['getGroupAgentsWithMeta']>>;

export interface AgentGroupRunExecutionContext {
  group: ChatGroupItem;
  roster: AgentGroupRunRoster;
}

/**
 * Database boundary used by GroupCollaborationService. It deliberately checks
 * group visibility before reading the roster, then delegates immutable run and
 * attempt persistence to AgentGroupRunModel.
 */
export class AgentGroupRunRepository {
  private readonly chatGroupModel: ChatGroupModel;
  private readonly runModel: AgentGroupRunModel;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.chatGroupModel = new ChatGroupModel(db, userId, workspaceId);
    this.runModel = new AgentGroupRunModel(db, userId, workspaceId);
  }

  createAttempt = (params: CreateAgentGroupRunAttemptParams) => this.runModel.createAttempt(params);

  createClaimedAttempt = (params: CreateClaimedAgentGroupRunAttemptParams) =>
    this.runModel.createClaimedAttempt(params);

  claimReadyNodes = (params: ClaimReadyAgentGroupRunNodesParams, now?: Date) =>
    this.runModel.claimReadyNodes(params, now);

  completeAttempt = (params: CompleteAgentGroupRunAttemptParams) =>
    this.runModel.completeAttempt(params);

  parkAttemptForIntervention = (params: ParkAgentGroupRunAttemptParams) =>
    this.runModel.parkAttemptForIntervention(params);

  createRun = (params: CreateAgentGroupRunParams): Promise<AgentGroupRunSnapshot> =>
    this.runModel.create(params);

  beginCancellation = (runId: string) => this.runModel.beginCancellation(runId);

  finalizeCancellation = (runId: string) => this.runModel.finalizeCancellation(runId);

  getExecutionContext = async (
    chatGroupId: string,
  ): Promise<AgentGroupRunExecutionContext | undefined> => {
    const group = await this.chatGroupModel.findById(chatGroupId);
    if (!group) return undefined;

    const roster = await this.chatGroupModel.getGroupAgentsWithMeta(chatGroupId);
    return { group, roster };
  };

  failNodeStart = (params: FailAgentGroupRunNodeStartParams) => this.runModel.failNodeStart(params);

  failClaimedNodeStart = (params: FailClaimedAgentGroupRunNodeStartParams) =>
    this.runModel.failClaimedNodeStart(params);

  getRun = (runId: string) => this.runModel.findById(runId);

  listEvents = (runId: string, limit?: number) => this.runModel.listEvents(runId, limit);

  listRuns = (chatGroupId: string, limit?: number) =>
    this.runModel.listByChatGroup(chatGroupId, limit);

  pauseAtBarrier = (runId: string) => this.runModel.pauseAtBarrier(runId);

  releaseDispatchClaim = (params: ReleaseAgentGroupRunDispatchClaimParams) =>
    this.runModel.releaseDispatchClaim(params);

  resumeFromBarrier = (runId: string) => this.runModel.resumeFromBarrier(runId);

  isLatestAttempt = (
    params: Pick<CreateAgentGroupRunAttemptParams, 'attemptNo' | 'operationId' | 'runNodeId'>,
  ) => this.runModel.isLatestAttempt(params);

  startRetryAttempt = (params: StartAgentGroupRunNodeRetryParams) =>
    this.runModel.startRetryAttempt(params);
}
