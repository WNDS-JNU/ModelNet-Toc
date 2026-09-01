import { randomUUID } from 'node:crypto';

import type {
  AgentGroupRunAttemptOutputSnapshot,
  AgentGroupRunAttemptStatus,
  AgentGroupRunBudgetSnapshot,
  AgentGroupRunError,
  AgentGroupRunExternalExecutionRef,
  AgentGroupRunNodeStatus,
  AgentGroupRunPlanSnapshot,
  AgentGroupRunPolicySnapshot,
  AgentGroupRunRuntimeKind,
} from '@lobechat/types';
import { and, asc, desc, eq, inArray, not, sql } from 'drizzle-orm';

import {
  agentGroupRunAttempts,
  agentGroupRunEvents,
  agentGroupRunNodes,
  agentGroupRuns,
  agentOperations,
  chatGroups,
} from '../schemas';
import type { LobeChatDatabase, Transaction } from '../type';
import { buildWorkspacePayload, buildWorkspaceWhere } from '../utils/workspace';

export const AGENT_GROUP_RUN_NOT_FOUND = 'AGENT_GROUP_RUN_NOT_FOUND';
export const AGENT_GROUP_RUN_IDEMPOTENCY_CONFLICT = 'AGENT_GROUP_RUN_IDEMPOTENCY_CONFLICT';
export const AGENT_GROUP_RUN_OPERATION_MISMATCH = 'AGENT_GROUP_RUN_OPERATION_MISMATCH';
export const AGENT_GROUP_RUN_DISPATCH_CLAIM_CONFLICT = 'AGENT_GROUP_RUN_DISPATCH_CLAIM_CONFLICT';
export const AGENT_GROUP_RUN_DISPATCH_CLAIM_INVALID = 'AGENT_GROUP_RUN_DISPATCH_CLAIM_INVALID';
export const AGENT_GROUP_RUN_NODE_NOT_READY = 'AGENT_GROUP_RUN_NODE_NOT_READY';
export const AGENT_GROUP_RUN_RETRY_LIMIT_EXCEEDED = 'AGENT_GROUP_RUN_RETRY_LIMIT_EXCEEDED';
export const AGENT_GROUP_RUN_RETRY_NOT_ALLOWED = 'AGENT_GROUP_RUN_RETRY_NOT_ALLOWED';
export const AGENT_GROUP_RUN_PAUSE_NOT_ALLOWED = 'AGENT_GROUP_RUN_PAUSE_NOT_ALLOWED';
export const AGENT_GROUP_RUN_RESUME_NOT_ALLOWED = 'AGENT_GROUP_RUN_RESUME_NOT_ALLOWED';
export const AGENT_GROUP_RUN_MANUAL_PAUSE_REASON = 'manual_pause';
export const AGENT_GROUP_RUN_INTERVENTION_REASON = 'waiting_for_human';

export interface CreateAgentGroupRunParams {
  budgetSnapshot?: AgentGroupRunBudgetSnapshot;
  chatGroupId: string;
  idempotencyKey: string;
  planHash: string;
  planSnapshot: AgentGroupRunPlanSnapshot;
  policySnapshot?: AgentGroupRunPolicySnapshot;
  supervisorAgentId: string;
  supervisorOperationId: string;
  threadId?: string | null;
  topicId?: string | null;
}

export interface CreateAgentGroupRunAttemptParams {
  attemptNo: number;
  executionTargetSnapshot?: Record<string, unknown>;
  externalExecutionRef?: AgentGroupRunExternalExecutionRef;
  operationId: string;
  runNodeId: string;
  runtimeKind: AgentGroupRunRuntimeKind;
}

export interface CreateClaimedAgentGroupRunAttemptParams extends CreateAgentGroupRunAttemptParams {
  dispatchClaimId: string;
}

export interface ClaimReadyAgentGroupRunNodesParams {
  leaseDurationMs: number;
  limit?: number;
  runId: string;
}

export interface AgentGroupRunUpstreamRef {
  attemptNo: number;
  completionReason: string | null;
  externalExecutionRef: AgentGroupRunExternalExecutionRef | null;
  nodeKey: string;
  operationId: string;
  outputSnapshot: AgentGroupRunAttemptOutputSnapshot | null;
  runNodeId: string;
  runtimeKind: AgentGroupRunRuntimeKind;
}

export interface AgentGroupRunDispatchClaim {
  attemptNo: number;
  claimedAt: Date;
  claimId: string;
  expiresAt: Date;
  node: typeof agentGroupRunNodes.$inferSelect;
  upstream: AgentGroupRunUpstreamRef[];
}

export interface ReleaseAgentGroupRunDispatchClaimParams {
  claimId: string;
  reason: string;
  runNodeId: string;
}

export interface CompleteAgentGroupRunAttemptParams extends CreateAgentGroupRunAttemptParams {
  completionReason: string;
  error?: AgentGroupRunError;
  outputSnapshot?: AgentGroupRunAttemptOutputSnapshot;
  status: Extract<AgentGroupRunAttemptStatus, 'cancelled' | 'completed' | 'failed' | 'timed_out'>;
}

export type ParkAgentGroupRunAttemptParams = CreateAgentGroupRunAttemptParams;

export type StartAgentGroupRunNodeRetryParams = CreateAgentGroupRunAttemptParams;

export interface FailAgentGroupRunNodeStartParams {
  error: AgentGroupRunError;
  runNodeId: string;
}

export interface AgentGroupRunSnapshot {
  attempts: (typeof agentGroupRunAttempts.$inferSelect)[];
  /** Present only on create(): false means the idempotency winner already existed. */
  created?: boolean;
  nodes: (typeof agentGroupRunNodes.$inferSelect)[];
  operations: (typeof agentOperations.$inferSelect)[];
  run: typeof agentGroupRuns.$inferSelect;
}

export interface BeginAgentGroupRunCancellationResult {
  activeOperationIds: string[];
  alreadyTerminal: boolean;
  snapshot: AgentGroupRunSnapshot;
  supervisorOperationId: string;
}

export interface RecoverableAgentGroupRunRef {
  id: string;
  userId: string;
  workspaceId: string | null;
}

const TERMINAL_ATTEMPT_STATUSES: AgentGroupRunAttemptStatus[] = [
  'cancelled',
  'completed',
  'failed',
  'timed_out',
];
const TERMINAL_NODE_STATUSES: AgentGroupRunNodeStatus[] = [
  'blocked',
  'cancelled',
  'completed',
  'failed',
  'skipped',
];
const RETRYABLE_NODE_STATUSES: AgentGroupRunNodeStatus[] = [
  'cancelled',
  'completed',
  'failed',
  'skipped',
];
const BLOCKING_DEPENDENCY_STATUSES: AgentGroupRunNodeStatus[] = ['blocked', 'cancelled', 'failed'];
const TERMINAL_RUN_STATUSES = ['cancelled', 'completed', 'failed'] as const;
const ACTIVE_ATTEMPT_STATUSES: AgentGroupRunAttemptStatus[] = ['pending', 'running', 'waiting'];
export const AGENT_GROUP_RUN_DISPATCH_LEASE_MIN_MS = 1_000;
export const AGENT_GROUP_RUN_DISPATCH_LEASE_MAX_MS = 15 * 60_000;

/** Internal, owner-agnostic scan used only by the trusted recovery worker. */
export const listRecoverableAgentGroupRuns = async (
  db: LobeChatDatabase,
  limit = 100,
): Promise<RecoverableAgentGroupRunRef[]> =>
  db
    .select({
      id: agentGroupRuns.id,
      userId: agentGroupRuns.userId,
      workspaceId: agentGroupRuns.workspaceId,
    })
    .from(agentGroupRuns)
    .where(inArray(agentGroupRuns.status, ['pending', 'running', 'waiting', 'cancelling']))
    .orderBy(asc(agentGroupRuns.updatedAt), asc(agentGroupRuns.id))
    .limit(Math.max(1, Math.min(limit, 500)));

/**
 * Persistence boundary for the collaboration projection. Access is always
 * checked through the current chat-group visibility, rather than trusting the
 * denormalized run owner alone; making a group private therefore also hides its
 * historical runs from other workspace members.
 */
export class AgentGroupRunModel {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
    private readonly workspaceId?: string,
  ) {}

  private groupAccess = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, chatGroups);

  private runScope = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, agentGroupRuns);

  private operationScope = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, agentOperations);

  private recordEvent = async (
    tx: Transaction,
    event: {
      attemptId?: string;
      data?: Record<string, unknown>;
      idempotencyKey: string;
      operationId?: string;
      runId: string;
      runNodeId?: string;
      status?: string;
      type: string;
    },
  ) => {
    await tx
      .insert(agentGroupRunEvents)
      .values(event)
      .onConflictDoNothing({
        target: [agentGroupRunEvents.runId, agentGroupRunEvents.idempotencyKey],
      });
  };

  private loadAccessibleNode = async (tx: Transaction, runNodeId: string) => {
    const [node] = await tx
      .select({
        agentId: agentGroupRunNodes.agentId,
        chatGroupId: agentGroupRuns.chatGroupId,
        dispatchClaimExpiresAt: agentGroupRunNodes.dispatchClaimExpiresAt,
        dispatchClaimId: agentGroupRunNodes.dispatchClaimId,
        id: agentGroupRunNodes.id,
        maxAttempts: agentGroupRunNodes.maxAttempts,
        protocol: agentGroupRuns.protocol,
        runId: agentGroupRunNodes.runId,
        runStatus: agentGroupRuns.status,
        status: agentGroupRunNodes.status,
      })
      .from(agentGroupRunNodes)
      .innerJoin(agentGroupRuns, eq(agentGroupRunNodes.runId, agentGroupRuns.id))
      .innerJoin(chatGroups, eq(agentGroupRuns.chatGroupId, chatGroups.id))
      .where(and(eq(agentGroupRunNodes.id, runNodeId), this.groupAccess()))
      .limit(1);

    if (!node) throw new Error(AGENT_GROUP_RUN_NOT_FOUND);
    return node;
  };

  private ensureAttempt = async (
    tx: Transaction,
    params: CreateAgentGroupRunAttemptParams,
    options: { allowTerminalNode?: boolean; dispatchClaimId?: string } = {},
  ): Promise<{
    attempt: typeof agentGroupRunAttempts.$inferSelect;
    node: Awaited<ReturnType<AgentGroupRunModel['loadAccessibleNode']>>;
  }> => {
    const node = await this.loadAccessibleNode(tx, params.runNodeId);
    const [operation] = await tx
      .select({
        agentId: agentOperations.agentId,
        chatGroupId: agentOperations.chatGroupId,
        id: agentOperations.id,
      })
      .from(agentOperations)
      .where(and(eq(agentOperations.id, params.operationId), this.operationScope()))
      .limit(1);

    if (
      !operation ||
      !node.agentId ||
      operation.agentId !== node.agentId ||
      operation.chatGroupId !== node.chatGroupId
    ) {
      throw new Error(AGENT_GROUP_RUN_OPERATION_MISMATCH);
    }

    const validateIdentity = (attempt: typeof agentGroupRunAttempts.$inferSelect) => {
      if (
        attempt.runNodeId !== params.runNodeId ||
        attempt.attemptNo !== params.attemptNo ||
        attempt.operationId !== params.operationId
      ) {
        throw new Error(AGENT_GROUP_RUN_OPERATION_MISMATCH);
      }
      return attempt;
    };

    const [existingByOperation] = await tx
      .select()
      .from(agentGroupRunAttempts)
      .where(eq(agentGroupRunAttempts.operationId, params.operationId))
      .limit(1);
    if (existingByOperation) return { attempt: validateIdentity(existingByOperation), node };

    if (options.dispatchClaimId && node.dispatchClaimId !== options.dispatchClaimId) {
      throw new Error(AGENT_GROUP_RUN_DISPATCH_CLAIM_CONFLICT);
    }

    if (
      !options.allowTerminalNode &&
      node.protocol === 'pipeline' &&
      !(['ready', 'running', 'waiting'] as AgentGroupRunNodeStatus[]).includes(node.status)
    ) {
      throw new Error(AGENT_GROUP_RUN_NODE_NOT_READY);
    }

    const [created] = await tx
      .insert(agentGroupRunAttempts)
      .values({
        attemptNo: params.attemptNo,
        executionTargetSnapshot: params.executionTargetSnapshot,
        externalExecutionRef: params.externalExecutionRef,
        operationId: params.operationId,
        runNodeId: params.runNodeId,
        runtimeKind: params.runtimeKind,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return { attempt: created, node };

    const [winner] = await tx
      .select()
      .from(agentGroupRunAttempts)
      .where(
        and(
          eq(agentGroupRunAttempts.runNodeId, params.runNodeId),
          eq(agentGroupRunAttempts.attemptNo, params.attemptNo),
        ),
      )
      .limit(1);
    if (!winner) throw new Error(AGENT_GROUP_RUN_OPERATION_MISMATCH);

    return { attempt: validateIdentity(winner), node };
  };

  /**
   * Atomically lease ready pipeline nodes before creating any child operation.
   *
   * The Run row is the short serialization point shared with dependency
   * advancement. A live lease is skipped; an expired lease is reclaimed with
   * a new fencing token and an append-only recovery event. No transaction is
   * held while the caller resolves an ExecutionPlan or publishes to Redis.
   */
  claimReadyNodes = async (
    params: ClaimReadyAgentGroupRunNodesParams,
    now = new Date(),
  ): Promise<AgentGroupRunDispatchClaim[]> => {
    const limit = params.limit ?? 16;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(params.leaseDurationMs) ||
      params.leaseDurationMs < AGENT_GROUP_RUN_DISPATCH_LEASE_MIN_MS ||
      params.leaseDurationMs > AGENT_GROUP_RUN_DISPATCH_LEASE_MAX_MS ||
      Number.isNaN(now.getTime())
    ) {
      throw new Error(AGENT_GROUP_RUN_DISPATCH_CLAIM_INVALID);
    }

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ protocol: agentGroupRuns.protocol, status: agentGroupRuns.status })
        .from(agentGroupRuns)
        .innerJoin(chatGroups, eq(agentGroupRuns.chatGroupId, chatGroups.id))
        .where(and(eq(agentGroupRuns.id, params.runId), this.groupAccess()))
        .limit(1)
        .for('update');
      if (!row) throw new Error(AGENT_GROUP_RUN_NOT_FOUND);
      if (row.protocol !== 'pipeline' || !['pending', 'running'].includes(row.status)) return [];

      const nodes = await tx
        .select()
        .from(agentGroupRunNodes)
        .where(eq(agentGroupRunNodes.runId, params.runId))
        .orderBy(asc(agentGroupRunNodes.sortOrder), asc(agentGroupRunNodes.id));
      const nodeByKey = new Map(nodes.map((node) => [node.nodeKey, node]));
      const attempts =
        nodes.length === 0
          ? []
          : await tx
              .select()
              .from(agentGroupRunAttempts)
              .where(
                inArray(
                  agentGroupRunAttempts.runNodeId,
                  nodes.map((node) => node.id),
                ),
              )
              .orderBy(desc(agentGroupRunAttempts.attemptNo));
      const latestAttemptByNode = new Map<string, typeof agentGroupRunAttempts.$inferSelect>();
      for (const attempt of attempts) {
        if (!latestAttemptByNode.has(attempt.runNodeId)) {
          latestAttemptByNode.set(attempt.runNodeId, attempt);
        }
      }

      const expiresAt = new Date(now.getTime() + params.leaseDurationMs);
      const claims: AgentGroupRunDispatchClaim[] = [];
      for (const node of nodes) {
        if (claims.length >= limit) break;
        if (node.status !== 'ready') continue;
        if (node.dispatchClaimExpiresAt && node.dispatchClaimExpiresAt.getTime() > now.getTime()) {
          continue;
        }

        const expiredClaimId = node.dispatchClaimId;
        if (expiredClaimId) {
          await this.recordEvent(tx, {
            data: { claimId: expiredClaimId, expiredAt: node.dispatchClaimExpiresAt },
            idempotencyKey: `node:${node.id}:dispatch-lease-expired:${expiredClaimId}`,
            runId: params.runId,
            runNodeId: node.id,
            status: 'ready',
            type: 'node.dispatch_lease_expired',
          });
        }

        const claimId = randomUUID();
        const [claimed] = await tx
          .update(agentGroupRunNodes)
          .set({
            dispatchClaimedAt: now,
            dispatchClaimExpiresAt: expiresAt,
            dispatchClaimId: claimId,
          })
          .where(and(eq(agentGroupRunNodes.id, node.id), eq(agentGroupRunNodes.status, 'ready')))
          .returning();
        if (!claimed) continue;

        const upstream = node.dependencies.flatMap((dependencyKey) => {
          const dependency = nodeByKey.get(dependencyKey);
          if (!dependency) return [];
          const attempt = latestAttemptByNode.get(dependency.id);
          if (!attempt || !TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)) return [];
          return [
            {
              attemptNo: attempt.attemptNo,
              completionReason: attempt.completionReason,
              externalExecutionRef: attempt.externalExecutionRef,
              nodeKey: dependency.nodeKey,
              operationId: attempt.operationId,
              outputSnapshot: attempt.outputSnapshot,
              runNodeId: dependency.id,
              runtimeKind: attempt.runtimeKind,
            },
          ];
        });
        const latestAttempt = latestAttemptByNode.get(node.id);
        const attemptNo = (latestAttempt?.attemptNo ?? 0) + 1;

        await this.recordEvent(tx, {
          data: {
            attemptNo,
            claimId,
            expiresAt,
            upstreamOperationIds: upstream.map(({ operationId }) => operationId),
          },
          idempotencyKey: `node:${node.id}:dispatch-claimed:${claimId}`,
          runId: params.runId,
          runNodeId: node.id,
          status: 'ready',
          type: 'node.dispatch_claimed',
        });
        claims.push({ attemptNo, claimId, claimedAt: now, expiresAt, node: claimed, upstream });
      }

      return claims;
    });
  };

  /** Release only the exact live dispatcher lease; stale workers are fenced. */
  releaseDispatchClaim = async (
    params: ReleaseAgentGroupRunDispatchClaimParams,
  ): Promise<boolean> =>
    this.db.transaction(async (tx) => {
      const node = await this.loadAccessibleNode(tx, params.runNodeId);
      const [released] = await tx
        .update(agentGroupRunNodes)
        .set({ dispatchClaimedAt: null, dispatchClaimExpiresAt: null, dispatchClaimId: null })
        .where(
          and(
            eq(agentGroupRunNodes.id, node.id),
            eq(agentGroupRunNodes.status, 'ready'),
            eq(agentGroupRunNodes.dispatchClaimId, params.claimId),
          ),
        )
        .returning({ id: agentGroupRunNodes.id });
      if (!released) return false;

      await this.recordEvent(tx, {
        data: { claimId: params.claimId, reason: params.reason },
        idempotencyKey: `node:${node.id}:dispatch-released:${params.claimId}`,
        runId: node.runId,
        runNodeId: node.id,
        status: 'ready',
        type: 'node.dispatch_released',
      });
      return true;
    });

  /**
   * Advance the durable pipeline projection after one node transition.
   *
   * A required dependency failure recursively blocks every not-yet-started
   * descendant. Successful retries can revive those dependency-blocked nodes,
   * but only when every required dependency has completed successfully.
   */
  private advancePipeline = async (tx: Transaction, runId: string, transitionKey: string) => {
    const [run] = await tx
      .select({ protocol: agentGroupRuns.protocol })
      .from(agentGroupRuns)
      .where(eq(agentGroupRuns.id, runId))
      .limit(1)
      .for('update');
    if (run?.protocol !== 'pipeline') return;

    const nodes = await tx
      .select({
        completionReason: agentGroupRunNodes.completionReason,
        dependencies: agentGroupRunNodes.dependencies,
        id: agentGroupRunNodes.id,
        nodeKey: agentGroupRunNodes.nodeKey,
        status: agentGroupRunNodes.status,
      })
      .from(agentGroupRunNodes)
      .where(eq(agentGroupRunNodes.runId, runId));
    const statusByKey = new Map(nodes.map((node) => [node.nodeKey, node.status]));

    let blockedOne = true;
    while (blockedOne) {
      blockedOne = false;
      for (const node of nodes) {
        const status = statusByKey.get(node.nodeKey);
        if (status !== 'pending' && status !== 'ready') continue;

        const blockedBy = node.dependencies.find((dependencyKey) => {
          const dependencyStatus = statusByKey.get(dependencyKey);
          return Boolean(
            dependencyStatus && BLOCKING_DEPENDENCY_STATUSES.includes(dependencyStatus),
          );
        });
        if (!blockedBy) continue;

        const error: AgentGroupRunError = {
          code: 'DEPENDENCY_FAILED',
          message: `Required dependency "${blockedBy}" did not complete successfully.`,
        };
        const [updated] = await tx
          .update(agentGroupRunNodes)
          .set({
            completionReason: 'dependency_failed',
            dispatchClaimedAt: null,
            dispatchClaimExpiresAt: null,
            dispatchClaimId: null,
            error,
            status: 'blocked',
          })
          .where(
            and(
              eq(agentGroupRunNodes.id, node.id),
              inArray(agentGroupRunNodes.status, ['pending', 'ready']),
            ),
          )
          .returning({ id: agentGroupRunNodes.id });
        if (!updated) continue;

        statusByKey.set(node.nodeKey, 'blocked');
        blockedOne = true;
        await this.recordEvent(tx, {
          data: { blockedBy, error },
          idempotencyKey: `node:${node.id}:blocked:${transitionKey}`,
          runId,
          runNodeId: node.id,
          status: 'blocked',
          type: 'node.blocked',
        });
      }
    }

    for (const node of nodes) {
      const status = statusByKey.get(node.nodeKey);
      if (
        status !== 'pending' &&
        !(status === 'blocked' && node.completionReason === 'dependency_failed')
      ) {
        continue;
      }
      if (node.dependencies.length === 0) continue;
      const dependenciesReady = node.dependencies.every((dependencyKey) => {
        const dependencyStatus = statusByKey.get(dependencyKey);
        return dependencyStatus === 'completed' || dependencyStatus === 'skipped';
      });
      if (!dependenciesReady) continue;

      const [updated] = await tx
        .update(agentGroupRunNodes)
        .set({ completionReason: null, error: null, status: 'ready' })
        .where(
          and(
            eq(agentGroupRunNodes.id, node.id),
            inArray(agentGroupRunNodes.status, ['pending', 'blocked']),
          ),
        )
        .returning({ id: agentGroupRunNodes.id });
      if (!updated) continue;

      statusByKey.set(node.nodeKey, 'ready');
      await this.recordEvent(tx, {
        data: { dependencies: node.dependencies },
        idempotencyKey: `node:${node.id}:ready:${transitionKey}`,
        runId,
        runNodeId: node.id,
        status: 'ready',
        type: 'node.ready',
      });
    }
  };

  private settleRunIfTerminal = async (tx: Transaction, runId: string, transitionKey: string) => {
    const nodeStatuses = await tx
      .select({ status: agentGroupRunNodes.status })
      .from(agentGroupRunNodes)
      .where(eq(agentGroupRunNodes.runId, runId));
    if (
      nodeStatuses.length === 0 ||
      nodeStatuses.some((node) => !TERMINAL_NODE_STATUSES.includes(node.status))
    ) {
      return;
    }

    const hasFailure = nodeStatuses.some(
      (node) => node.status === 'failed' || node.status === 'blocked',
    );
    const hasCancellation = nodeStatuses.some((node) => node.status === 'cancelled');
    const status = hasFailure ? 'failed' : hasCancellation ? 'cancelled' : 'completed';
    const [updated] = await tx
      .update(agentGroupRuns)
      .set({ completedAt: new Date(), completionReason: status, status })
      .where(
        and(
          eq(agentGroupRuns.id, runId),
          inArray(agentGroupRuns.status, ['pending', 'running', 'waiting', 'cancelling']),
          not(
            and(
              eq(agentGroupRuns.status, 'waiting'),
              eq(agentGroupRuns.completionReason, AGENT_GROUP_RUN_MANUAL_PAUSE_REASON),
            )!,
          ),
        ),
      )
      .returning({ id: agentGroupRuns.id });
    if (updated) {
      await this.recordEvent(tx, {
        idempotencyKey: `run:terminal:${status}:${transitionKey}`,
        runId,
        status,
        type: 'run.terminal',
      });
    }
  };

  create = async (params: CreateAgentGroupRunParams): Promise<AgentGroupRunSnapshot> => {
    const createResult = await this.db.transaction(async (tx) => {
      const [group] = await tx
        .select({ id: chatGroups.id })
        .from(chatGroups)
        .where(and(eq(chatGroups.id, params.chatGroupId), this.groupAccess()))
        .limit(1);

      if (!group) throw new Error(AGENT_GROUP_RUN_NOT_FOUND);

      const findExisting = () =>
        tx
          .select()
          .from(agentGroupRuns)
          .where(and(eq(agentGroupRuns.idempotencyKey, params.idempotencyKey), this.runScope()))
          .limit(1);

      const [existing] = await findExisting();
      if (existing) {
        if (
          existing.chatGroupId !== params.chatGroupId ||
          existing.planHash !== params.planHash ||
          existing.supervisorOperationId !== params.supervisorOperationId
        ) {
          throw new Error(AGENT_GROUP_RUN_IDEMPOTENCY_CONFLICT);
        }
        return { created: false, runId: existing.id };
      }

      const [supervisorOperation] = await tx
        .select({
          agentId: agentOperations.agentId,
          chatGroupId: agentOperations.chatGroupId,
        })
        .from(agentOperations)
        .where(and(eq(agentOperations.id, params.supervisorOperationId), this.operationScope()))
        .limit(1);
      if (
        !supervisorOperation ||
        supervisorOperation.agentId !== params.supervisorAgentId ||
        supervisorOperation.chatGroupId !== params.chatGroupId
      ) {
        throw new Error(AGENT_GROUP_RUN_OPERATION_MISMATCH);
      }

      const [created] = await tx
        .insert(agentGroupRuns)
        .values(
          buildWorkspacePayload(
            { userId: this.userId, workspaceId: this.workspaceId },
            {
              budgetSnapshot: params.budgetSnapshot,
              chatGroupId: params.chatGroupId,
              idempotencyKey: params.idempotencyKey,
              planHash: params.planHash,
              planSnapshot: params.planSnapshot,
              planVersion: params.planSnapshot.version,
              policySnapshot: params.policySnapshot,
              protocol: params.planSnapshot.protocol,
              supervisorAgentId: params.supervisorAgentId,
              supervisorOperationId: params.supervisorOperationId,
              threadId: params.threadId,
              topicId: params.topicId,
            },
          ),
        )
        .onConflictDoNothing()
        .returning();

      if (!created) {
        const [winner] = await findExisting();
        if (
          !winner ||
          winner.chatGroupId !== params.chatGroupId ||
          winner.planHash !== params.planHash ||
          winner.supervisorOperationId !== params.supervisorOperationId
        ) {
          throw new Error(AGENT_GROUP_RUN_IDEMPOTENCY_CONFLICT);
        }
        return { created: false, runId: winner.id };
      }

      const createdNodes = await tx
        .insert(agentGroupRunNodes)
        .values(
          params.planSnapshot.nodes.map((node) => ({
            agentId: node.agentId,
            barrierKey: node.barrierKey,
            dependencies: node.dependencies,
            executionPolicySnapshot: node.executionPolicy,
            instruction: node.instruction,
            maxAttempts: node.maxAttempts,
            nodeKey: node.key,
            role: node.role,
            runId: created.id,
            sortOrder: node.sortOrder,
            status:
              params.planSnapshot.protocol === 'pipeline' && node.dependencies.length === 0
                ? ('ready' as const)
                : ('pending' as const),
            timeoutMs: node.timeoutMs,
            toolPolicySnapshot: node.toolPolicy,
          })),
        )
        .returning({
          id: agentGroupRunNodes.id,
          nodeKey: agentGroupRunNodes.nodeKey,
          status: agentGroupRunNodes.status,
        });

      await this.recordEvent(tx, {
        data: { planHash: params.planHash, protocol: params.planSnapshot.protocol },
        idempotencyKey: 'run:created',
        runId: created.id,
        status: 'pending',
        type: 'run.created',
      });
      for (const node of createdNodes) {
        await this.recordEvent(tx, {
          data: { nodeKey: node.nodeKey },
          idempotencyKey: `node:${node.id}:created`,
          runId: created.id,
          runNodeId: node.id,
          status: node.status,
          type: 'node.created',
        });
        if (node.status === 'ready') {
          await this.recordEvent(tx, {
            data: { dependencies: [] },
            idempotencyKey: `node:${node.id}:ready:initial`,
            runId: created.id,
            runNodeId: node.id,
            status: 'ready',
            type: 'node.ready',
          });
        }
      }

      return { created: true, runId: created.id };
    });

    const snapshot = await this.findById(createResult.runId);
    if (!snapshot) throw new Error(AGENT_GROUP_RUN_NOT_FOUND);
    return { ...snapshot, created: createResult.created };
  };

  findById = async (runId: string): Promise<AgentGroupRunSnapshot | undefined> => {
    const [row] = await this.db
      .select({ run: agentGroupRuns })
      .from(agentGroupRuns)
      .innerJoin(chatGroups, eq(agentGroupRuns.chatGroupId, chatGroups.id))
      .where(and(eq(agentGroupRuns.id, runId), this.groupAccess()))
      .limit(1);

    if (!row) return undefined;

    const nodes = await this.db
      .select()
      .from(agentGroupRunNodes)
      .where(eq(agentGroupRunNodes.runId, runId))
      .orderBy(asc(agentGroupRunNodes.sortOrder), asc(agentGroupRunNodes.id));

    const attempts =
      nodes.length === 0
        ? []
        : await this.db
            .select()
            .from(agentGroupRunAttempts)
            .where(
              inArray(
                agentGroupRunAttempts.runNodeId,
                nodes.map((node) => node.id),
              ),
            )
            .orderBy(asc(agentGroupRunAttempts.runNodeId), asc(agentGroupRunAttempts.attemptNo));

    const operationIds = Array.from(
      new Set([row.run.supervisorOperationId, ...attempts.map((attempt) => attempt.operationId)]),
    );
    const operationRows = await this.db
      .select()
      .from(agentOperations)
      .where(and(inArray(agentOperations.id, operationIds), this.operationScope()));
    const operationMap = new Map(operationRows.map((operation) => [operation.id, operation]));
    const operations = operationIds.flatMap((id) => {
      const operation = operationMap.get(id);
      return operation ? [operation] : [];
    });

    return { attempts, nodes, operations, run: row.run };
  };

  listByChatGroup = async (chatGroupId: string, limit = 20): Promise<AgentGroupRunSnapshot[]> => {
    const rows = await this.db
      .select({ id: agentGroupRuns.id })
      .from(agentGroupRuns)
      .innerJoin(chatGroups, eq(agentGroupRuns.chatGroupId, chatGroups.id))
      .where(and(eq(agentGroupRuns.chatGroupId, chatGroupId), this.groupAccess()))
      .orderBy(desc(agentGroupRuns.createdAt), desc(agentGroupRuns.id))
      .limit(Math.max(1, Math.min(limit, 50)));

    const snapshots = await Promise.all(rows.map(({ id }) => this.findById(id)));
    return snapshots.filter((snapshot): snapshot is AgentGroupRunSnapshot => Boolean(snapshot));
  };

  listEvents = async (runId: string, limit = 200) => {
    const accessible = await this.findById(runId);
    if (!accessible) return undefined;

    return this.db
      .select()
      .from(agentGroupRunEvents)
      .where(eq(agentGroupRunEvents.runId, runId))
      .orderBy(asc(agentGroupRunEvents.sequence))
      .limit(Math.max(1, Math.min(limit, 1000)));
  };

  /**
   * Verify that a callback still belongs to the newest immutable Attempt for
   * its node. Completion delivery is at-least-once, so an attemptNo=1 webhook
   * can arrive after attemptNo=2 has already replaced its message projection.
   */
  isLatestAttempt = async (
    params: Pick<CreateAgentGroupRunAttemptParams, 'attemptNo' | 'operationId' | 'runNodeId'>,
  ): Promise<boolean> =>
    this.db.transaction(async (tx) => {
      const node = await this.loadAccessibleNode(tx, params.runNodeId);
      const [latest] = await tx
        .select({
          attemptNo: agentGroupRunAttempts.attemptNo,
          operationId: agentGroupRunAttempts.operationId,
        })
        .from(agentGroupRunAttempts)
        .where(eq(agentGroupRunAttempts.runNodeId, node.id))
        .orderBy(desc(agentGroupRunAttempts.attemptNo))
        .limit(1);

      return latest?.attemptNo === params.attemptNo && latest.operationId === params.operationId;
    });

  /**
   * Pause only at the supervisor's durable async-tool barrier. Member Attempts
   * keep running and may settle while paused; the parked operation status is
   * the CAS that prevents callbacks and watchdogs from resuming the supervisor.
   */
  pauseAtBarrier = async (runId: string): Promise<AgentGroupRunSnapshot> => {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ run: agentGroupRuns })
        .from(agentGroupRuns)
        .innerJoin(chatGroups, eq(agentGroupRuns.chatGroupId, chatGroups.id))
        .where(and(eq(agentGroupRuns.id, runId), this.groupAccess()))
        .limit(1);
      if (!row) throw new Error(AGENT_GROUP_RUN_NOT_FOUND);

      const [operation] = await tx
        .select({ status: agentOperations.status })
        .from(agentOperations)
        .where(and(eq(agentOperations.id, row.run.supervisorOperationId), this.operationScope()))
        .limit(1);
      const alreadyPaused =
        row.run.status === 'waiting' &&
        row.run.completionReason === AGENT_GROUP_RUN_MANUAL_PAUSE_REASON;
      if (
        (!alreadyPaused && !['pending', 'running', 'waiting'].includes(row.run.status)) ||
        !operation ||
        !['waiting_for_async_tool', 'waiting_for_group_resume'].includes(operation.status)
      ) {
        throw new Error(AGENT_GROUP_RUN_PAUSE_NOT_ALLOWED);
      }

      if (operation.status === 'waiting_for_async_tool') {
        const [parked] = await tx
          .update(agentOperations)
          .set({ status: 'waiting_for_group_resume' })
          .where(
            and(
              eq(agentOperations.id, row.run.supervisorOperationId),
              eq(agentOperations.status, 'waiting_for_async_tool'),
              this.operationScope(),
            ),
          )
          .returning({ id: agentOperations.id });
        if (!parked) throw new Error(AGENT_GROUP_RUN_PAUSE_NOT_ALLOWED);
      }

      if (!alreadyPaused) {
        await tx
          .update(agentGroupRuns)
          .set({ completionReason: AGENT_GROUP_RUN_MANUAL_PAUSE_REASON, status: 'waiting' })
          .where(eq(agentGroupRuns.id, runId));
        await this.recordEvent(tx, {
          data: { previousStatus: row.run.status },
          idempotencyKey: `run:paused:${row.run.updatedAt.getTime()}`,
          operationId: row.run.supervisorOperationId,
          runId,
          status: 'waiting',
          type: 'run.paused',
        });
      }
    });

    const snapshot = await this.findById(runId);
    if (!snapshot) throw new Error(AGENT_GROUP_RUN_NOT_FOUND);
    return snapshot;
  };

  /** Release a manual barrier pause and re-evaluate terminal node convergence. */
  resumeFromBarrier = async (runId: string): Promise<AgentGroupRunSnapshot> => {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ run: agentGroupRuns })
        .from(agentGroupRuns)
        .innerJoin(chatGroups, eq(agentGroupRuns.chatGroupId, chatGroups.id))
        .where(and(eq(agentGroupRuns.id, runId), this.groupAccess()))
        .limit(1);
      if (!row) throw new Error(AGENT_GROUP_RUN_NOT_FOUND);
      if (
        row.run.status !== 'waiting' ||
        row.run.completionReason !== AGENT_GROUP_RUN_MANUAL_PAUSE_REASON
      ) {
        throw new Error(AGENT_GROUP_RUN_RESUME_NOT_ALLOWED);
      }

      const [operation] = await tx
        .select({ status: agentOperations.status })
        .from(agentOperations)
        .where(and(eq(agentOperations.id, row.run.supervisorOperationId), this.operationScope()))
        .limit(1);
      if (
        !operation ||
        !['waiting_for_group_resume', 'waiting_for_async_tool'].includes(operation.status)
      ) {
        throw new Error(AGENT_GROUP_RUN_RESUME_NOT_ALLOWED);
      }

      if (operation.status === 'waiting_for_group_resume') {
        const [released] = await tx
          .update(agentOperations)
          .set({ status: 'waiting_for_async_tool' })
          .where(
            and(
              eq(agentOperations.id, row.run.supervisorOperationId),
              eq(agentOperations.status, 'waiting_for_group_resume'),
              this.operationScope(),
            ),
          )
          .returning({ id: agentOperations.id });
        if (!released) throw new Error(AGENT_GROUP_RUN_RESUME_NOT_ALLOWED);
      }

      const transitionKey = `resume:${row.run.updatedAt.getTime()}`;
      await tx
        .update(agentGroupRuns)
        .set({ completionReason: null, status: 'running' })
        .where(eq(agentGroupRuns.id, runId));
      await this.recordEvent(tx, {
        idempotencyKey: `run:resumed:${row.run.updatedAt.getTime()}`,
        operationId: row.run.supervisorOperationId,
        runId,
        status: 'running',
        type: 'run.resumed',
      });
      await this.settleRunIfTerminal(tx, runId, transitionKey);
    });

    const snapshot = await this.findById(runId);
    if (!snapshot) throw new Error(AGENT_GROUP_RUN_NOT_FOUND);
    return snapshot;
  };

  createAttempt = async (params: CreateAgentGroupRunAttemptParams) =>
    this.db.transaction(async (tx) => {
      const { attempt, node } = await this.ensureAttempt(tx, params);
      if (TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)) return attempt;

      const startedAt = attempt.startedAt ?? new Date();
      const [updated] = await tx
        .update(agentGroupRunAttempts)
        .set({ startedAt, status: 'running' })
        .where(eq(agentGroupRunAttempts.id, attempt.id))
        .returning();
      await tx
        .update(agentGroupRunNodes)
        .set({ status: 'running' })
        .where(
          and(
            eq(agentGroupRunNodes.id, node.id),
            inArray(agentGroupRunNodes.status, ['pending', 'ready']),
          ),
        );
      await tx
        .update(agentGroupRuns)
        .set({ startedAt, status: 'running' })
        .where(and(eq(agentGroupRuns.id, node.runId), eq(agentGroupRuns.status, 'pending')));

      await this.recordEvent(tx, {
        attemptId: updated.id,
        idempotencyKey: `attempt:${updated.id}:running`,
        operationId: params.operationId,
        runId: node.runId,
        runNodeId: node.id,
        status: 'running',
        type: 'attempt.started',
      });
      await this.recordEvent(tx, {
        idempotencyKey: `node:${node.id}:running`,
        runId: node.runId,
        runNodeId: node.id,
        status: 'running',
        type: 'node.started',
      });
      await this.recordEvent(tx, {
        idempotencyKey: 'run:running',
        runId: node.runId,
        status: 'running',
        type: 'run.started',
      });

      return updated;
    });

  /**
   * Commit a leased pipeline dispatch only when the caller still owns the
   * fencing token. Replayed prepared callbacks for the same operation remain
   * idempotent after the lease fields have been cleared.
   */
  createClaimedAttempt = async (params: CreateClaimedAgentGroupRunAttemptParams) =>
    this.db.transaction(async (tx) => {
      const { dispatchClaimId, ...attemptParams } = params;
      const { attempt, node } = await this.ensureAttempt(tx, attemptParams, {
        dispatchClaimId,
      });
      if (TERMINAL_ATTEMPT_STATUSES.includes(attempt.status) || attempt.status === 'running') {
        return attempt;
      }

      const startedAt = attempt.startedAt ?? new Date();
      const [updated] = await tx
        .update(agentGroupRunAttempts)
        .set({ startedAt, status: 'running' })
        .where(eq(agentGroupRunAttempts.id, attempt.id))
        .returning();
      const [committedNode] = await tx
        .update(agentGroupRunNodes)
        .set({
          dispatchClaimedAt: null,
          dispatchClaimExpiresAt: null,
          dispatchClaimId: null,
          status: 'running',
        })
        .where(
          and(
            eq(agentGroupRunNodes.id, node.id),
            eq(agentGroupRunNodes.status, 'ready'),
            eq(agentGroupRunNodes.dispatchClaimId, dispatchClaimId),
          ),
        )
        .returning({ id: agentGroupRunNodes.id });
      if (!committedNode) throw new Error(AGENT_GROUP_RUN_DISPATCH_CLAIM_CONFLICT);

      await tx
        .update(agentGroupRuns)
        .set({ startedAt, status: 'running' })
        .where(and(eq(agentGroupRuns.id, node.runId), eq(agentGroupRuns.status, 'pending')));
      await this.recordEvent(tx, {
        attemptId: updated.id,
        data: { claimId: dispatchClaimId },
        idempotencyKey: `node:${node.id}:dispatch-committed:${dispatchClaimId}`,
        operationId: attemptParams.operationId,
        runId: node.runId,
        runNodeId: node.id,
        status: 'running',
        type: 'node.dispatch_committed',
      });
      await this.recordEvent(tx, {
        attemptId: updated.id,
        idempotencyKey: `attempt:${updated.id}:running`,
        operationId: attemptParams.operationId,
        runId: node.runId,
        runNodeId: node.id,
        status: 'running',
        type: 'attempt.started',
      });
      await this.recordEvent(tx, {
        idempotencyKey: `node:${node.id}:running`,
        runId: node.runId,
        runNodeId: node.id,
        status: 'running',
        type: 'node.started',
      });
      await this.recordEvent(tx, {
        idempotencyKey: 'run:running',
        runId: node.runId,
        status: 'running',
        type: 'run.started',
      });

      return updated;
    });

  /**
   * Project a member's durable human-intervention park into the collaboration
   * state machine. This is a gate, not a completion: the member anchor and the
   * supervisor barrier must remain untouched until a continuation reaches a
   * real terminal lifecycle.
   */
  parkAttemptForIntervention = async (params: ParkAgentGroupRunAttemptParams) =>
    this.db.transaction(async (tx) => {
      const { attempt, node } = await this.ensureAttempt(tx, params);
      if (TERMINAL_ATTEMPT_STATUSES.includes(attempt.status) || attempt.status === 'waiting') {
        return attempt;
      }

      const startedAt = attempt.startedAt ?? new Date();
      const [updated] = await tx
        .update(agentGroupRunAttempts)
        .set({
          completionReason: AGENT_GROUP_RUN_INTERVENTION_REASON,
          startedAt,
          status: 'waiting',
        })
        .where(eq(agentGroupRunAttempts.id, attempt.id))
        .returning();
      await tx
        .update(agentGroupRunNodes)
        .set({ completionReason: AGENT_GROUP_RUN_INTERVENTION_REASON, status: 'waiting' })
        .where(
          and(
            eq(agentGroupRunNodes.id, node.id),
            inArray(agentGroupRunNodes.status, ['pending', 'ready', 'running', 'waiting']),
          ),
        );
      const [gatedRun] = await tx
        .update(agentGroupRuns)
        .set({
          completionReason: AGENT_GROUP_RUN_INTERVENTION_REASON,
          startedAt,
          status: 'waiting',
        })
        .where(
          and(
            eq(agentGroupRuns.id, node.runId),
            inArray(agentGroupRuns.status, ['pending', 'running']),
          ),
        )
        .returning({ id: agentGroupRuns.id });

      await this.recordEvent(tx, {
        attemptId: updated.id,
        data: { completionReason: AGENT_GROUP_RUN_INTERVENTION_REASON },
        idempotencyKey: `attempt:${updated.id}:waiting_for_human`,
        operationId: params.operationId,
        runId: node.runId,
        runNodeId: node.id,
        status: 'waiting',
        type: 'attempt.intervention_required',
      });
      await this.recordEvent(tx, {
        attemptId: updated.id,
        idempotencyKey: `node:${node.id}:attempt:${updated.id}:waiting_for_human`,
        operationId: params.operationId,
        runId: node.runId,
        runNodeId: node.id,
        status: 'waiting',
        type: 'node.intervention_required',
      });
      if (gatedRun) {
        await this.recordEvent(tx, {
          attemptId: updated.id,
          idempotencyKey: `run:intervention_required:${updated.id}`,
          operationId: params.operationId,
          runId: node.runId,
          runNodeId: node.id,
          status: 'waiting',
          type: 'run.intervention_required',
        });
      }

      return updated;
    });

  /**
   * Re-open one terminal node as a new immutable Attempt.
   *
   * The member operation row and Redis state already exist when this method is
   * called, but its first queue delivery has not been scheduled yet. The
   * `(run_node_id, attempt_no)` uniqueness constraint is therefore the final
   * concurrency guard: only one retry can win, and a redelivery using the same
   * operation id reads back the existing Attempt idempotently.
   */
  startRetryAttempt = async (params: StartAgentGroupRunNodeRetryParams) =>
    this.db.transaction(async (tx) => {
      const node = await this.loadAccessibleNode(tx, params.runNodeId);
      const [existingByOperation] = await tx
        .select()
        .from(agentGroupRunAttempts)
        .where(eq(agentGroupRunAttempts.operationId, params.operationId))
        .limit(1);
      if (existingByOperation) {
        if (
          existingByOperation.runNodeId !== params.runNodeId ||
          existingByOperation.attemptNo !== params.attemptNo
        ) {
          throw new Error(AGENT_GROUP_RUN_OPERATION_MISMATCH);
        }
        return existingByOperation;
      }

      if (
        !RETRYABLE_NODE_STATUSES.includes(node.status) ||
        !TERMINAL_RUN_STATUSES.includes(node.runStatus as (typeof TERMINAL_RUN_STATUSES)[number])
      ) {
        throw new Error(AGENT_GROUP_RUN_RETRY_NOT_ALLOWED);
      }

      const [latestAttempt] = await tx
        .select()
        .from(agentGroupRunAttempts)
        .where(eq(agentGroupRunAttempts.runNodeId, node.id))
        .orderBy(desc(agentGroupRunAttempts.attemptNo))
        .limit(1);
      if (latestAttempt && !TERMINAL_ATTEMPT_STATUSES.includes(latestAttempt.status)) {
        throw new Error(AGENT_GROUP_RUN_RETRY_NOT_ALLOWED);
      }

      const expectedAttemptNo = (latestAttempt?.attemptNo ?? 0) + 1;
      if (params.attemptNo !== expectedAttemptNo || params.attemptNo < 2) {
        throw new Error(AGENT_GROUP_RUN_RETRY_NOT_ALLOWED);
      }
      if (params.attemptNo > node.maxAttempts) {
        throw new Error(AGENT_GROUP_RUN_RETRY_LIMIT_EXCEEDED);
      }

      const { attempt } = await this.ensureAttempt(tx, params, { allowTerminalNode: true });
      const startedAt = new Date();
      const [updated] = await tx
        .update(agentGroupRunAttempts)
        .set({ startedAt, status: 'running' })
        .where(eq(agentGroupRunAttempts.id, attempt.id))
        .returning();
      await tx
        .update(agentGroupRunNodes)
        .set({ completionReason: null, error: null, status: 'running' })
        .where(eq(agentGroupRunNodes.id, node.id));
      await tx
        .update(agentGroupRuns)
        .set({ completedAt: null, completionReason: null, error: null, status: 'running' })
        .where(eq(agentGroupRuns.id, node.runId));

      await this.recordEvent(tx, {
        attemptId: updated.id,
        idempotencyKey: `attempt:${updated.id}:running`,
        operationId: params.operationId,
        runId: node.runId,
        runNodeId: node.id,
        status: 'running',
        type: 'attempt.started',
      });
      await this.recordEvent(tx, {
        attemptId: updated.id,
        data: { attemptNo: params.attemptNo },
        idempotencyKey: `node:${node.id}:retry:${params.attemptNo}`,
        operationId: params.operationId,
        runId: node.runId,
        runNodeId: node.id,
        status: 'running',
        type: 'node.retry_started',
      });
      await this.recordEvent(tx, {
        attemptId: updated.id,
        data: { attemptNo: params.attemptNo },
        idempotencyKey: `run:retry:${node.id}:${params.attemptNo}`,
        operationId: params.operationId,
        runId: node.runId,
        runNodeId: node.id,
        status: 'running',
        type: 'run.reopened',
      });

      return updated;
    });

  completeAttempt = async (params: CompleteAgentGroupRunAttemptParams) =>
    this.db.transaction(async (tx) => {
      const { attempt, node } = await this.ensureAttempt(tx, params);
      if (TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)) return attempt;

      const nodeStatus: AgentGroupRunNodeStatus =
        params.status === 'completed'
          ? 'completed'
          : params.status === 'cancelled'
            ? 'cancelled'
            : 'failed';
      const completedAt = new Date();
      const [updated] = await tx
        .update(agentGroupRunAttempts)
        .set({
          completedAt,
          completionReason: params.completionReason,
          error: params.error,
          outputSnapshot: params.outputSnapshot,
          startedAt: attempt.startedAt ?? completedAt,
          status: params.status,
        })
        .where(eq(agentGroupRunAttempts.id, attempt.id))
        .returning();
      await tx
        .update(agentGroupRunNodes)
        .set({
          completionReason: params.completionReason,
          dispatchClaimedAt: null,
          dispatchClaimExpiresAt: null,
          dispatchClaimId: null,
          error: params.error,
          status: nodeStatus,
        })
        .where(eq(agentGroupRunNodes.id, node.id));
      const [{ waitingCount = 0 } = {}] = await tx
        .select({ waitingCount: sql<number>`count(*)::int` })
        .from(agentGroupRunAttempts)
        .innerJoin(agentGroupRunNodes, eq(agentGroupRunAttempts.runNodeId, agentGroupRunNodes.id))
        .where(
          and(
            eq(agentGroupRunNodes.runId, node.runId),
            eq(agentGroupRunAttempts.status, 'waiting'),
          ),
        );
      const [releasedRun] =
        waitingCount === 0
          ? await tx
              .update(agentGroupRuns)
              .set({ completionReason: null, status: 'running' })
              .where(
                and(
                  eq(agentGroupRuns.id, node.runId),
                  eq(agentGroupRuns.status, 'waiting'),
                  eq(agentGroupRuns.completionReason, AGENT_GROUP_RUN_INTERVENTION_REASON),
                ),
              )
              .returning({ id: agentGroupRuns.id })
          : [];
      await tx
        .update(agentGroupRuns)
        .set({ startedAt: attempt.startedAt ?? completedAt, status: 'running' })
        .where(and(eq(agentGroupRuns.id, node.runId), eq(agentGroupRuns.status, 'pending')));
      if (releasedRun) {
        await this.recordEvent(tx, {
          attemptId: updated.id,
          idempotencyKey: `run:intervention_cleared:${updated.id}`,
          operationId: params.operationId,
          runId: node.runId,
          runNodeId: node.id,
          status: 'running',
          type: 'run.intervention_cleared',
        });
      }
      await this.recordEvent(tx, {
        attemptId: updated.id,
        data:
          params.error || params.outputSnapshot
            ? { error: params.error, outputSnapshot: params.outputSnapshot }
            : undefined,
        idempotencyKey: `attempt:${updated.id}:terminal:${params.status}`,
        operationId: params.operationId,
        runId: node.runId,
        runNodeId: node.id,
        status: params.status,
        type: 'attempt.terminal',
      });
      await this.recordEvent(tx, {
        data: { completionReason: params.completionReason },
        idempotencyKey: `node:${node.id}:attempt:${updated.id}:terminal:${nodeStatus}`,
        runId: node.runId,
        runNodeId: node.id,
        status: nodeStatus,
        type: 'node.terminal',
      });
      await this.advancePipeline(tx, node.runId, `attempt:${updated.id}`);
      await this.settleRunIfTerminal(tx, node.runId, `attempt:${updated.id}`);

      return updated;
    });

  failNodeStart = async (params: FailAgentGroupRunNodeStartParams) =>
    this.db.transaction(async (tx) => {
      const node = await this.loadAccessibleNode(tx, params.runNodeId);
      await tx
        .update(agentGroupRunNodes)
        .set({
          completionReason: 'start_failed',
          dispatchClaimedAt: null,
          dispatchClaimExpiresAt: null,
          dispatchClaimId: null,
          error: params.error,
          status: 'failed',
        })
        .where(
          and(
            eq(agentGroupRunNodes.id, node.id),
            inArray(agentGroupRunNodes.status, ['pending', 'ready']),
          ),
        );
      await this.recordEvent(tx, {
        data: { error: params.error },
        idempotencyKey: `node:${node.id}:terminal:failed`,
        runId: node.runId,
        runNodeId: node.id,
        status: 'failed',
        type: 'node.terminal',
      });
      await this.advancePipeline(tx, node.runId, `node:${node.id}:start_failed`);
      await this.settleRunIfTerminal(tx, node.runId, `node:${node.id}:start_failed`);
    });

  beginCancellation = async (runId: string): Promise<BeginAgentGroupRunCancellationResult> => {
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ run: agentGroupRuns })
        .from(agentGroupRuns)
        .innerJoin(chatGroups, eq(agentGroupRuns.chatGroupId, chatGroups.id))
        .where(and(eq(agentGroupRuns.id, runId), this.groupAccess()))
        .limit(1);
      if (!row) throw new Error(AGENT_GROUP_RUN_NOT_FOUND);

      const alreadyTerminal = TERMINAL_RUN_STATUSES.includes(
        row.run.status as (typeof TERMINAL_RUN_STATUSES)[number],
      );
      if (!alreadyTerminal && row.run.status !== 'cancelling') {
        await tx
          .update(agentGroupRuns)
          .set({ completionReason: 'cancellation_requested', status: 'cancelling' })
          .where(eq(agentGroupRuns.id, runId));
        await this.recordEvent(tx, {
          idempotencyKey: 'run:cancelling',
          runId,
          status: 'cancelling',
          type: 'run.cancelling',
        });
      }

      const activeAttempts = await tx
        .select({ operationId: agentGroupRunAttempts.operationId })
        .from(agentGroupRunAttempts)
        .innerJoin(agentGroupRunNodes, eq(agentGroupRunAttempts.runNodeId, agentGroupRunNodes.id))
        .where(
          and(
            eq(agentGroupRunNodes.runId, runId),
            inArray(agentGroupRunAttempts.status, ACTIVE_ATTEMPT_STATUSES),
          ),
        );

      return {
        activeOperationIds: activeAttempts.map(({ operationId }) => operationId),
        alreadyTerminal,
        supervisorOperationId: row.run.supervisorOperationId,
      };
    });

    const snapshot = await this.findById(runId);
    if (!snapshot) throw new Error(AGENT_GROUP_RUN_NOT_FOUND);
    return { ...result, snapshot };
  };

  finalizeCancellation = async (runId: string): Promise<AgentGroupRunSnapshot> => {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: agentGroupRuns.id })
        .from(agentGroupRuns)
        .innerJoin(chatGroups, eq(agentGroupRuns.chatGroupId, chatGroups.id))
        .where(and(eq(agentGroupRuns.id, runId), this.groupAccess()))
        .limit(1);
      if (!row) throw new Error(AGENT_GROUP_RUN_NOT_FOUND);

      const activeAttempts = await tx
        .select({
          id: agentGroupRunAttempts.id,
          operationId: agentGroupRunAttempts.operationId,
          runNodeId: agentGroupRunAttempts.runNodeId,
        })
        .from(agentGroupRunAttempts)
        .innerJoin(agentGroupRunNodes, eq(agentGroupRunAttempts.runNodeId, agentGroupRunNodes.id))
        .where(
          and(
            eq(agentGroupRunNodes.runId, runId),
            inArray(agentGroupRunAttempts.status, ACTIVE_ATTEMPT_STATUSES),
          ),
        );
      const completedAt = new Date();
      if (activeAttempts.length > 0) {
        await tx
          .update(agentGroupRunAttempts)
          .set({ completedAt, status: 'cancelled' })
          .where(
            inArray(
              agentGroupRunAttempts.id,
              activeAttempts.map(({ id }) => id),
            ),
          );
      }
      await tx
        .update(agentGroupRunNodes)
        .set({
          completionReason: 'cancelled',
          dispatchClaimedAt: null,
          dispatchClaimExpiresAt: null,
          dispatchClaimId: null,
          status: 'cancelled',
        })
        .where(
          and(
            eq(agentGroupRunNodes.runId, runId),
            inArray(agentGroupRunNodes.status, [
              'pending',
              'ready',
              'running',
              'waiting',
              'blocked',
            ]),
          ),
        );
      await tx
        .update(agentGroupRuns)
        .set({ completedAt, completionReason: 'cancelled', status: 'cancelled' })
        .where(
          and(
            eq(agentGroupRuns.id, runId),
            inArray(agentGroupRuns.status, ['pending', 'running', 'waiting', 'cancelling']),
          ),
        );

      for (const attempt of activeAttempts) {
        await this.recordEvent(tx, {
          attemptId: attempt.id,
          idempotencyKey: `attempt:${attempt.id}:terminal:cancelled`,
          operationId: attempt.operationId,
          runId,
          runNodeId: attempt.runNodeId,
          status: 'cancelled',
          type: 'attempt.terminal',
        });
      }
      await this.recordEvent(tx, {
        idempotencyKey: 'run:terminal:cancelled',
        runId,
        status: 'cancelled',
        type: 'run.terminal',
      });
    });

    const snapshot = await this.findById(runId);
    if (!snapshot) throw new Error(AGENT_GROUP_RUN_NOT_FOUND);
    return snapshot;
  };
}
