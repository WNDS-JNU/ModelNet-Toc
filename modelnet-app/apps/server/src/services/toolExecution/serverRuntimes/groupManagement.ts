/**
 * Group Management Server Runtime — server-side group orchestration.
 *
 * The supervisor agent runs as a normal durable QStash operation; its
 * `lobe-group-management` tool calls execute here as deferred tools. Each action
 * forks group member(s) via the injected `ctx.agentMember` runner and returns
 * `deferred: true`: the agent runtime parks the supervisor (`waiting_for_async_tool`),
 * and the group-action member completion bridge backfills + resumes/finishes it
 * once the K=N member barrier passes.
 *
 *   - speak      → one in-group member, resume (or finish on skipCallSupervisor)
 *   - broadcast  → N in-group members (tools disabled), resume/finish
 *   - delegate   → one in-group member, finish (supervisor hands off)
 *   - executeAgentTask(s) → isolated thread member(s), resume/finish
 *
 * Mirrors the client GroupOrchestrationRuntime semantics, but the supervisor's
 * own operation IS the orchestration loop — no separate driver.
 */
import type {
  BroadcastParams,
  CreateDebateParams,
  CreateWorkflowParams,
  DelegateParams,
  ExecuteTaskParams,
  ExecuteTasksParams,
  InterruptParams,
  SpeakParams,
  SummarizeParams,
  VoteParams,
} from '@lobechat/builtin-tool-group-management';
import { GroupManagementIdentifier } from '@lobechat/builtin-tool-group-management';
import type { BuiltinServerRuntimeOutput } from '@lobechat/types';

import type { FixedRoundDebatePlan } from '@/server/services/agentGroupCollaboration/debate';

import type { ToolExecutionContext } from '../types';
import type { ServerRuntimeRegistration } from './types';

const buildError = (content: string, code: string): BuiltinServerRuntimeOutput => ({
  content,
  error: { code, message: content },
  success: false,
});

const AGENT_MEMBER_UNAVAILABLE = buildError(
  'Group orchestration is not available in this runtime.',
  'AGENT_MEMBER_UNAVAILABLE',
);

const START_FAILED = buildError('Agent member(s) failed to start.', 'AGENT_MEMBER_START_FAILED');

class GroupManagementExecutionRuntime {
  // ==================== Communication Coordination ====================

  /** Let a single member speak in the shared group session (non-isolated). */
  speak = async (
    params: SpeakParams,
    ctx: ToolExecutionContext,
  ): Promise<BuiltinServerRuntimeOutput> => {
    if (!ctx.agentMember) return AGENT_MEMBER_UNAVAILABLE;
    if (!params.agentId) return buildError('agentId is required.', 'INVALID_ARGUMENTS');

    const { started } = await ctx.agentMember.run({
      members: [{ agentId: params.agentId, instruction: params.instruction }],
      mode: 'in_group',
      onComplete: params.skipCallSupervisor ? 'finish' : 'resume',
    });
    if (!started) return START_FAILED;

    return {
      content: '',
      deferred: true,
      state: { agentId: params.agentId, status: 'pending', type: 'speak' },
      success: true,
    };
  };

  /** Let multiple members respond in parallel (tools disabled — opinions only). */
  broadcast = async (
    params: BroadcastParams,
    ctx: ToolExecutionContext,
  ): Promise<BuiltinServerRuntimeOutput> => {
    if (!ctx.agentMember) return AGENT_MEMBER_UNAVAILABLE;
    const agentIds = params.agentIds ?? [];
    if (agentIds.length === 0) return buildError('agentIds is required.', 'INVALID_ARGUMENTS');

    const { started } = await ctx.agentMember.run({
      disableTools: true,
      members: agentIds.map((agentId) => ({ agentId, instruction: params.instruction })),
      mode: 'in_group',
      onComplete: params.skipCallSupervisor ? 'finish' : 'resume',
    });
    if (!started) return START_FAILED;

    return {
      content: '',
      deferred: true,
      state: { agentIds, status: 'pending', type: 'broadcast' },
      success: true,
    };
  };

  /** Delegate the conversation to a member; the supervisor exits afterwards. */
  delegate = async (
    params: DelegateParams,
    ctx: ToolExecutionContext,
  ): Promise<BuiltinServerRuntimeOutput> => {
    if (!ctx.agentMember) return AGENT_MEMBER_UNAVAILABLE;
    if (!params.agentId) return buildError('agentId is required.', 'INVALID_ARGUMENTS');

    const { started } = await ctx.agentMember.run({
      members: [{ agentId: params.agentId, instruction: params.reason }],
      mode: 'in_group',
      // Delegate hands control to the member — finish without another supervisor turn.
      onComplete: 'finish',
    });
    if (!started) return START_FAILED;

    return {
      content: '',
      deferred: true,
      state: { agentId: params.agentId, status: 'pending', type: 'delegate' },
      success: true,
    };
  };

  // ==================== Task Execution (isolated threads) ====================

  /**
   * Run a member as an isolated-thread task. `runInClient` only takes effect on
   * the desktop client (handled by the client orchestrator); on the cloud/web
   * server there is no local FS/shell, so the task always runs server-side.
   */
  executeAgentTask = async (
    params: ExecuteTaskParams,
    ctx: ToolExecutionContext,
  ): Promise<BuiltinServerRuntimeOutput> => {
    if (!ctx.agentMember) return AGENT_MEMBER_UNAVAILABLE;
    if (!params.agentId || !params.instruction) {
      return buildError('agentId and instruction are required.', 'INVALID_ARGUMENTS');
    }

    const result = await ctx.agentMember.run({
      members: [{ agentId: params.agentId, instruction: params.instruction }],
      mode: 'isolated',
      onComplete: params.skipCallSupervisor ? 'finish' : 'resume',
      timeout: params.timeout,
    });
    if (!result.started) return START_FAILED;

    const taskId = result.tasks?.[0]?.threadId ?? result.tasks?.[0]?.operationId;

    return {
      content: '',
      deferred: true,
      state: { agentId: params.agentId, status: 'pending', taskId, type: 'executeAgentTask' },
      success: true,
    };
  };

  /** Run multiple members as parallel isolated-thread tasks. */
  executeAgentTasks = async (
    params: ExecuteTasksParams,
    ctx: ToolExecutionContext,
  ): Promise<BuiltinServerRuntimeOutput> => {
    if (!ctx.agentMember) return AGENT_MEMBER_UNAVAILABLE;
    const tasks = params.tasks ?? [];
    if (tasks.length === 0) return buildError('tasks is required.', 'INVALID_ARGUMENTS');

    const result = await ctx.agentMember.run({
      members: tasks.map((task) => ({ agentId: task.agentId, instruction: task.instruction })),
      mode: 'isolated',
      onComplete: params.skipCallSupervisor ? 'finish' : 'resume',
      // Per-task timeouts collapse to the longest; the barrier waits for all.
      timeout: tasks.reduce((max, task) => Math.max(max, task.timeout ?? 0), 0) || undefined,
    });
    if (!result.started) return START_FAILED;

    return {
      content: '',
      deferred: true,
      state: {
        status: 'pending',
        taskIds: result.tasks?.map((task) => task.threadId ?? task.operationId),
        tasks: tasks.map((t) => t.agentId),
        type: 'executeAgentTasks',
      },
      success: true,
    };
  };

  // ==================== Not yet implemented on the server ====================
  // Mirror the client stubs: return inline (non-deferred) results so the
  // supervisor LLM keeps orchestrating instead of parking.

  interrupt = async (
    params: InterruptParams,
    ctx: ToolExecutionContext,
  ): Promise<BuiltinServerRuntimeOutput> => {
    if (!params.taskId) return buildError('taskId is required.', 'INVALID_ARGUMENTS');
    if (!ctx.serverDB || !ctx.userId) {
      return buildError(
        'Agent runtime context is unavailable for interruption.',
        'AGENT_RUNTIME_UNAVAILABLE',
      );
    }

    try {
      // Dynamic import avoids a static AiAgentService → ToolExecutionService →
      // groupManagement cycle while still reusing the single interruption path
      // that reaches runtime state, Device Gateway, and heterogeneous adapters.
      const { AiAgentService } = await import('@/server/services/aiAgent');
      const result = await new AiAgentService(ctx.serverDB, ctx.userId, {
        workspaceId: ctx.workspaceId,
      }).interruptTask({ threadId: params.taskId });
      if (!result.success) {
        return buildError(`Failed to cancel task ${params.taskId}.`, 'AGENT_INTERRUPT_FAILED');
      }

      return {
        content: `Task ${params.taskId} has been cancelled successfully.`,
        state: {
          cancelled: true,
          operationId: result.operationId,
          taskId: params.taskId,
        },
        success: true,
      };
    } catch (error) {
      return buildError(
        `Failed to interrupt task: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'AGENT_INTERRUPT_FAILED',
      );
    }
  };

  summarize = async (_params: SummarizeParams): Promise<BuiltinServerRuntimeOutput> => ({
    content: 'Summarize is not yet implemented in server orchestration.',
    success: true,
  });

  createDebate = async (
    params: CreateDebateParams,
    ctx: ToolExecutionContext,
  ): Promise<BuiltinServerRuntimeOutput> => {
    if (
      !ctx.serverDB ||
      !ctx.userId ||
      !ctx.groupId ||
      !ctx.agentId ||
      !ctx.operationId ||
      !ctx.topicId ||
      !ctx.toolCallId ||
      !ctx.toolMessageId
    ) {
      return buildError(
        'Durable Debate creation requires a confirmed server-side group tool context.',
        'AGENT_GROUP_DEBATE_CONTEXT_REQUIRED',
      );
    }

    const name = params.name?.trim();
    const motion = params.motion?.trim();
    const participants = Array.isArray(params.participants) ? params.participants : [];
    const budget = params.budget;
    const invalidBudget =
      (budget?.maxDurationMs !== undefined &&
        (!Number.isSafeInteger(budget.maxDurationMs) || budget.maxDurationMs <= 0)) ||
      (budget?.maxParallel !== undefined &&
        (!Number.isSafeInteger(budget.maxParallel) || budget.maxParallel <= 0)) ||
      (budget?.maxTotalCost !== undefined &&
        (!Number.isFinite(budget.maxTotalCost) || budget.maxTotalCost < 0));
    const failureStrategy = params.policy?.failureStrategy;
    if (
      !name ||
      !motion ||
      participants.length < 2 ||
      participants.length > 8 ||
      !Number.isInteger(params.rounds) ||
      params.rounds < 1 ||
      params.rounds > 5 ||
      invalidBudget ||
      (failureStrategy !== undefined &&
        failureStrategy !== 'fail_fast' &&
        failureStrategy !== 'wait_all')
    ) {
      return buildError(
        'Debate participants, rounds, budget, or policy are invalid.',
        'INVALID_ARGUMENTS',
      );
    }

    let debatePlan: FixedRoundDebatePlan;
    try {
      const { buildFixedRoundDebatePlan } =
        await import('@/server/services/agentGroupCollaboration/debate');
      debatePlan = buildFixedRoundDebatePlan({
        judgeAgentId: params.judgeAgentId ?? '',
        judgeInstruction: params.judgeInstruction,
        judgeTimeoutMs: params.judgeTimeoutMs,
        motion,
        participants,
        roundMaxAttempts: params.roundBudget?.maxAttempts,
        roundTimeoutMs: params.roundBudget?.timeoutMs,
        rounds: params.rounds,
      });
    } catch {
      return buildError(
        'Debate requires unique participants, a distinct Judge, and valid per-round budgets.',
        'INVALID_ARGUMENTS',
      );
    }

    const { AgentGroupCollaborationService } =
      await import('@/server/services/agentGroupCollaboration');
    const { AgentGroupPipelineDispatcher } =
      await import('@/server/services/agentGroupCollaboration/pipelineDispatcher');
    const service = new AgentGroupCollaborationService(ctx.serverDB, ctx.userId, ctx.workspaceId);
    const snapshot = await service.createRun({
      budgetSnapshot: {
        ...params.budget,
        maxParallel: params.budget?.maxParallel ?? participants.length,
      },
      chatGroupId: ctx.groupId,
      debate: debatePlan.debate,
      groupToolMessageId: ctx.toolMessageId,
      idempotencyKey: `create-debate:${ctx.operationId}:${ctx.toolCallId}`,
      nodes: debatePlan.nodes,
      policySnapshot: params.policy,
      protocol: 'debate',
      supervisorAgentId: ctx.agentId,
      supervisorOperationId: ctx.operationId,
      threadId: ctx.threadId,
      topicId: ctx.topicId,
    });

    let dispatch:
      | {
          claimed: number;
          failed: number;
          fenced: number;
          released: number;
          started: number;
        }
      | undefined;
    let dispatchError: string | undefined;
    try {
      dispatch = await new AgentGroupPipelineDispatcher(ctx.serverDB).dispatchRun({
        id: snapshot.run.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId ?? null,
      });
    } catch (error) {
      dispatchError = error instanceof Error ? error.message : String(error);
    }

    const latest = (await service.getRun(snapshot.run.id)) ?? snapshot;
    const state = {
      dispatch,
      dispatchError,
      judgeAgentId: debatePlan.debate.judgeAgentId,
      name,
      nodeCount: latest.nodes.length,
      participantCount: debatePlan.debate.participantAgentIds.length,
      protocol: 'debate',
      rounds: debatePlan.debate.rounds,
      runId: latest.run.id,
      status: latest.run.status,
      type: 'createDebate',
    };
    if (latest.run.status === 'failed' || latest.run.status === 'cancelled') {
      const content = `Debate "${name}" ended with status ${latest.run.status} before a node could remain active.`;
      return {
        content,
        error: { code: 'AGENT_GROUP_DEBATE_START_FAILED', message: content },
        state,
        success: false,
      };
    }
    if (latest.run.status === 'completed') {
      return { content: `Debate "${name}" is already completed.`, state, success: true };
    }

    return { content: '', deferred: true, state, success: true };
  };

  createWorkflow = async (
    params: CreateWorkflowParams,
    ctx: ToolExecutionContext,
  ): Promise<BuiltinServerRuntimeOutput> => {
    if (
      !ctx.serverDB ||
      !ctx.userId ||
      !ctx.groupId ||
      !ctx.agentId ||
      !ctx.operationId ||
      !ctx.topicId ||
      !ctx.toolCallId ||
      !ctx.toolMessageId
    ) {
      return buildError(
        'Durable workflow creation requires a confirmed server-side group tool context.',
        'AGENT_GROUP_WORKFLOW_CONTEXT_REQUIRED',
      );
    }

    const name = params.name?.trim();
    if (!name || !Array.isArray(params.steps) || params.steps.length === 0) {
      return buildError('Workflow name and at least one step are required.', 'INVALID_ARGUMENTS');
    }
    const budget = params.budget;
    const invalidBudget =
      (budget?.maxDurationMs !== undefined &&
        (!Number.isSafeInteger(budget.maxDurationMs) || budget.maxDurationMs <= 0)) ||
      (budget?.maxParallel !== undefined &&
        (!Number.isSafeInteger(budget.maxParallel) || budget.maxParallel <= 0)) ||
      (budget?.maxTotalCost !== undefined &&
        (!Number.isFinite(budget.maxTotalCost) || budget.maxTotalCost < 0));
    const failureStrategy = params.policy?.failureStrategy;
    if (
      params.steps.length > 64 ||
      invalidBudget ||
      (failureStrategy !== undefined &&
        failureStrategy !== 'fail_fast' &&
        failureStrategy !== 'wait_all')
    ) {
      return buildError('Workflow budget or policy is invalid.', 'INVALID_ARGUMENTS');
    }

    const { AgentGroupCollaborationService } =
      await import('@/server/services/agentGroupCollaboration');
    const { AgentGroupPipelineDispatcher } =
      await import('@/server/services/agentGroupCollaboration/pipelineDispatcher');
    const service = new AgentGroupCollaborationService(ctx.serverDB, ctx.userId, ctx.workspaceId);
    const snapshot = await service.createRun({
      budgetSnapshot: params.budget,
      chatGroupId: ctx.groupId,
      groupToolMessageId: ctx.toolMessageId,
      idempotencyKey: `create-workflow:${ctx.operationId}:${ctx.toolCallId}`,
      nodes: params.steps,
      policySnapshot: params.policy,
      protocol: 'pipeline',
      supervisorAgentId: ctx.agentId,
      supervisorOperationId: ctx.operationId,
      threadId: ctx.threadId,
      topicId: ctx.topicId,
    });

    let dispatch:
      | {
          claimed: number;
          failed: number;
          fenced: number;
          released: number;
          started: number;
        }
      | undefined;
    let dispatchError: string | undefined;
    try {
      dispatch = await new AgentGroupPipelineDispatcher(ctx.serverDB).dispatchRun({
        id: snapshot.run.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId ?? null,
      });
    } catch (error) {
      // The Run and approval identity are already durable. Park the supervisor
      // so the recovery worker can retry the exact same fenced dispatch.
      dispatchError = error instanceof Error ? error.message : String(error);
    }

    const latest = (await service.getRun(snapshot.run.id)) ?? snapshot;
    const state = {
      dispatch,
      dispatchError,
      name,
      nodeCount: latest.nodes.length,
      protocol: 'pipeline',
      runId: latest.run.id,
      status: latest.run.status,
      type: 'createWorkflow',
    };
    if (latest.run.status === 'failed' || latest.run.status === 'cancelled') {
      const content = `Workflow "${name}" ended with status ${latest.run.status} before a node could remain active.`;
      return {
        content,
        error: { code: 'AGENT_GROUP_WORKFLOW_START_FAILED', message: content },
        state,
        success: false,
      };
    }
    if (latest.run.status === 'completed') {
      return {
        content: `Workflow "${name}" is already completed.`,
        state,
        success: true,
      };
    }

    return {
      content: '',
      deferred: true,
      state,
      success: true,
    };
  };

  vote = async (params: VoteParams): Promise<BuiltinServerRuntimeOutput> => ({
    content: `Voting is not yet implemented (question: "${params.question}").`,
    success: true,
  });
}

const runtime = new GroupManagementExecutionRuntime();

export const groupManagementRuntime: ServerRuntimeRegistration = {
  factory: () => runtime,
  identifier: GroupManagementIdentifier,
};
