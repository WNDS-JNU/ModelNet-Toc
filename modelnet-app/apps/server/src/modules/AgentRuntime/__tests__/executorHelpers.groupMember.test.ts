import { type AgentState } from '@lobechat/agent-runtime';
import { type ChatToolPayload } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type RuntimeExecutorContext } from '../context';
import { buildServerAgentMemberRunner, resolveGroupMemberId } from '../executorHelpers';

const collaboration = vi.hoisted(() => ({
  completeAttempt: vi.fn(),
  createAttempt: vi.fn(),
  createRun: vi.fn(),
  enabled: false,
  failNodeStart: vi.fn(),
}));

vi.mock('@/envs/app', () => ({
  appEnv: {
    get enableAgentGroupDurableRuns() {
      return collaboration.enabled;
    },
  },
}));

vi.mock('@/server/services/agentGroupCollaboration', () => ({
  AgentGroupCollaborationService: class {
    completeAttempt = collaboration.completeAttempt;
    createAttempt = collaboration.createAttempt;
    createRun = collaboration.createRun;
    failNodeStart = collaboration.failNodeStart;
  },
}));

describe('resolveGroupMemberId', () => {
  const agentMap = {
    agt_member: { name: 'Meituan Assistant' },
    agt_supervisor: { name: 'Supervisor' },
  };

  it('keeps a persisted agent id unchanged', () => {
    expect(resolveGroupMemberId('agt_member', agentMap)).toBe('agt_member');
  });

  it('resolves an exact member display name to its persisted agent id', () => {
    expect(resolveGroupMemberId('Meituan Assistant', agentMap)).toBe('agt_member');
  });

  it('does not guess when a display name is ambiguous', () => {
    expect(
      resolveGroupMemberId('Assistant', {
        agt_first: { name: 'Assistant' },
        agt_second: { name: 'Assistant' },
      }),
    ).toBe('Assistant');
  });
});

describe('buildServerAgentMemberRunner', () => {
  const toolPayload = { id: 'group-tool-call' } as ChatToolPayload;

  beforeEach(() => {
    collaboration.enabled = false;
    collaboration.completeAttempt.mockReset().mockResolvedValue(undefined);
    collaboration.createAttempt.mockReset().mockResolvedValue(undefined);
    collaboration.createRun.mockReset();
    collaboration.failNodeStart.mockReset().mockResolvedValue(undefined);
  });

  const build = (options?: {
    execGroupMember?: ReturnType<typeof vi.fn>;
    metadata?: Record<string, unknown>;
  }) => {
    let messageSequence = 0;
    const messageModel = {
      create: vi.fn().mockImplementation(async () => ({ id: `message-${++messageSequence}` })),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      updateToolMessage: vi.fn().mockResolvedValue(undefined),
    };
    const execGroupMember =
      options && 'execGroupMember' in options
        ? options.execGroupMember
        : vi.fn().mockResolvedValue({ operationId: 'member-operation', started: true });
    const ctx = {
      execGroupMember,
      messageModel,
      operationId: 'supervisor-operation',
      serverDB: {},
      topicId: 'topic-1',
      userId: 'user-1',
      workspaceId: 'workspace-1',
    } as unknown as RuntimeExecutorContext;
    const state = {
      metadata: {
        agentGroup: {
          agentMap: {
            agt_member: { name: 'Meituan Assistant' },
            agt_second: { name: 'Second Assistant' },
          },
        },
        agentId: 'agt_supervisor',
        groupId: 'group-1',
        threadId: 'thread-1',
        topicId: 'topic-1',
        ...options?.metadata,
      },
      operationId: 'supervisor-operation',
    } as unknown as AgentState;

    const runner = buildServerAgentMemberRunner(ctx, state, toolPayload, 'supervisor-message');

    return { execGroupMember, messageModel, runner };
  };

  it('is unavailable without an execution callback or complete group context', () => {
    expect(build({ execGroupMember: undefined }).runner).toBeUndefined();
    expect(build({ metadata: { groupId: undefined } }).runner).toBeUndefined();
    expect(build({ metadata: { agentId: undefined } }).runner).toBeUndefined();
  });

  it('rejects an empty member set without creating placeholders', async () => {
    const { execGroupMember, messageModel, runner } = build();

    const result = await runner!.run({ members: [], mode: 'in_group', onComplete: 'resume' });

    expect(result).toEqual({ started: false, startedCount: 0 });
    expect(messageModel.create).not.toHaveBeenCalled();
    expect(execGroupMember).not.toHaveBeenCalled();
  });

  it('uses the group tool as the single member anchor and resolves an exact display name', async () => {
    const { execGroupMember, messageModel, runner } = build();

    const result = await runner!.run({
      members: [{ agentId: 'Meituan Assistant', instruction: 'review this' }],
      mode: 'in_group',
      onComplete: 'resume',
    });

    expect(result).toMatchObject({ started: true, startedCount: 1 });
    expect(messageModel.create).toHaveBeenCalledTimes(1);
    expect(messageModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 'group-1',
        parentId: 'supervisor-message',
        pluginState: { expectedMembers: 1, onComplete: 'resume', status: 'pending' },
        tool_call_id: 'group-tool-call',
      }),
    );
    expect(execGroupMember).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agt_member',
        anchorMessageId: 'message-1',
        expectedMembers: 1,
        groupToolMessageId: 'message-1',
        instruction: 'review this',
        mode: 'in_group',
        onComplete: 'resume',
        parentOperationId: 'supervisor-operation',
        supervisorMessageId: 'supervisor-message',
      }),
    );
  });

  it('creates an AgentCouncil plus one barrier anchor per in-group member', async () => {
    const { execGroupMember, messageModel, runner } = build();

    const result = await runner!.run({
      disableTools: true,
      members: [{ agentId: 'agt_member' }, { agentId: 'agt_second' }],
      mode: 'in_group',
      onComplete: 'finish',
    });

    expect(result).toMatchObject({ started: true, startedCount: 2 });
    expect(messageModel.create).toHaveBeenCalledTimes(3);
    expect(messageModel.create.mock.calls[0][0]).toMatchObject({
      metadata: { agentCouncil: true },
      pluginState: { expectedMembers: 2, onComplete: 'finish', status: 'pending' },
    });
    expect(messageModel.create.mock.calls[1][0]).toMatchObject({
      parentId: 'message-1',
      tool_call_id: 'group-tool-call::m0',
    });
    expect(messageModel.create.mock.calls[2][0]).toMatchObject({
      parentId: 'message-1',
      tool_call_id: 'group-tool-call::m1',
    });
    expect(execGroupMember).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: 'agt_member',
        anchorMessageId: 'message-2',
        disableTools: true,
        expectedMembers: 2,
        groupToolMessageId: 'message-1',
        onComplete: 'finish',
      }),
    );
    expect(execGroupMember).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ agentId: 'agt_second', anchorMessageId: 'message-3' }),
    );
  });

  it('backfills a failed member anchor while keeping the barrier alive for started members', async () => {
    const execGroupMember = vi
      .fn()
      .mockResolvedValueOnce({ operationId: 'member-operation', started: true })
      .mockResolvedValueOnce({ started: false });
    const { messageModel, runner } = build({ execGroupMember });

    const result = await runner!.run({
      members: [{ agentId: 'agt_member' }, { agentId: 'agt_second' }],
      mode: 'isolated',
      onComplete: 'resume',
      timeout: 5000,
    });

    expect(result).toMatchObject({ started: true, startedCount: 1 });
    expect(messageModel.create.mock.calls[0][0]).not.toHaveProperty('metadata');
    expect(messageModel.updateToolMessage).toHaveBeenCalledWith('message-3', {
      content: 'Agent member "agt_second" failed to start.',
      pluginState: { status: 'error' },
    });
    expect(messageModel.deleteMessage).not.toHaveBeenCalled();
    expect(execGroupMember).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mode: 'isolated', timeout: 5000 }),
    );
  });

  it('tears down all placeholders when no member starts', async () => {
    const execGroupMember = vi.fn().mockRejectedValue(new Error('scheduler unavailable'));
    const { messageModel, runner } = build({ execGroupMember });

    const result = await runner!.run({
      members: [{ agentId: 'agt_member' }, { agentId: 'agt_second' }],
      mode: 'isolated',
      onComplete: 'resume',
    });

    expect(result).toEqual({ started: false, startedCount: 0 });
    expect(messageModel.updateToolMessage).toHaveBeenCalledTimes(2);
    expect(new Set(messageModel.deleteMessage.mock.calls.map(([id]) => id))).toEqual(
      new Set(['message-1', 'message-2', 'message-3']),
    );
  });

  it('persists one durable attempt per started member when the flag is enabled', async () => {
    collaboration.enabled = true;
    collaboration.createRun.mockResolvedValue({
      attempts: [],
      created: true,
      nodes: [{ id: 'node-1' }, { id: 'node-2' }],
      operations: [],
      run: { id: 'run-1' },
    });
    const execGroupMember = vi
      .fn()
      .mockResolvedValueOnce({ operationId: 'operation-1', started: true })
      .mockResolvedValueOnce({ operationId: 'operation-2', started: true });
    const { runner } = build({ execGroupMember });

    const result = await runner!.run({
      disableTools: true,
      members: [
        { agentId: 'agt_member', instruction: 'First opinion' },
        { agentId: 'agt_second', instruction: 'Second opinion' },
      ],
      mode: 'in_group',
      onComplete: 'resume',
    });

    expect(result).toMatchObject({ started: true, startedCount: 2 });
    expect(collaboration.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        chatGroupId: 'group-1',
        idempotencyKey: 'group-action:supervisor-operation:group-tool-call',
        policySnapshot: { failureStrategy: 'wait_all' },
        protocol: 'broadcast',
        supervisorAgentId: 'agt_supervisor',
        supervisorOperationId: 'supervisor-operation',
      }),
    );
    expect(collaboration.createRun.mock.calls[0][0].nodes).toEqual([
      expect.objectContaining({ maxAttempts: 2 }),
      expect.objectContaining({ maxAttempts: 2 }),
    ]);
    expect(execGroupMember).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        collaboration: {
          attemptNo: 1,
          runId: 'run-1',
          runNodeId: 'node-1',
          runtimeKind: 'normal',
        },
      }),
    );
    expect(collaboration.createAttempt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        attemptNo: 1,
        operationId: 'operation-1',
        runId: 'run-1',
        runNodeId: 'node-1',
        runtimeKind: 'normal',
      }),
    );
    expect(collaboration.createAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attemptNo: 1,
        operationId: 'operation-2',
        runId: 'run-1',
        runNodeId: 'node-2',
        runtimeKind: 'normal',
      }),
    );
  });

  it('persists a heterogeneous Attempt and resolved sandbox plan before dispatch returns', async () => {
    collaboration.enabled = true;
    collaboration.createRun.mockResolvedValue({
      attempts: [],
      created: true,
      nodes: [{ id: 'node-1' }],
      operations: [],
      run: { id: 'run-1' },
    });
    const execGroupMember = vi.fn().mockImplementation(async (params) => {
      await params.onOperationPrepared?.({
        executionPlan: { kind: 'sandbox', target: 'sandbox' },
        operationId: 'heterogeneous-operation',
        runtimeKind: 'heterogeneous',
      });
      return {
        executionPlan: { kind: 'sandbox', target: 'sandbox' },
        operationId: 'heterogeneous-operation',
        runtimeKind: 'heterogeneous',
        started: true,
      };
    });
    const { runner } = build({ execGroupMember });

    const result = await runner!.run({
      members: [{ agentId: 'agt_member', instruction: 'Inspect the repository' }],
      mode: 'isolated',
      onComplete: 'resume',
    });

    expect(result).toMatchObject({ started: true, startedCount: 1 });
    expect(collaboration.createAttempt).toHaveBeenCalledTimes(1);
    expect(collaboration.createAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTargetSnapshot: expect.objectContaining({
          executionPlan: { kind: 'sandbox', target: 'sandbox' },
          mode: 'isolated',
        }),
        operationId: 'heterogeneous-operation',
        runtimeKind: 'heterogeneous',
      }),
    );
  });

  it('fails a prepared Attempt instead of leaving it running when dispatch fails', async () => {
    collaboration.enabled = true;
    collaboration.createRun.mockResolvedValue({
      attempts: [],
      created: true,
      nodes: [{ id: 'node-1' }],
      operations: [],
      run: { id: 'run-1' },
    });
    const execGroupMember = vi.fn().mockImplementation(async (params) => {
      await params.onOperationPrepared?.({
        executionPlan: { deviceId: 'device-1', kind: 'device', target: 'device' },
        operationId: 'heterogeneous-operation',
        runtimeKind: 'heterogeneous',
      });
      return {
        error: 'device dispatch failed',
        operationId: 'heterogeneous-operation',
        runtimeKind: 'heterogeneous',
        started: false,
      };
    });
    const { runner } = build({ execGroupMember });

    const result = await runner!.run({
      members: [{ agentId: 'agt_member' }],
      mode: 'isolated',
      onComplete: 'resume',
    });

    expect(result).toEqual({ started: false, startedCount: 0 });
    expect(collaboration.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        completionReason: 'start_failed',
        operationId: 'heterogeneous-operation',
        runtimeKind: 'heterogeneous',
        status: 'failed',
      }),
    );
    expect(collaboration.failNodeStart).not.toHaveBeenCalled();
  });

  it('does not relaunch members for an idempotent durable-run replay', async () => {
    collaboration.enabled = true;
    collaboration.createRun.mockResolvedValue({
      attempts: [{ id: 'attempt-1', operationId: 'operation-1' }],
      created: false,
      nodes: [{ id: 'node-1' }],
      operations: [],
      run: { id: 'run-1' },
    });
    const { execGroupMember, messageModel, runner } = build();

    const result = await runner!.run({
      members: [{ agentId: 'agt_member' }],
      mode: 'in_group',
      onComplete: 'resume',
    });

    expect(result).toMatchObject({ started: true, startedCount: 1 });
    expect(execGroupMember).not.toHaveBeenCalled();
    expect(messageModel.deleteMessage).toHaveBeenCalledWith('message-1');
  });

  it('settles a durable node when its member cannot start', async () => {
    collaboration.enabled = true;
    collaboration.createRun.mockResolvedValue({
      attempts: [],
      created: true,
      nodes: [{ id: 'node-1' }],
      operations: [],
      run: { id: 'run-1' },
    });
    const execGroupMember = vi.fn().mockResolvedValue({
      error: 'queue unavailable',
      started: false,
    });
    const { runner } = build({ execGroupMember });

    const result = await runner!.run({
      members: [{ agentId: 'agt_member' }],
      mode: 'isolated',
      onComplete: 'resume',
    });

    expect(result).toEqual({ started: false, startedCount: 0 });
    expect(collaboration.failNodeStart).toHaveBeenCalledWith({
      error: { code: 'AGENT_MEMBER_START_FAILED', message: 'queue unavailable' },
      runNodeId: 'node-1',
    });
  });
});
