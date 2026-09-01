import type { AgentOperationStatus } from '@lobechat/types';
import debug from 'debug';

import {
  type AgentGroupRunSnapshot,
  listRecoverableAgentGroupRuns,
  type RecoverableAgentGroupRunRef,
} from '@/database/models/agentGroupRun';
import type { LobeChatDatabase } from '@/database/type';
import type { GroupActionMemberBridgeParams } from '@/server/services/agentRuntime/types';

import { AgentGroupCollaborationService } from '.';

const log = debug('lobe-server:agent-group-recovery');

const ACTIVE_ATTEMPT_STATUSES = new Set(['pending', 'running', 'waiting']);
const TERMINAL_OPERATION_REASONS: Partial<
  Record<AgentOperationStatus, 'done' | 'error' | 'interrupted'>
> = {
  abandoned: 'error',
  done: 'done',
  error: 'error',
  interrupted: 'interrupted',
};

interface RecoveryBridgeSnapshot {
  anchorMessageId: string;
  expectedMembers: number;
  groupToolMessageId: string;
  mode: 'in_group' | 'isolated';
  onComplete: 'finish' | 'resume';
  parentOperationId: string;
  threadId?: string;
}

export interface AgentGroupRunRecoveryRuntime {
  completeMember: (params: GroupActionMemberBridgeParams) => Promise<boolean>;
  ensurePreparedQueueStarted: (
    operationId: string,
  ) => Promise<'already_started' | 'missing' | 'not_prepared' | 'scheduled'>;
  finalizeInterruptedOperation: (operationId: string) => Promise<boolean>;
  interruptOperation: (operationId: string) => Promise<boolean>;
}

export interface AgentGroupRunRecoveryOptions {
  createRuntime?: (owner: RecoverableAgentGroupRunRef) => Promise<AgentGroupRunRecoveryRuntime>;
  createService?: (owner: RecoverableAgentGroupRunRef) => AgentGroupRunRecoveryService;
  limit?: number;
  now?: () => Date;
}

export type AgentGroupRunRecoveryService = Pick<
  AgentGroupCollaborationService,
  'beginCancellation' | 'completeAttempt' | 'finalizeCancellation' | 'getRun'
>;

export interface AgentGroupRunRecoverySweepResult {
  cancelled: number;
  failedRunIds: string[];
  reconciled: number;
  redispatched: number;
  scanned: number;
  timedOut: number;
}

const stringField = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const parseBridgeSnapshot = (value: unknown): RecoveryBridgeSnapshot | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const anchorMessageId = stringField(record.anchorMessageId);
  const groupToolMessageId = stringField(record.groupToolMessageId);
  const parentOperationId = stringField(record.parentOperationId);
  const expectedMembers = Number(record.expectedMembers);
  const mode =
    record.mode === 'isolated' ? 'isolated' : record.mode === 'in_group' ? 'in_group' : '';
  const onComplete =
    record.onComplete === 'finish' ? 'finish' : record.onComplete === 'resume' ? 'resume' : '';
  if (
    !anchorMessageId ||
    !groupToolMessageId ||
    !parentOperationId ||
    !Number.isSafeInteger(expectedMembers) ||
    expectedMembers < 1 ||
    !mode ||
    !onComplete
  ) {
    return undefined;
  }

  return {
    anchorMessageId,
    expectedMembers,
    groupToolMessageId,
    mode,
    onComplete,
    parentOperationId,
    threadId: stringField(record.threadId),
  };
};

/**
 * Reconciles the collaboration projection from PostgreSQL operation facts.
 *
 * Redis Streams already owns durable delivery and lease reclaim. This sweeper
 * closes the remaining crash windows: a terminal member whose callback was
 * lost, a timeout watchdog that could not be enqueued, or a Run left in
 * `cancelling` after the caller/process died midway through interruption.
 */
export class AgentGroupRunRecoveryCoordinator {
  private readonly createRuntime: NonNullable<AgentGroupRunRecoveryOptions['createRuntime']>;
  private readonly createService: NonNullable<AgentGroupRunRecoveryOptions['createService']>;
  private readonly limit: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: LobeChatDatabase,
    options: AgentGroupRunRecoveryOptions = {},
  ) {
    this.limit = options.limit ?? 100;
    this.now = options.now ?? (() => new Date());
    this.createRuntime = options.createRuntime ?? this.createDefaultRuntime;
    this.createService = options.createService ?? this.createDefaultService;
  }

  cancelRun = async (owner: RecoverableAgentGroupRunRef) => {
    const service = this.createService(owner);
    const transition = await service.beginCancellation(owner.id);
    if (transition.alreadyTerminal) return transition.snapshot;

    const runtime = await this.createRuntime(owner);
    const operationIds = Array.from(
      new Set([transition.supervisorOperationId, ...transition.activeOperationIds]),
    );
    const interruptions = await Promise.allSettled(
      operationIds.map((operationId) => runtime.interruptOperation(operationId)),
    );
    const rejected = interruptions.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;

    // Persist every interrupted operation through the ordinary terminal
    // lifecycle before declaring the durable Run cancelled. In-flight member
    // requests may not observe their Redis abort flag until a provider call
    // returns; doing this here makes cancellation immediately authoritative in
    // PostgreSQL while the later step-boundary replay remains idempotent.
    const finalizations = await Promise.allSettled(
      operationIds.map((operationId) => runtime.finalizeInterruptedOperation(operationId)),
    );
    const rejectedFinalization = finalizations.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejectedFinalization) throw rejectedFinalization.reason;

    // Backfill the same message barrier used by normal completion. This also
    // idempotently settles each Attempt before the final Run cancellation.
    for (const attempt of transition.snapshot.attempts) {
      if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status) && attempt.status !== 'cancelled') continue;
      const bridge = parseBridgeSnapshot(attempt.executionTargetSnapshot);
      if (bridge) {
        await runtime.completeMember({
          ...bridge,
          collaboration: {
            attemptNo: attempt.attemptNo,
            runId: owner.id,
            runNodeId: attempt.runNodeId,
            runtimeKind: attempt.runtimeKind,
          },
          operationId: attempt.operationId,
          reason: 'interrupted',
        });
      } else {
        await service.completeAttempt({
          attemptNo: attempt.attemptNo,
          completionReason: 'interrupted',
          operationId: attempt.operationId,
          runNodeId: attempt.runNodeId,
          runtimeKind: attempt.runtimeKind,
          status: 'cancelled',
        });
      }
    }

    return service.finalizeCancellation(owner.id);
  };

  reconcileRun = async (
    owner: RecoverableAgentGroupRunRef,
  ): Promise<{
    cancelled: boolean;
    reconciled: number;
    redispatched: number;
    timedOut: number;
  }> => {
    const service = this.createService(owner);
    const snapshot = await service.getRun(owner.id);
    if (!snapshot) return { cancelled: false, reconciled: 0, redispatched: 0, timedOut: 0 };
    if (snapshot.run.status === 'cancelling') {
      await this.cancelRun(owner);
      return { cancelled: true, reconciled: 0, redispatched: 0, timedOut: 0 };
    }

    const runtime = await this.createRuntime(owner);
    const operationMap = new Map(snapshot.operations.map((operation) => [operation.id, operation]));
    const nodeMap = new Map(snapshot.nodes.map((node) => [node.id, node]));
    let reconciled = 0;
    let redispatched = 0;
    let timedOut = 0;

    for (const attempt of snapshot.attempts) {
      if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
      if (attempt.runtimeKind === 'normal') {
        const dispatch = await runtime.ensurePreparedQueueStarted(attempt.operationId);
        if (dispatch === 'scheduled') redispatched += 1;
      }
      const node = nodeMap.get(attempt.runNodeId);
      const operation = operationMap.get(attempt.operationId);
      const deadline =
        node?.timeoutMs && attempt.startedAt
          ? attempt.startedAt.getTime() + node.timeoutMs
          : undefined;
      const isTimedOut = deadline !== undefined && deadline <= this.now().getTime();
      const reason = isTimedOut
        ? 'timeout'
        : operation
          ? TERMINAL_OPERATION_REASONS[operation.status]
          : undefined;
      if (!reason) continue;

      if (isTimedOut) {
        await runtime.interruptOperation(attempt.operationId);
        timedOut += 1;
      }
      await this.completeAttempt(service, runtime, snapshot, attempt, reason);
      reconciled += 1;
    }

    return { cancelled: false, reconciled, redispatched, timedOut };
  };

  sweepOnce = async (): Promise<AgentGroupRunRecoverySweepResult> => {
    const owners = await listRecoverableAgentGroupRuns(this.db, this.limit);
    const result: AgentGroupRunRecoverySweepResult = {
      cancelled: 0,
      failedRunIds: [],
      reconciled: 0,
      redispatched: 0,
      scanned: owners.length,
      timedOut: 0,
    };

    for (const owner of owners) {
      try {
        const outcome = await this.reconcileRun(owner);
        result.cancelled += outcome.cancelled ? 1 : 0;
        result.reconciled += outcome.reconciled;
        result.redispatched += outcome.redispatched;
        result.timedOut += outcome.timedOut;
      } catch (error) {
        result.failedRunIds.push(owner.id);
        log('failed to reconcile run %s: %O', owner.id, error);
      }
    }

    return result;
  };

  private completeAttempt = async (
    service: AgentGroupRunRecoveryService,
    runtime: AgentGroupRunRecoveryRuntime,
    snapshot: AgentGroupRunSnapshot,
    attempt: AgentGroupRunSnapshot['attempts'][number],
    reason: 'done' | 'error' | 'interrupted' | 'timeout',
  ) => {
    const bridge = parseBridgeSnapshot(attempt.executionTargetSnapshot);
    if (bridge) {
      await runtime.completeMember({
        ...bridge,
        collaboration: {
          attemptNo: attempt.attemptNo,
          runId: snapshot.run.id,
          runNodeId: attempt.runNodeId,
          runtimeKind: attempt.runtimeKind,
        },
        operationId: attempt.operationId,
        reason,
      });
      return;
    }

    await service.completeAttempt({
      attemptNo: attempt.attemptNo,
      completionReason: reason,
      operationId: attempt.operationId,
      runNodeId: attempt.runNodeId,
      runtimeKind: attempt.runtimeKind,
      status:
        reason === 'done'
          ? 'completed'
          : reason === 'interrupted'
            ? 'cancelled'
            : reason === 'timeout'
              ? 'timed_out'
              : 'failed',
    });
  };

  private createDefaultRuntime = async (
    owner: RecoverableAgentGroupRunRef,
  ): Promise<AgentGroupRunRecoveryRuntime> => {
    // Dynamic import keeps the upward dependency (collaboration recovery →
    // AiAgentService) out of AgentRuntimeService's static module cycle.
    const { AiAgentService } = await import('@/server/services/aiAgent');
    const service = new AiAgentService(this.db, owner.userId, {
      workspaceId: owner.workspaceId ?? undefined,
    });
    return {
      completeMember: (params) => service.completeGroupActionMember(params),
      ensurePreparedQueueStarted: (operationId) => service.ensurePreparedQueueStarted(operationId),
      finalizeInterruptedOperation: (operationId) =>
        service.ensureInterruptedTaskFinalized(operationId),
      interruptOperation: async (operationId) =>
        (await service.interruptTask({ operationId })).success,
    };
  };

  private createDefaultService = (owner: RecoverableAgentGroupRunRef) =>
    new AgentGroupCollaborationService(this.db, owner.userId, owner.workspaceId ?? undefined);
}
