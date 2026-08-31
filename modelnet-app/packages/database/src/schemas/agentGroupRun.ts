import {
  agentGroupRunAttemptStatuses,
  agentGroupRunNodeStatuses,
  agentGroupRunProtocols,
  agentGroupRunStatuses,
} from '@lobechat/const/agentGroupRun';
import type {
  AgentGroupRunBudgetSnapshot,
  AgentGroupRunError,
  AgentGroupRunExecutionPolicySnapshot,
  AgentGroupRunExternalExecutionRef,
  AgentGroupRunPlanSnapshot,
  AgentGroupRunPolicySnapshot,
  AgentGroupRunRuntimeKind,
  AgentGroupRunToolPolicySnapshot,
} from '@lobechat/types';
import { isNotNull, isNull, sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { idGenerator } from '../utils/idGenerator';
import { createdAt, timestamptz, updatedAt } from './_helpers';
import { agents } from './agent';
import { chatGroups } from './chatGroup';
import { threads, topics } from './topic';
import { users } from './user';
import { workspaces } from './workspace';

/**
 * One user-visible collaboration run. The immutable plan/policy snapshots are
 * the orchestration contract; execution detail remains in agent_operations and
 * the node attempts below.
 */
export const agentGroupRuns = pgTable(
  'agent_group_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => idGenerator('agentGroupRuns'))
      .notNull(),

    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    chatGroupId: text('chat_group_id')
      .references(() => chatGroups.id, { onDelete: 'cascade' })
      .notNull(),
    topicId: text('topic_id').references(() => topics.id, { onDelete: 'set null' }),
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    supervisorAgentId: text('supervisor_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    /** Stable execution identity; deliberately retained even if an operation row is archived. */
    supervisorOperationId: text('supervisor_operation_id').notNull(),

    protocol: text('protocol', { enum: agentGroupRunProtocols }).notNull(),
    planVersion: integer('plan_version').notNull(),
    planSnapshot: jsonb('plan_snapshot').$type<AgentGroupRunPlanSnapshot>().notNull(),
    planHash: varchar('plan_hash', { length: 64 }).notNull(),
    policySnapshot: jsonb('policy_snapshot').$type<AgentGroupRunPolicySnapshot>(),
    budgetSnapshot: jsonb('budget_snapshot').$type<AgentGroupRunBudgetSnapshot>(),

    status: text('status', { enum: agentGroupRunStatuses }).default('pending').notNull(),
    completionReason: text('completion_reason'),
    error: jsonb('error').$type<AgentGroupRunError>(),
    idempotencyKey: text('idempotency_key').notNull(),

    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('agent_group_runs_personal_idempotency_unique')
      .on(t.userId, t.idempotencyKey)
      .where(isNull(t.workspaceId)),
    uniqueIndex('agent_group_runs_workspace_idempotency_unique')
      .on(t.workspaceId, t.idempotencyKey)
      .where(isNotNull(t.workspaceId)),
    index('agent_group_runs_chat_group_created_idx').on(t.chatGroupId, t.createdAt),
    index('agent_group_runs_topic_created_idx').on(t.topicId, t.createdAt),
    index('agent_group_runs_supervisor_operation_idx').on(t.supervisorOperationId),
    index('agent_group_runs_status_updated_idx').on(t.status, t.updatedAt),
    index('agent_group_runs_user_id_idx').on(t.userId),
    index('agent_group_runs_workspace_id_idx').on(t.workspaceId),
    check('agent_group_runs_plan_version_positive', sql`${t.planVersion} > 0`),
    check('agent_group_runs_plan_hash_sha256', sql`${t.planHash} ~ '^[a-f0-9]{64}$'`),
  ],
);

/** Stable node in the immutable collaboration plan. */
export const agentGroupRunNodes = pgTable(
  'agent_group_run_nodes',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),
    runId: text('run_id')
      .references(() => agentGroupRuns.id, { onDelete: 'cascade' })
      .notNull(),
    nodeKey: text('node_key').notNull(),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    role: text('role'),
    instruction: text('instruction').notNull(),
    dependencies: jsonb('dependencies').$type<string[]>().default([]).notNull(),
    barrierKey: text('barrier_key'),
    sortOrder: integer('sort_order').default(0).notNull(),
    executionPolicySnapshot: jsonb(
      'execution_policy_snapshot',
    ).$type<AgentGroupRunExecutionPolicySnapshot>(),
    toolPolicySnapshot: jsonb('tool_policy_snapshot').$type<AgentGroupRunToolPolicySnapshot>(),
    status: text('status', { enum: agentGroupRunNodeStatuses }).default('pending').notNull(),
    completionReason: text('completion_reason'),
    error: jsonb('error').$type<AgentGroupRunError>(),
    maxAttempts: integer('max_attempts').default(1).notNull(),
    timeoutMs: integer('timeout_ms'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('agent_group_run_nodes_run_key_unique').on(t.runId, t.nodeKey),
    index('agent_group_run_nodes_run_status_order_idx').on(t.runId, t.status, t.sortOrder),
    index('agent_group_run_nodes_agent_id_idx').on(t.agentId),
    check('agent_group_run_nodes_sort_order_nonnegative', sql`${t.sortOrder} >= 0`),
    check('agent_group_run_nodes_max_attempts_positive', sql`${t.maxAttempts} > 0`),
    check(
      'agent_group_run_nodes_timeout_positive',
      sql`${t.timeoutMs} IS NULL OR ${t.timeoutMs} > 0`,
    ),
  ],
);

/** One concrete AgentOperation-backed execution attempt for a plan node. */
export const agentGroupRunAttempts = pgTable(
  'agent_group_run_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),
    runNodeId: uuid('run_node_id')
      .references(() => agentGroupRunNodes.id, { onDelete: 'cascade' })
      .notNull(),
    attemptNo: integer('attempt_no').notNull(),
    /** Kept as an audit identity rather than an FK so operation archival cannot erase lineage. */
    operationId: text('operation_id').notNull(),
    runtimeKind: text('runtime_kind').$type<AgentGroupRunRuntimeKind>().notNull(),
    executionTargetSnapshot: jsonb('execution_target_snapshot').$type<Record<string, unknown>>(),
    externalExecutionRef:
      jsonb('external_execution_ref').$type<AgentGroupRunExternalExecutionRef>(),
    status: text('status', { enum: agentGroupRunAttemptStatuses }).default('pending').notNull(),
    error: jsonb('error').$type<AgentGroupRunError>(),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('agent_group_run_attempts_node_attempt_unique').on(t.runNodeId, t.attemptNo),
    uniqueIndex('agent_group_run_attempts_operation_unique').on(t.operationId),
    index('agent_group_run_attempts_node_status_idx').on(t.runNodeId, t.status),
    index('agent_group_run_attempts_status_updated_idx').on(t.status, t.updatedAt),
    check('agent_group_run_attempts_attempt_no_positive', sql`${t.attemptNo} > 0`),
  ],
);

/**
 * Append-only lifecycle feed for one collaboration run.
 *
 * The normalized Run / Node / Attempt rows remain the current-state source of
 * truth. Events are written in the same transaction as those state changes so
 * query/replay and recovery diagnostics never have to infer history from logs.
 */
export const agentGroupRunEvents = pgTable(
  'agent_group_run_events',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),
    /** Monotonic database order used for deterministic replay and UI timelines. */
    sequence: bigserial('sequence', { mode: 'number' }).notNull(),
    runId: text('run_id')
      .references(() => agentGroupRuns.id, { onDelete: 'cascade' })
      .notNull(),
    runNodeId: uuid('run_node_id').references(() => agentGroupRunNodes.id, {
      onDelete: 'set null',
    }),
    attemptId: uuid('attempt_id').references(() => agentGroupRunAttempts.id, {
      onDelete: 'set null',
    }),
    /** Audit identity retained even when an operation row is archived. */
    operationId: text('operation_id'),
    type: text('type').notNull(),
    status: text('status'),
    data: jsonb('data').$type<Record<string, unknown>>(),
    /** Stable execute-once identity for redelivered callbacks and sweepers. */
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('agent_group_run_events_run_idempotency_unique').on(t.runId, t.idempotencyKey),
    index('agent_group_run_events_run_sequence_idx').on(t.runId, t.sequence),
    index('agent_group_run_events_operation_idx').on(t.operationId),
  ],
);

export type NewAgentGroupRun = typeof agentGroupRuns.$inferInsert;
export type AgentGroupRunItem = typeof agentGroupRuns.$inferSelect;
export type NewAgentGroupRunNode = typeof agentGroupRunNodes.$inferInsert;
export type AgentGroupRunNodeItem = typeof agentGroupRunNodes.$inferSelect;
export type NewAgentGroupRunAttempt = typeof agentGroupRunAttempts.$inferInsert;
export type AgentGroupRunAttemptItem = typeof agentGroupRunAttempts.$inferSelect;
export type NewAgentGroupRunEvent = typeof agentGroupRunEvents.$inferInsert;
export type AgentGroupRunEventItem = typeof agentGroupRunEvents.$inferSelect;
