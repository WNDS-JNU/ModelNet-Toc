// @vitest-environment node
import {
  type CreateDebateParams,
  type CreateWorkflowParams,
  GroupManagementApiName,
  GroupManagementManifest,
} from '@lobechat/builtin-tool-group-management';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolExecutionContext } from '../types';
import { groupManagementRuntime } from './groupManagement';

const mocks = vi.hoisted(() => ({
  createRun: vi.fn(),
  dispatchRun: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock('@/server/services/agentGroupCollaboration', () => ({
  AgentGroupCollaborationService: class {
    createRun = mocks.createRun;
    getRun = mocks.getRun;
  },
}));

vi.mock('@/server/services/agentGroupCollaboration/pipelineDispatcher', () => ({
  AgentGroupPipelineDispatcher: class {
    dispatchRun = mocks.dispatchRun;
  },
}));

const params: CreateWorkflowParams = {
  budget: { maxParallel: 2 },
  name: 'Research and review',
  policy: { failureStrategy: 'wait_all' },
  steps: [
    {
      agentId: 'agent-researcher',
      dependencies: [],
      instruction: 'Collect evidence.',
      key: 'research',
      maxAttempts: 2,
    },
    {
      agentId: 'agent-reviewer',
      dependencies: ['research'],
      instruction: 'Review the evidence.',
      key: 'review',
    },
  ],
};

const debateParams: CreateDebateParams = {
  motion: 'Should the release use the proposed architecture?',
  name: 'Architecture Debate',
  participants: [
    { agentId: 'agent-researcher', perspective: 'Argue for the proposal.' },
    { agentId: 'agent-reviewer', perspective: 'Challenge the proposal.' },
  ],
  judgeAgentId: 'agent-judge',
  policy: { failureStrategy: 'wait_all' },
  roundBudget: { maxAttempts: 2, timeoutMs: 60_000 },
  rounds: 2,
};

const snapshot = {
  attempts: [],
  created: true,
  nodes: [{ id: 'node-research' }, { id: 'node-review' }],
  operations: [],
  run: {
    id: 'run-1',
    protocol: 'pipeline',
    status: 'pending',
  },
};

const context = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  agentId: 'agent-supervisor',
  groupId: 'group-1',
  operationId: 'operation-supervisor',
  serverDB: {} as never,
  threadId: 'thread-1',
  toolCallId: 'call-create-workflow',
  toolManifestMap: {},
  toolMessageId: 'message-create-workflow',
  topicId: 'topic-1',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  ...overrides,
});

describe('groupManagement createWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRun.mockResolvedValue(snapshot);
    mocks.getRun.mockResolvedValue(snapshot);
    mocks.dispatchRun.mockResolvedValue({
      claimed: 1,
      failed: 0,
      fenced: 0,
      released: 0,
      started: 1,
    });
  });

  it('keeps the API behind required human approval', () => {
    const api = GroupManagementManifest.api.find(
      (item) => item.name === GroupManagementApiName.createWorkflow,
    );

    expect(api?.humanIntervention).toBe('required');
  });

  it('rejects invalid workflow budgets before creating a Run', async () => {
    const runtime = groupManagementRuntime.factory(context());

    const result = await runtime.createWorkflow(
      { ...params, budget: { maxParallel: 0 } },
      context(),
    );

    expect(result).toMatchObject({ error: { code: 'INVALID_ARGUMENTS' }, success: false });
    expect(mocks.createRun).not.toHaveBeenCalled();
  });
  it('fails closed when the approved tool-message identity is absent', async () => {
    const runtime = groupManagementRuntime.factory(context({ toolMessageId: undefined }));

    const result = await runtime.createWorkflow(params, context({ toolMessageId: undefined }));

    expect(result).toMatchObject({
      error: { code: 'AGENT_GROUP_WORKFLOW_CONTEXT_REQUIRED' },
      success: false,
    });
    expect(mocks.createRun).not.toHaveBeenCalled();
    expect(mocks.dispatchRun).not.toHaveBeenCalled();
  });

  it('creates the immutable Run from trusted context and immediately dispatches it', async () => {
    const runtime = groupManagementRuntime.factory(context());

    const result = await runtime.createWorkflow(params, context());

    expect(mocks.createRun).toHaveBeenCalledWith({
      budgetSnapshot: params.budget,
      chatGroupId: 'group-1',
      groupToolMessageId: 'message-create-workflow',
      idempotencyKey: 'create-workflow:operation-supervisor:call-create-workflow',
      nodes: params.steps,
      policySnapshot: params.policy,
      protocol: 'pipeline',
      supervisorAgentId: 'agent-supervisor',
      supervisorOperationId: 'operation-supervisor',
      threadId: 'thread-1',
      topicId: 'topic-1',
    });
    expect(mocks.dispatchRun).toHaveBeenCalledWith({
      id: 'run-1',
      userId: 'user-1',
      workspaceId: 'workspace-1',
    });
    expect(result).toMatchObject({
      deferred: true,
      state: {
        name: params.name,
        nodeCount: 2,
        runId: 'run-1',
        status: 'pending',
        type: 'createWorkflow',
      },
      success: true,
    });
  });

  it('uses one stable idempotency identity across execution retries', async () => {
    const runtime = groupManagementRuntime.factory(context());

    await runtime.createWorkflow(params, context());
    await runtime.createWorkflow(params, context());

    expect(mocks.createRun).toHaveBeenCalledTimes(2);
    expect(mocks.createRun.mock.calls[0][0].idempotencyKey).toBe(
      mocks.createRun.mock.calls[1][0].idempotencyKey,
    );
    expect(mocks.createRun.mock.calls[1][0].groupToolMessageId).toBe('message-create-workflow');
  });

  it('parks the supervisor when immediate dispatch fails so recovery can retry', async () => {
    mocks.dispatchRun.mockRejectedValueOnce(new Error('temporary queue outage'));
    const runtime = groupManagementRuntime.factory(context());

    const result = await runtime.createWorkflow(params, context());

    expect(result).toMatchObject({
      deferred: true,
      state: { dispatchError: 'temporary queue outage', runId: 'run-1' },
      success: true,
    });
  });

  it('returns inline failure when the Run terminalizes before any active node remains', async () => {
    mocks.getRun.mockResolvedValueOnce({
      ...snapshot,
      run: { ...snapshot.run, status: 'failed' },
    });
    const runtime = groupManagementRuntime.factory(context());

    const result = await runtime.createWorkflow(params, context());

    expect(result).toMatchObject({
      error: { code: 'AGENT_GROUP_WORKFLOW_START_FAILED' },
      state: { runId: 'run-1', status: 'failed' },
      success: false,
    });
    expect(result.deferred).toBeUndefined();
  });
});

describe('groupManagement createDebate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const debateSnapshot = {
      ...snapshot,
      nodes: Array.from({ length: 5 }, (_, index) => ({ id: `debate-node-${index + 1}` })),
      run: { ...snapshot.run, id: 'debate-run-1', protocol: 'debate' },
    };
    mocks.createRun.mockResolvedValue(debateSnapshot);
    mocks.getRun.mockResolvedValue(debateSnapshot);
    mocks.dispatchRun.mockResolvedValue({
      claimed: 2,
      failed: 0,
      fenced: 0,
      released: 0,
      started: 2,
    });
  });

  const debateContext = (overrides: Partial<ToolExecutionContext> = {}) =>
    context({
      toolCallId: 'call-create-debate',
      toolMessageId: 'message-create-debate',
      ...overrides,
    });

  it('keeps the API behind required human approval', () => {
    const api = GroupManagementManifest.api.find(
      (item) => item.name === GroupManagementApiName.createDebate,
    );

    expect(api?.humanIntervention).toBe('required');
  });

  it('rejects a Judge who is also a participant before creating a Run', async () => {
    const runtime = groupManagementRuntime.factory(debateContext());

    const result = await runtime.createDebate(
      { ...debateParams, judgeAgentId: 'agent-researcher' },
      debateContext(),
    );

    expect(result).toMatchObject({ error: { code: 'INVALID_ARGUMENTS' }, success: false });
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it('creates an immutable fixed-round Run and immediately dispatches round one', async () => {
    const runtime = groupManagementRuntime.factory(debateContext());

    const result = await runtime.createDebate(debateParams, debateContext());

    expect(mocks.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetSnapshot: { maxParallel: 2 },
        chatGroupId: 'group-1',
        debate: {
          judgeAgentId: 'agent-judge',
          participantAgentIds: ['agent-researcher', 'agent-reviewer'],
          rounds: 2,
          termination: 'fixed_rounds',
        },
        groupToolMessageId: 'message-create-debate',
        idempotencyKey: 'create-debate:operation-supervisor:call-create-debate',
        nodes: expect.arrayContaining([
          expect.objectContaining({
            barrierKey: 'debate-round-1',
            key: 'debate-r1-p1',
            toolPolicy: { disableTools: true },
          }),
          expect.objectContaining({
            dependencies: ['debate-r2-p1', 'debate-r2-p2'],
            key: 'debate-judge',
            role: 'judge',
          }),
        ]),
        protocol: 'debate',
        supervisorAgentId: 'agent-supervisor',
        supervisorOperationId: 'operation-supervisor',
      }),
    );
    expect(mocks.createRun.mock.calls[0][0].nodes).toHaveLength(5);
    expect(mocks.dispatchRun).toHaveBeenCalledWith({
      id: 'debate-run-1',
      userId: 'user-1',
      workspaceId: 'workspace-1',
    });
    expect(result).toMatchObject({
      deferred: true,
      state: {
        judgeAgentId: 'agent-judge',
        participantCount: 2,
        protocol: 'debate',
        rounds: 2,
        runId: 'debate-run-1',
        type: 'createDebate',
      },
      success: true,
    });
  });

  it('parks the supervisor when immediate Debate dispatch fails', async () => {
    mocks.dispatchRun.mockRejectedValueOnce(new Error('temporary queue outage'));
    const runtime = groupManagementRuntime.factory(debateContext());

    const result = await runtime.createDebate(debateParams, debateContext());

    expect(result).toMatchObject({
      deferred: true,
      state: { dispatchError: 'temporary queue outage', runId: 'debate-run-1' },
      success: true,
    });
  });
});
