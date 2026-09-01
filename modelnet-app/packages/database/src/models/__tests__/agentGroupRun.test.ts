// @vitest-environment node
import type { AgentGroupRunPlanSnapshot } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { getTestDB } from '../../core/getTestDB';
import { agentOperations, agents, chatGroups, users, workspaces } from '../../schemas';
import {
  AGENT_GROUP_RUN_DISPATCH_CLAIM_CONFLICT,
  AGENT_GROUP_RUN_DISPATCH_CLAIM_INVALID,
  AGENT_GROUP_RUN_IDEMPOTENCY_CONFLICT,
  AGENT_GROUP_RUN_NODE_NOT_READY,
  AGENT_GROUP_RUN_NOT_FOUND,
  AGENT_GROUP_RUN_OPERATION_MISMATCH,
  AGENT_GROUP_RUN_PAUSE_NOT_ALLOWED,
  AGENT_GROUP_RUN_RETRY_LIMIT_EXCEEDED,
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

const makePipelinePlan = (
  nodes: Array<{ dependencies: string[]; key: string; maxAttempts?: number }>,
): AgentGroupRunPlanSnapshot => ({
  nodes: nodes.map((node, sortOrder) => ({
    agentId: memberAgentId,
    dependencies: node.dependencies,
    instruction: `Complete pipeline node ${node.key}`,
    key: node.key,
    maxAttempts: node.maxAttempts ?? 1,
    sortOrder,
  })),
  protocol: 'pipeline',
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

  it('persists pipeline readiness and unlocks a join only after every dependency completes', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(
      createParams({
        idempotencyKey: 'pipeline-join',
        planHash: 'c'.repeat(64),
        planSnapshot: makePipelinePlan([
          { dependencies: [], key: 'research' },
          { dependencies: [], key: 'review' },
          { dependencies: ['research', 'review'], key: 'synthesis' },
        ]),
      }),
    );
    const nodes = new Map(created.nodes.map((node) => [node.nodeKey, node]));
    await serverDB.insert(agentOperations).values(
      ['research', 'review', 'synthesis'].map((key) => ({
        agentId: memberAgentId,
        chatGroupId: groupId,
        id: `pipeline-${key}-operation`,
        status: 'running' as const,
        userId,
      })),
    );

    expect(
      Object.fromEntries(created.nodes.map(({ nodeKey, status }) => [nodeKey, status])),
    ).toEqual({ research: 'ready', review: 'ready', synthesis: 'pending' });
    await expect(
      model.createAttempt({
        attemptNo: 1,
        operationId: 'pipeline-synthesis-operation',
        runNodeId: nodes.get('synthesis')!.id,
        runtimeKind: 'normal',
      }),
    ).rejects.toThrowError(AGENT_GROUP_RUN_NODE_NOT_READY);

    await model.completeAttempt({
      attemptNo: 1,
      completionReason: 'done',
      operationId: 'pipeline-research-operation',
      runNodeId: nodes.get('research')!.id,
      runtimeKind: 'normal',
      status: 'completed',
    });
    let reconnectedModel = new AgentGroupRunModel(serverDB, userId);
    let snapshot = await reconnectedModel.findById(created.run.id);
    expect(snapshot?.nodes.find(({ nodeKey }) => nodeKey === 'synthesis')?.status).toBe('pending');

    const reviewCompletion = {
      attemptNo: 1,
      completionReason: 'done',
      operationId: 'pipeline-review-operation',
      runNodeId: nodes.get('review')!.id,
      runtimeKind: 'normal' as const,
      status: 'completed' as const,
    };
    await reconnectedModel.completeAttempt(reviewCompletion);
    await reconnectedModel.completeAttempt(reviewCompletion);
    reconnectedModel = new AgentGroupRunModel(serverDB, userId);
    snapshot = await reconnectedModel.findById(created.run.id);
    expect(snapshot?.nodes.find(({ nodeKey }) => nodeKey === 'synthesis')?.status).toBe('ready');
    expect(snapshot?.run.status).toBe('running');

    await reconnectedModel.completeAttempt({
      attemptNo: 1,
      completionReason: 'done',
      operationId: 'pipeline-synthesis-operation',
      runNodeId: nodes.get('synthesis')!.id,
      runtimeKind: 'normal',
      status: 'completed',
    });
    snapshot = await reconnectedModel.findById(created.run.id);
    expect(snapshot?.run).toMatchObject({ completionReason: 'completed', status: 'completed' });

    const events = await reconnectedModel.listEvents(created.run.id);
    expect(events?.filter(({ type }) => type === 'node.ready')).toHaveLength(3);
    expect(
      events?.filter(
        ({ runNodeId, type }) => type === 'node.ready' && runNodeId === nodes.get('synthesis')!.id,
      ),
    ).toHaveLength(1);
  });

  it('serializes concurrent pipeline completions so a join cannot remain pending', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(
      createParams({
        idempotencyKey: 'pipeline-concurrent-join',
        planHash: 'e'.repeat(64),
        planSnapshot: makePipelinePlan([
          { dependencies: [], key: 'left' },
          { dependencies: [], key: 'right' },
          { dependencies: ['left', 'right'], key: 'join' },
        ]),
      }),
    );
    const nodes = new Map(created.nodes.map((node) => [node.nodeKey, node]));
    await serverDB.insert(agentOperations).values(
      ['left', 'right'].map((key) => ({
        agentId: memberAgentId,
        chatGroupId: groupId,
        id: `pipeline-concurrent-${key}`,
        status: 'running' as const,
        userId,
      })),
    );

    await Promise.all(
      ['left', 'right'].map((key) =>
        model.completeAttempt({
          attemptNo: 1,
          completionReason: 'done',
          operationId: `pipeline-concurrent-${key}`,
          runNodeId: nodes.get(key)!.id,
          runtimeKind: 'normal',
          status: 'completed',
        }),
      ),
    );

    const reconnectedModel = new AgentGroupRunModel(serverDB, userId);
    const snapshot = await reconnectedModel.findById(created.run.id);
    expect(snapshot?.nodes.find(({ nodeKey }) => nodeKey === 'join')?.status).toBe('ready');
    const events = await reconnectedModel.listEvents(created.run.id);
    expect(
      events?.filter(
        ({ runNodeId, type }) => type === 'node.ready' && runNodeId === nodes.get('join')!.id,
      ),
    ).toHaveLength(1);
  });

  it('atomically grants one live dispatch lease for a ready pipeline node', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(
      createParams({
        idempotencyKey: 'pipeline-dispatch-claim',
        planHash: 'f'.repeat(64),
        planSnapshot: makePipelinePlan([{ dependencies: [], key: 'root' }]),
      }),
    );
    const now = new Date('2026-08-31T00:00:00.000Z');

    const [left, right] = await Promise.all([
      model.claimReadyNodes({ leaseDurationMs: 30_000, runId: created.run.id }, now),
      new AgentGroupRunModel(serverDB, userId).claimReadyNodes(
        { leaseDurationMs: 30_000, runId: created.run.id },
        now,
      ),
    ]);
    const winners = [left, right].filter((claims) => claims.length === 1);
    const losers = [left, right].filter((claims) => claims.length === 0);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0][0]).toMatchObject({
      attemptNo: 1,
      claimedAt: now,
      node: { nodeKey: 'root', status: 'ready' },
      upstream: [],
    });
    expect(winners[0][0].expiresAt).toEqual(new Date('2026-08-31T00:00:30.000Z'));
    expect(winners[0][0].claimId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const events = await model.listEvents(created.run.id);
    expect(events?.filter(({ type }) => type === 'node.dispatch_claimed')).toHaveLength(1);
  });

  it('counts live dispatch leases against the persisted maxParallel budget', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(
      createParams({
        budgetSnapshot: { maxParallel: 1 },
        idempotencyKey: 'pipeline-dispatch-parallel-budget',
        planHash: '0'.repeat(64),
        planSnapshot: makePipelinePlan([
          { dependencies: [], key: 'left' },
          { dependencies: [], key: 'right' },
        ]),
      }),
    );
    const now = new Date('2026-08-31T00:00:00.000Z');

    const first = await model.claimReadyNodes(
      { leaseDurationMs: 30_000, limit: 10, runId: created.run.id },
      now,
    );
    const whileClaimed = await new AgentGroupRunModel(serverDB, userId).claimReadyNodes(
      { leaseDurationMs: 30_000, limit: 10, runId: created.run.id },
      now,
    );

    expect(first).toHaveLength(1);
    expect(whileClaimed).toEqual([]);
    await model.releaseDispatchClaim({
      claimId: first[0].claimId,
      reason: 'test_release',
      runNodeId: first[0].node.id,
    });
    await expect(
      model.claimReadyNodes(
        { leaseDurationMs: 30_000, limit: 10, runId: created.run.id },
        now,
      ),
    ).resolves.toHaveLength(1);
  });

  it('reclaims an expired dispatch lease and carries structured upstream operation refs', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(
      createParams({
        idempotencyKey: 'pipeline-dispatch-recovery',
        planHash: '1'.repeat(64),
        planSnapshot: makePipelinePlan([
          { dependencies: [], key: 'source' },
          { dependencies: ['source'], key: 'consumer' },
        ]),
      }),
    );
    const nodes = new Map(created.nodes.map((node) => [node.nodeKey, node]));
    await serverDB.insert(agentOperations).values({
      agentId: memberAgentId,
      chatGroupId: groupId,
      id: 'pipeline-upstream-operation',
      status: 'running',
      userId,
    });
    await model.completeAttempt({
      attemptNo: 1,
      completionReason: 'done',
      externalExecutionRef: { contextId: 'upstream-context', taskId: 'upstream-task' },
      operationId: 'pipeline-upstream-operation',
      outputSnapshot: {
        summary: 'Upstream completed the research.',
        workVersionRefs: [
          {
            rootOperationId: 'pipeline-upstream-operation',
            workId: 'work-1',
            workVersionId: 'work-version-1',
          },
        ],
      },
      runNodeId: nodes.get('source')!.id,
      runtimeKind: 'heterogeneous',
      status: 'completed',
    });

    const first = await model.claimReadyNodes(
      { leaseDurationMs: 1_000, limit: 1, runId: created.run.id },
      new Date('2026-08-31T00:00:00.000Z'),
    );
    expect(first).toHaveLength(1);
    expect(first[0].node.nodeKey).toBe('consumer');
    expect(first[0].upstream).toEqual([
      {
        attemptNo: 1,
        completionReason: 'done',
        externalExecutionRef: { contextId: 'upstream-context', taskId: 'upstream-task' },
        nodeKey: 'source',
        operationId: 'pipeline-upstream-operation',
        outputSnapshot: {
          summary: 'Upstream completed the research.',
          workVersionRefs: [
            {
              rootOperationId: 'pipeline-upstream-operation',
              workId: 'work-1',
              workVersionId: 'work-version-1',
            },
          ],
        },
        runNodeId: nodes.get('source')!.id,
        runtimeKind: 'heterogeneous',
      },
    ]);

    await expect(
      model.claimReadyNodes(
        { leaseDurationMs: 1_000, runId: created.run.id },
        new Date('2026-08-31T00:00:00.999Z'),
      ),
    ).resolves.toEqual([]);
    const recovered = await new AgentGroupRunModel(serverDB, userId).claimReadyNodes(
      { leaseDurationMs: 1_000, runId: created.run.id },
      new Date('2026-08-31T00:00:01.000Z'),
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0].claimId).not.toBe(first[0].claimId);
    expect(
      await model.releaseDispatchClaim({
        claimId: first[0].claimId,
        reason: 'stale_worker',
        runNodeId: nodes.get('consumer')!.id,
      }),
    ).toBe(false);
    expect(
      await model.releaseDispatchClaim({
        claimId: recovered[0].claimId,
        reason: 'retry_later',
        runNodeId: nodes.get('consumer')!.id,
      }),
    ).toBe(true);

    const snapshot = await model.findById(created.run.id);
    expect(snapshot?.nodes.find(({ nodeKey }) => nodeKey === 'consumer')).toMatchObject({
      dispatchClaimExpiresAt: null,
      dispatchClaimId: null,
      status: 'ready',
    });
    const events = await model.listEvents(created.run.id);
    expect(events?.filter(({ type }) => type === 'node.dispatch_lease_expired')).toHaveLength(1);
    expect(events?.filter(({ type }) => type === 'node.dispatch_released')).toHaveLength(1);
  });

  it('fences stale dispatchers when committing a prepared pipeline Attempt', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(
      createParams({
        idempotencyKey: 'pipeline-dispatch-commit',
        planHash: '2'.repeat(64),
        planSnapshot: makePipelinePlan([{ dependencies: [], key: 'root' }]),
      }),
    );
    const [claim] = await model.claimReadyNodes({
      leaseDurationMs: 30_000,
      runId: created.run.id,
    });
    await serverDB.insert(agentOperations).values({
      agentId: memberAgentId,
      chatGroupId: groupId,
      id: 'pipeline-claimed-operation',
      status: 'running',
      userId,
    });
    const attempt = {
      attemptNo: claim.attemptNo,
      operationId: 'pipeline-claimed-operation',
      runNodeId: claim.node.id,
      runtimeKind: 'normal' as const,
    };

    await expect(
      model.createClaimedAttempt({ ...attempt, dispatchClaimId: crypto.randomUUID() }),
    ).rejects.toThrowError(AGENT_GROUP_RUN_DISPATCH_CLAIM_CONFLICT);
    const committed = await model.createClaimedAttempt({
      ...attempt,
      dispatchClaimId: claim.claimId,
    });
    const replayed = await model.createClaimedAttempt({
      ...attempt,
      dispatchClaimId: claim.claimId,
    });

    expect(committed.id).toBe(replayed.id);
    const snapshot = await model.findById(created.run.id);
    expect(snapshot?.nodes[0]).toMatchObject({
      dispatchClaimExpiresAt: null,
      dispatchClaimId: null,
      status: 'running',
    });
    expect(snapshot?.attempts).toHaveLength(1);
    const events = await model.listEvents(created.run.id);
    expect(events?.filter(({ type }) => type === 'node.dispatch_committed')).toHaveLength(1);
    expect(events?.filter(({ type }) => type === 'attempt.started')).toHaveLength(1);
  });

  it('fences a stale dispatcher before it can fail a reclaimed node', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(
      createParams({
        idempotencyKey: 'pipeline-dispatch-failed-start-fencing',
        planHash: '3'.repeat(64),
        planSnapshot: makePipelinePlan([{ dependencies: [], key: 'root' }]),
      }),
    );
    const [claim] = await model.claimReadyNodes({
      leaseDurationMs: 30_000,
      runId: created.run.id,
    });
    const error = { code: 'START_FAILED', message: 'member could not start' };

    await expect(
      model.failClaimedNodeStart({
        dispatchClaimId: crypto.randomUUID(),
        error,
        runNodeId: claim.node.id,
      }),
    ).resolves.toBe(false);
    await expect(
      model.failClaimedNodeStart({
        dispatchClaimId: claim.claimId,
        error,
        runNodeId: claim.node.id,
      }),
    ).resolves.toBe(true);

    const snapshot = await model.findById(created.run.id);
    expect(snapshot?.nodes[0]).toMatchObject({
      completionReason: 'start_failed',
      dispatchClaimId: null,
      status: 'failed',
    });
    expect(snapshot?.run.status).toBe('failed');
  });

  it('rejects invalid dispatch lease bounds before touching a Run', async () => {
    const model = new AgentGroupRunModel(serverDB, userId);

    await expect(
      model.claimReadyNodes({ leaseDurationMs: 999, runId: 'missing' }),
    ).rejects.toThrowError(AGENT_GROUP_RUN_DISPATCH_CLAIM_INVALID);
    await expect(
      model.claimReadyNodes({ leaseDurationMs: 1_000, limit: 101, runId: 'missing' }),
    ).rejects.toThrowError(AGENT_GROUP_RUN_DISPATCH_CLAIM_INVALID);
  });

  it('recursively blocks failed pipeline descendants and revives them after a successful retry', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(
      createParams({
        idempotencyKey: 'pipeline-retry',
        planHash: 'd'.repeat(64),
        planSnapshot: makePipelinePlan([
          { dependencies: [], key: 'draft', maxAttempts: 2 },
          { dependencies: ['draft'], key: 'critique' },
          { dependencies: ['critique'], key: 'publish' },
        ]),
      }),
    );
    const nodes = new Map(created.nodes.map((node) => [node.nodeKey, node]));
    await serverDB.insert(agentOperations).values(
      ['draft-attempt-1', 'draft-attempt-2', 'critique-attempt-1', 'publish-attempt-1'].map(
        (key) => ({
          agentId: memberAgentId,
          chatGroupId: groupId,
          id: `pipeline-${key}`,
          status: 'running' as const,
          userId,
        }),
      ),
    );

    await model.completeAttempt({
      attemptNo: 1,
      completionReason: 'error',
      operationId: 'pipeline-draft-attempt-1',
      runNodeId: nodes.get('draft')!.id,
      runtimeKind: 'normal',
      status: 'failed',
    });
    let snapshot = await model.findById(created.run.id);
    expect(
      Object.fromEntries(snapshot!.nodes.map(({ nodeKey, status }) => [nodeKey, status])),
    ).toEqual({ critique: 'blocked', draft: 'failed', publish: 'blocked' });
    expect(snapshot?.run).toMatchObject({ completionReason: 'failed', status: 'failed' });
    await expect(
      model.createAttempt({
        attemptNo: 1,
        operationId: 'pipeline-critique-attempt-1',
        runNodeId: nodes.get('critique')!.id,
        runtimeKind: 'normal',
      }),
    ).rejects.toThrowError(AGENT_GROUP_RUN_NODE_NOT_READY);

    await model.startRetryAttempt({
      attemptNo: 2,
      operationId: 'pipeline-draft-attempt-2',
      runNodeId: nodes.get('draft')!.id,
      runtimeKind: 'normal',
    });
    await model.completeAttempt({
      attemptNo: 2,
      completionReason: 'done',
      operationId: 'pipeline-draft-attempt-2',
      runNodeId: nodes.get('draft')!.id,
      runtimeKind: 'normal',
      status: 'completed',
    });
    let reconnectedModel = new AgentGroupRunModel(serverDB, userId);
    snapshot = await reconnectedModel.findById(created.run.id);
    expect(
      Object.fromEntries(snapshot!.nodes.map(({ nodeKey, status }) => [nodeKey, status])),
    ).toEqual({ critique: 'ready', draft: 'completed', publish: 'blocked' });

    await reconnectedModel.completeAttempt({
      attemptNo: 1,
      completionReason: 'done',
      operationId: 'pipeline-critique-attempt-1',
      runNodeId: nodes.get('critique')!.id,
      runtimeKind: 'normal',
      status: 'completed',
    });
    reconnectedModel = new AgentGroupRunModel(serverDB, userId);
    snapshot = await reconnectedModel.findById(created.run.id);
    expect(snapshot?.nodes.find(({ nodeKey }) => nodeKey === 'publish')?.status).toBe('ready');

    await reconnectedModel.completeAttempt({
      attemptNo: 1,
      completionReason: 'done',
      operationId: 'pipeline-publish-attempt-1',
      runNodeId: nodes.get('publish')!.id,
      runtimeKind: 'normal',
      status: 'completed',
    });
    snapshot = await reconnectedModel.findById(created.run.id);
    expect(snapshot?.run).toMatchObject({ completionReason: 'completed', status: 'completed' });
    const events = await reconnectedModel.listEvents(created.run.id);
    expect(events?.filter(({ type }) => type === 'node.blocked')).toHaveLength(2);
    expect(events?.filter(({ type }) => type === 'node.ready')).toHaveLength(3);
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
    expect(snapshot?.attempts[0]).toMatchObject({ completionReason: 'done', status: 'completed' });
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
      expect.stringMatching(/^node:.*:attempt:.*:terminal:completed$/),
      expect.stringMatching(/^run:terminal:completed:attempt:/),
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

  it('persists an intervention gate and clears it only after the Attempt terminalizes', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(createParams());
    const node = created.nodes[0];
    await serverDB.insert(agentOperations).values({
      agentId: memberAgentId,
      chatGroupId: groupId,
      id: 'intervention-member-operation',
      status: 'waiting_for_human',
      userId,
    });
    await model.createAttempt({
      attemptNo: 1,
      operationId: 'intervention-member-operation',
      runNodeId: node.id,
      runtimeKind: 'normal',
    });

    const parked = await model.parkAttemptForIntervention({
      attemptNo: 1,
      operationId: 'intervention-member-operation',
      runNodeId: node.id,
      runtimeKind: 'normal',
    });
    const repeated = await model.parkAttemptForIntervention({
      attemptNo: 1,
      operationId: 'intervention-member-operation',
      runNodeId: node.id,
      runtimeKind: 'normal',
    });
    const reconnectedModel = new AgentGroupRunModel(serverDB, userId);
    let snapshot = await reconnectedModel.findById(created.run.id);

    expect(repeated.id).toBe(parked.id);
    expect(snapshot?.attempts[0]).toMatchObject({
      completionReason: 'waiting_for_human',
      status: 'waiting',
    });
    expect(snapshot?.nodes[0]).toMatchObject({
      completionReason: 'waiting_for_human',
      status: 'waiting',
    });
    expect(snapshot?.run).toMatchObject({
      completionReason: 'waiting_for_human',
      status: 'waiting',
    });

    await reconnectedModel.completeAttempt({
      attemptNo: 1,
      completionReason: 'done',
      operationId: 'intervention-member-operation',
      runNodeId: node.id,
      runtimeKind: 'normal',
      status: 'completed',
    });
    snapshot = await reconnectedModel.findById(created.run.id);
    expect(snapshot?.attempts[0]).toMatchObject({ completionReason: 'done', status: 'completed' });
    expect(snapshot?.run).toMatchObject({ completionReason: 'completed', status: 'completed' });

    const events = await reconnectedModel.listEvents(created.run.id);
    expect(events?.filter(({ type }) => type === 'attempt.intervention_required')).toHaveLength(1);
    expect(events?.filter(({ type }) => type === 'run.intervention_required')).toHaveLength(1);
    expect(events?.filter(({ type }) => type === 'run.intervention_cleared')).toHaveLength(1);
    expect(events?.filter(({ type }) => type === 'run.terminal')).toHaveLength(1);
  });

  it('reopens a terminal node with a new immutable attempt and settles again', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(
      createParams({
        planSnapshot: {
          ...makePlan(),
          nodes: [{ ...makePlan().nodes[0], maxAttempts: 2 }],
        },
      }),
    );
    await serverDB.insert(agentOperations).values([
      {
        agentId: memberAgentId,
        chatGroupId: groupId,
        id: 'retry-member-operation-1',
        status: 'done',
        userId,
      },
      {
        agentId: memberAgentId,
        chatGroupId: groupId,
        id: 'retry-member-operation-2',
        status: 'running',
        userId,
      },
    ]);
    await model.completeAttempt({
      attemptNo: 1,
      completionReason: 'error',
      operationId: 'retry-member-operation-1',
      runNodeId: created.nodes[0].id,
      runtimeKind: 'normal',
      status: 'failed',
    });

    const retry = await model.startRetryAttempt({
      attemptNo: 2,
      operationId: 'retry-member-operation-2',
      runNodeId: created.nodes[0].id,
      runtimeKind: 'normal',
    });
    const repeated = await model.startRetryAttempt({
      attemptNo: 2,
      operationId: 'retry-member-operation-2',
      runNodeId: created.nodes[0].id,
      runtimeKind: 'normal',
    });
    let snapshot = await model.findById(created.run.id);

    expect(repeated.id).toBe(retry.id);
    expect(snapshot?.run).toMatchObject({ completionReason: null, status: 'running' });
    expect(snapshot?.nodes[0]).toMatchObject({ completionReason: null, status: 'running' });
    expect(snapshot?.attempts.map(({ attemptNo, status }) => ({ attemptNo, status }))).toEqual([
      { attemptNo: 1, status: 'failed' },
      { attemptNo: 2, status: 'running' },
    ]);
    await expect(
      model.isLatestAttempt({
        attemptNo: 1,
        operationId: 'retry-member-operation-1',
        runNodeId: created.nodes[0].id,
      }),
    ).resolves.toBe(false);
    await expect(
      model.isLatestAttempt({
        attemptNo: 2,
        operationId: 'retry-member-operation-2',
        runNodeId: created.nodes[0].id,
      }),
    ).resolves.toBe(true);

    await model.completeAttempt({
      attemptNo: 2,
      completionReason: 'done',
      operationId: 'retry-member-operation-2',
      runNodeId: created.nodes[0].id,
      runtimeKind: 'normal',
      status: 'completed',
    });
    snapshot = await model.findById(created.run.id);
    expect(snapshot?.nodes[0]).toMatchObject({ completionReason: 'done', status: 'completed' });
    expect(snapshot?.run).toMatchObject({ completionReason: 'completed', status: 'completed' });
    const events = await model.listEvents(created.run.id);
    expect(events?.map(({ type }) => type)).toContain('node.retry_started');
    expect(events?.map(({ type }) => type)).toContain('run.reopened');
    expect(events?.filter(({ type }) => type === 'node.terminal')).toHaveLength(2);
    expect(events?.filter(({ type }) => type === 'run.terminal')).toHaveLength(2);
  });

  it('refuses a retry beyond the immutable node maxAttempts budget', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(createParams());
    await serverDB.insert(agentOperations).values([
      {
        agentId: memberAgentId,
        chatGroupId: groupId,
        id: 'retry-limit-operation-1',
        status: 'done',
        userId,
      },
      {
        agentId: memberAgentId,
        chatGroupId: groupId,
        id: 'retry-limit-operation-2',
        status: 'running',
        userId,
      },
    ]);
    await model.completeAttempt({
      attemptNo: 1,
      completionReason: 'done',
      operationId: 'retry-limit-operation-1',
      runNodeId: created.nodes[0].id,
      runtimeKind: 'normal',
      status: 'completed',
    });

    await expect(
      model.startRetryAttempt({
        attemptNo: 2,
        operationId: 'retry-limit-operation-2',
        runNodeId: created.nodes[0].id,
        runtimeKind: 'normal',
      }),
    ).rejects.toThrowError(AGENT_GROUP_RUN_RETRY_LIMIT_EXCEEDED);
  });

  it('parks the supervisor barrier while members settle, then resumes and converges', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(createParams());
    await serverDB.insert(agentOperations).values({
      agentId: memberAgentId,
      chatGroupId: groupId,
      id: 'pause-member-operation',
      status: 'running',
      userId,
    });
    await model.createAttempt({
      attemptNo: 1,
      operationId: 'pause-member-operation',
      runNodeId: created.nodes[0].id,
      runtimeKind: 'normal',
    });
    await serverDB
      .update(agentOperations)
      .set({ status: 'waiting_for_async_tool' })
      .where(eq(agentOperations.id, 'supervisor-operation-1'));

    const paused = await model.pauseAtBarrier(created.run.id);
    const repeated = await model.pauseAtBarrier(created.run.id);
    expect(paused.run).toMatchObject({ completionReason: 'manual_pause', status: 'waiting' });
    expect(repeated.run).toMatchObject({ completionReason: 'manual_pause', status: 'waiting' });
    let [supervisorOperation] = await serverDB
      .select({ status: agentOperations.status })
      .from(agentOperations)
      .where(eq(agentOperations.id, 'supervisor-operation-1'));
    expect(supervisorOperation.status).toBe('waiting_for_group_resume');

    await model.completeAttempt({
      attemptNo: 1,
      completionReason: 'done',
      operationId: 'pause-member-operation',
      runNodeId: created.nodes[0].id,
      runtimeKind: 'normal',
      status: 'completed',
    });
    let snapshot = await model.findById(created.run.id);
    expect(snapshot?.nodes[0].status).toBe('completed');
    expect(snapshot?.run).toMatchObject({ completionReason: 'manual_pause', status: 'waiting' });

    snapshot = await model.resumeFromBarrier(created.run.id);
    [supervisorOperation] = await serverDB
      .select({ status: agentOperations.status })
      .from(agentOperations)
      .where(eq(agentOperations.id, 'supervisor-operation-1'));
    expect(supervisorOperation.status).toBe('waiting_for_async_tool');
    expect(snapshot.run).toMatchObject({ completionReason: 'completed', status: 'completed' });

    const events = await model.listEvents(created.run.id);
    expect(events?.filter(({ type }) => type === 'run.paused')).toHaveLength(1);
    expect(events?.filter(({ type }) => type === 'run.resumed')).toHaveLength(1);
    expect(events?.filter(({ type }) => type === 'run.terminal')).toHaveLength(1);
  });

  it('refuses to pause before the supervisor reaches its async-tool barrier', async () => {
    await seedPersonalGroup();
    const model = new AgentGroupRunModel(serverDB, userId);
    const created = await model.create(createParams());

    await expect(model.pauseAtBarrier(created.run.id)).rejects.toThrowError(
      AGENT_GROUP_RUN_PAUSE_NOT_ALLOWED,
    );
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
