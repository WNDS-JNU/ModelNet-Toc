import type {
  AgentGroupRunAttemptStatus,
  AgentGroupRunBudgetSnapshot,
  AgentGroupRunError,
  AgentGroupRunExternalExecutionRef,
  AgentGroupRunNodeStatus,
  AgentGroupRunPlanSnapshot,
  AgentGroupRunPolicySnapshot,
  AgentGroupRunRuntimeKind,
} from '@lobechat/types';
import { and, asc, eq, inArray } from 'drizzle-orm';

import {
  agentGroupRunAttempts,
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

export interface CompleteAgentGroupRunAttemptParams extends CreateAgentGroupRunAttemptParams {
  completionReason: string;
  error?: AgentGroupRunError;
  status: Extract<AgentGroupRunAttemptStatus, 'cancelled' | 'completed' | 'failed' | 'timed_out'>;
}

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

const TERMINAL_ATTEMPT_STATUSES: AgentGroupRunAttemptStatus[] = [
  'cancelled',
  'completed',
  'failed',
  'timed_out',
];
const TERMINAL_NODE_STATUSES: AgentGroupRunNodeStatus[] = [
  'cancelled',
  'completed',
  'failed',
  'skipped',
];

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

  private loadAccessibleNode = async (tx: Transaction, runNodeId: string) => {
    const [node] = await tx
      .select({
        agentId: agentGroupRunNodes.agentId,
        chatGroupId: agentGroupRuns.chatGroupId,
        id: agentGroupRunNodes.id,
        runId: agentGroupRunNodes.runId,
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

  private settleRunIfTerminal = async (tx: Transaction, runId: string) => {
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

    const hasFailure = nodeStatuses.some((node) => node.status === 'failed');
    const hasCancellation = nodeStatuses.some((node) => node.status === 'cancelled');
    const status = hasFailure ? 'failed' : hasCancellation ? 'cancelled' : 'completed';
    await tx
      .update(agentGroupRuns)
      .set({ completedAt: new Date(), completionReason: status, status })
      .where(eq(agentGroupRuns.id, runId));
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

      await tx.insert(agentGroupRunNodes).values(
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
          timeoutMs: node.timeoutMs,
          toolPolicySnapshot: node.toolPolicy,
        })),
      );

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
          error: params.error,
          startedAt: attempt.startedAt ?? completedAt,
          status: params.status,
        })
        .where(eq(agentGroupRunAttempts.id, attempt.id))
        .returning();
      await tx
        .update(agentGroupRunNodes)
        .set({
          completionReason: params.completionReason,
          error: params.error,
          status: nodeStatus,
        })
        .where(eq(agentGroupRunNodes.id, node.id));
      await tx
        .update(agentGroupRuns)
        .set({ startedAt: attempt.startedAt ?? completedAt, status: 'running' })
        .where(and(eq(agentGroupRuns.id, node.runId), eq(agentGroupRuns.status, 'pending')));
      await this.settleRunIfTerminal(tx, node.runId);

      return updated;
    });

  failNodeStart = async (params: FailAgentGroupRunNodeStartParams) =>
    this.db.transaction(async (tx) => {
      const node = await this.loadAccessibleNode(tx, params.runNodeId);
      await tx
        .update(agentGroupRunNodes)
        .set({ completionReason: 'start_failed', error: params.error, status: 'failed' })
        .where(
          and(
            eq(agentGroupRunNodes.id, node.id),
            inArray(agentGroupRunNodes.status, ['pending', 'ready']),
          ),
        );
      await this.settleRunIfTerminal(tx, node.runId);
    });
}
