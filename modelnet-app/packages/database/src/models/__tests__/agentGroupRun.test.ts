// @vitest-environment node
import type { AgentGroupRunPlanSnapshot } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { getTestDB } from '../../core/getTestDB';
import { agentOperations, agents, chatGroups, users, workspaces } from '../../schemas';
import {
  AGENT_GROUP_RUN_IDEMPOTENCY_CONFLICT,
  AGENT_GROUP_RUN_NOT_FOUND,
  AGENT_GROUP_RUN_OPERATION_MISMATCH,
  AgentGroupRunModel,
} from '../agentGroupRun';

const userId = 'agent-group-run-user';
const otherUserId = 'agent-group-run-other-user';
const workspaceId = 'agent-group-run-workspace';
const groupId = 'agent-group-run-group';
const supervisorAgentId = 'agent-group-run-supervisor';
const memberAgentId = 'agent-group-run-member';

const serverDB: LobeChatDatabase = await getTestDB();

const makePlan = (agentId = memberAgentId): AgentGroupRunPlanSnapshot => ({
  nodes: [
    {
      agentId,
      dependencies: [],
      instruction: 'Complete the assigned work',
      key: 'work',
      maxAttempts: 1,
      sortOrder: 0,
    },
  ],
  protocol: 'single',
  supervisorAgentId,
  version: 1,
});

const createParams = (overrides: Partial<Parameters<AgentGroupRunModel['create']>[0]> = {}) => ({
  chatGroupId: groupId,
  idempotencyKey: 'request-1',
  planHash: 'a'.repeat(64),
  planSnapshot: makePlan(),
  supervisorAgentId,
  supervisorOperationId: 'supervisor-operation-1',
  ...overrides,
});

const seedPersonalGroup = async () => {
  await serverDB.insert(agents).values([
    { id: supervisorAgentId, title: 'Supervisor', userId },
    { id: memberAgentId, title: 'Member', userId },
  ]);
  await serverDB.insert(chatGroups).values({ id: groupId, title: 'Group', userId });
  await serverDB.insert(agentOperations).values({
    agentId: supervisorAgentId,
    chatGroupId: groupId,
    id: 'supervisor-operation-1',
    status: 'running',
    userId,
  });
};

const seedWorkspaceGroup = async (visibility: 'private' | 'public' = 'public') => {
  await serverDB.insert(workspaces).values({
    id: workspaceId,
    name: 'Agent Group Run Workspace',
    primaryOwnerId: userId,
    slug: workspaceId,
  });
  await serverDB.insert(agents).values([
    { id: supervisorAgentId, title: 'Supervisor', userId, workspaceId },
    { id: memberAgentId, title: 'Member', userId, workspaceId },
  ]);
  await serverDB
    .insert(chatGroups)
    .values({ id: groupId, title: 'Workspace Group', userId, visibility, workspaceId });
  await serverDB.insert(agentOperations).values({
    agentId: supervisorAgentId,
    chatGroupId: groupId,
    id: 'supervisor-operation-1',
    status: 'running',
    userId,
    workspaceId,
  });
};

beforeEach(async () => {
  await serverDB.delete(agentOperations);
  await serverDB.delete(users);
  await serverDB.insert(users).values([{ id: userId }, { id: otherUserId }]);
});

describe('AgentGroupRunModel', () => {
  it('persists an immutable run snapshot and normalized nodes', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);

    const result = await model.create(createParams());

    expect(result.created).toBe(true);
    expect(result.run.id).toMatch(/^agr_/);
    expect(result.run).toMatchObject({
      chatGroupId: groupId,
      idempotencyKey: 'request-1',
      planHash: 'a'.repeat(64),
      planVersion: 1,
      protocol: 'single',
      status: 'pending',
      supervisorAgentId,
      supervisorOperationId: 'supervisor-operation-1',
      userId,
      workspaceId: null,
    });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      agentId: memberAgentId,
      dependencies: [],
      instruction: 'Complete the assigned work',
      maxAttempts: 1,
      nodeKey: 'work',
      sortOrder: 0,
      status: 'pending',
    });
    expect(result.attempts).toEqual([]);
    expect(result.operations.map((operation) => operation.id)).toEqual(['supervisor-operation-1']);

    const events = await model.listEvents(result.run.id);
    expect(events?.map(({ type }) => type)).toEqual(['run.created', 'node.created']);
  });

  it('returns the existing run for an identical idempotent create', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);

    const first = await model.create(createParams());
    const second = await model.create(createParams());

    expect(second.run.id).toBe(first.run.id);
    expect(second.created).toBe(false);
    expect(second.nodes).toHaveLength(1);
  });

  it('rejects reuse of an idempotency key for a different plan', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    await model.create(createParams());

    await expect(model.create(createParams({ planHash: 'b'.repeat(64) }))).rejects.toThrowError(
      AGENT_GROUP_RUN_IDEMPOTENCY_CONFLICT,
    );
  });

  it('rejects a supervisor operation from a different agent or group', async () => {
    await seedPersonalGroup();
    await serverDB.insert(agentOperations).values({
      agentId: memberAgentId,
      chatGroupId: groupId,
      id: 'invalid-supervisor-operation',
      status: 'running',
      userId,
    });
    const model = new AgentGroupRunModel(serverDB, userId);

    await expect(
      model.create(
        createParams({
          idempotencyKey: 'invalid-supervisor',
          supervisorOperationId: 'invalid-supervisor-operation',
        }),
      ),
    ).rejects.toThrowError(AGENT_GROUP_RUN_OPERATION_MISMATCH);
  });

  it('isolates personal runs by owner', async () => {
    await seedPersonalGroup();
    const owner = new AgentGroupRunModel(serverDB, userId);
    const attacker = new AgentGroupRunModel(serverDB, otherUserId);
    const created = await owner.create(createParams());

    expect(await attacker.findById(created.run.id)).toBeUndefined();
    await expect(
      attacker.create(createParams({ idempotencyKey: 'attacker-request' })),
    ).rejects.toThrowError(AGENT_GROUP_RUN_NOT_FOUND);
  });

  it('follows current workspace group visibility for historical runs', async () => {
    await seedWorkspaceGroup('public');
    const owner = new AgentGroupRunModel(serverDB, userId, workspaceId);
    const workspaceMember = new AgentGroupRunModel(serverDB, otherUserId, workspaceId);
    const created = await owner.create(createParams());

    expect(await workspaceMember.findById(created.run.id)).toBeDefined();

    await serverDB
      .update(chatGroups)
      .set({ visibility: 'private' })
      .where(eq(chatGroups.id, groupId));

    expect(await workspaceMember.findById(created.run.id)).toBeUndefined();
    expect(await owner.findById(created.run.id)).toBeDefined();
  });

  it('links an attempt only to an operation for the same node agent and group', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(createParams());
    const node = created.nodes[0];
    await serverDB.insert(agentOperations).values([
      {
        agentId: memberAgentId,
        chatGroupId: groupId,
        id: 'member-operation',
        status: 'running',
        userId,
      },
      {
        agentId: supervisorAgentId,
        chatGroupId: groupId,
        id: 'wrong-agent-operation',
        status: 'running',
        userId,
      },
    ]);

    const first = await model.createAttempt({
      attemptNo: 1,
      operationId: 'member-operation',
      runNodeId: node.id,
      runtimeKind: 'normal',
    });
    const repeated = await model.createAttempt({
      attemptNo: 1,
      operationId: 'member-operation',
      runNodeId: node.id,
      runtimeKind: 'normal',
    });

    expect(repeated.id).toBe(first.id);
    await expect(
      model.createAttempt({
        attemptNo: 2,
        operationId: 'wrong-agent-operation',
        runNodeId: node.id,
        runtimeKind: 'normal',
      }),
    ).rejects.toThrowError(AGENT_GROUP_RUN_OPERATION_MISMATCH);

    const completed = await model.completeAttempt({
      attemptNo: 1,
      completionReason: 'done',
      operationId: 'member-operation',
      runNodeId: node.id,
      runtimeKind: 'normal',
      status: 'completed',
    });
    const repeatedCompletion = await model.completeAttempt({
      attemptNo: 1,
      completionReason: 'done',
      operationId: 'member-operation',
      runNodeId: node.id,
      runtimeKind: 'normal',
      status: 'completed',
    });
    const snapshot = await model.findById(created.run.id);

    expect(repeatedCompletion.id).toBe(completed.id);
    expect(snapshot?.attempts[0].status).toBe('completed');
    expect(snapshot?.nodes[0].status).toBe('completed');
    expect(snapshot?.run.status).toBe('completed');
    expect(snapshot?.operations.map((operation) => operation.id)).toEqual([
      'supervisor-operation-1',
      'member-operation',
    ]);
    const events = await model.listEvents(created.run.id);
    expect(events?.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      'run:created',
      expect.stringMatching(/^node:.*:created$/),
      expect.stringMatching(/^attempt:.*:running$/),
      expect.stringMatching(/^node:.*:running$/),
      'run:running',
      expect.stringMatching(/^attempt:.*:terminal:completed$/),
      expect.stringMatching(/^node:.*:terminal:completed$/),
      'run:terminal:completed',
    ]);
  });

  it('settles a run when its only node fails before launch', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(createParams());

    await model.failNodeStart({
      error: { code: 'START_FAILED', message: 'Scheduler unavailable' },
      runNodeId: created.nodes[0].id,
    });

    const snapshot = await model.findById(created.run.id);
    expect(snapshot?.nodes[0]).toMatchObject({
      completionReason: 'start_failed',
      status: 'failed',
    });
    expect(snapshot?.run).toMatchObject({ completionReason: 'failed', status: 'failed' });
  });

  it('creates and completes an attempt idempotently when the callback wins the start race', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(createParams());
    await serverDB.insert(agentOperations).values({
      agentId: memberAgentId,
      chatGroupId: groupId,
      id: 'fast-member-operation',
      status: 'done',
      userId,
    });

    await model.completeAttempt({
      attemptNo: 1,
      completionReason: 'done',
      operationId: 'fast-member-operation',
      runNodeId: created.nodes[0].id,
      runtimeKind: 'normal',
      status: 'completed',
    });
    const lateStartRecord = await model.createAttempt({
      attemptNo: 1,
      operationId: 'fast-member-operation',
      runNodeId: created.nodes[0].id,
      runtimeKind: 'normal',
    });

    const snapshot = await model.findById(created.run.id);
    expect(lateStartRecord.status).toBe('completed');
    expect(snapshot?.attempts).toHaveLength(1);
    expect(snapshot?.attempts[0]).toMatchObject({
      operationId: 'fast-member-operation',
      status: 'completed',
    });
    expect(snapshot?.run.status).toBe('completed');
  });

  it('marks cancelling before returning active operations and finalizes idempotently', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(createParams());
    await serverDB.insert(agentOperations).values({
      agentId: memberAgentId,
      chatGroupId: groupId,
      id: 'cancel-member-operation',
      status: 'running',
      userId,
    });
    await model.createAttempt({
      attemptNo: 1,
      operationId: 'cancel-member-operation',
      runNodeId: created.nodes[0].id,
      runtimeKind: 'normal',
    });

    const transition = await model.beginCancellation(created.run.id);
    expect(transition).toMatchObject({
      activeOperationIds: ['cancel-member-operation'],
      alreadyTerminal: false,
      supervisorOperationId: 'supervisor-operation-1',
    });
    expect(transition.snapshot.run.status).toBe('cancelling');

    const cancelled = await model.finalizeCancellation(created.run.id);
    const repeated = await model.finalizeCancellation(created.run.id);
    expect(cancelled.run).toMatchObject({ completionReason: 'cancelled', status: 'cancelled' });
    expect(cancelled.nodes[0]).toMatchObject({
      completionReason: 'cancelled',
      status: 'cancelled',
    });
    expect(cancelled.attempts[0].status).toBe('cancelled');
    expect(repeated.run.status).toBe('cancelled');

    const events = await model.listEvents(created.run.id);
    expect(
      events?.filter(({ idempotencyKey }) => idempotencyKey === 'run:cancelling'),
    ).toHaveLength(1);
    expect(
      events?.filter(({ idempotencyKey }) => idempotencyKey === 'run:terminal:cancelled'),
    ).toHaveLength(1);
  });
});
