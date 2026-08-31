// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentGroupRunSnapshot } from '@/database/models/agentGroupRun';

import {
  AgentGroupRunRecoveryCoordinator,
  type AgentGroupRunRecoveryRuntime,
  type AgentGroupRunRecoveryService,
} from './recovery';

const owner = { id: 'run-1', userId: 'user-1', workspaceId: null };
const bridgeSnapshot = {
  anchorMessageId: 'anchor-1',
  expectedMembers: 1,
  groupToolMessageId: 'group-tool-1',
  mode: 'isolated',
  onComplete: 'resume',
  parentOperationId: 'supervisor-operation-1',
  threadId: 'thread-1',
};

const makeSnapshot = (
  overrides: {
    attemptStatus?: string;
    operationStatus?: string;
    runStatus?: string;
    startedAt?: Date;
    timeoutMs?: number | null;
  } = {},
) =>
  ({
    attempts: [
      {
        attemptNo: 1,
        executionTargetSnapshot: bridgeSnapshot,
        id: 'attempt-1',
        operationId: 'member-operation-1',
        runNodeId: 'node-1',
        runtimeKind: 'normal',
        startedAt: overrides.startedAt ?? new Date('2026-08-30T00:00:00.000Z'),
        status: overrides.attemptStatus ?? 'running',
      },
    ],
    nodes: [
      {
        id: 'node-1',
        runId: 'run-1',
        status: 'running',
        timeoutMs: overrides.timeoutMs ?? null,
      },
    ],
    operations: [
      {
        id: 'member-operation-1',
        status: overrides.operationStatus ?? 'running',
      },
    ],
    run: {
      id: 'run-1',
      status: overrides.runStatus ?? 'running',
      supervisorOperationId: 'supervisor-operation-1',
    },
  }) as unknown as AgentGroupRunSnapshot;

describe('AgentGroupRunRecoveryCoordinator', () => {
  let completeAttempt: ReturnType<typeof vi.fn>;
  let completeMember: ReturnType<typeof vi.fn>;
  let finalizeCancellation: ReturnType<typeof vi.fn>;
  let getRun: ReturnType<typeof vi.fn>;
  let beginCancellation: ReturnType<typeof vi.fn>;
  let interruptOperation: ReturnType<typeof vi.fn>;
  let runtime: AgentGroupRunRecoveryRuntime;
  let service: AgentGroupRunRecoveryService;

  beforeEach(() => {
    beginCancellation = vi.fn();
    completeAttempt = vi.fn();
    completeMember = vi.fn().mockResolvedValue(true);
    finalizeCancellation = vi.fn();
    getRun = vi.fn();
    interruptOperation = vi.fn().mockResolvedValue(true);
    runtime = { completeMember, interruptOperation };
    service = {
      beginCancellation,
      completeAttempt,
      finalizeCancellation,
      getRun,
    } as unknown as AgentGroupRunRecoveryService;
  });

  const createCoordinator = (now = new Date('2026-08-30T00:01:00.000Z')) =>
    new AgentGroupRunRecoveryCoordinator({} as any, {
      createRuntime: async () => runtime,
      createService: () => service,
      now: () => now,
    });

  it('replays a lost member callback from a terminal operation row', async () => {
    getRun.mockResolvedValue(makeSnapshot({ operationStatus: 'done' }));

    const result = await createCoordinator().reconcileRun(owner);

    expect(result).toEqual({ cancelled: false, reconciled: 1, timedOut: 0 });
    expect(completeMember).toHaveBeenCalledWith(
      expect.objectContaining({
        collaboration: expect.objectContaining({ runId: 'run-1', runNodeId: 'node-1' }),
        operationId: 'member-operation-1',
        reason: 'done',
      }),
    );
    expect(interruptOperation).not.toHaveBeenCalled();
  });

  it('enforces an expired node timeout when its queued watchdog was lost', async () => {
    getRun.mockResolvedValue(
      makeSnapshot({
        operationStatus: 'running',
        startedAt: new Date('2026-08-30T00:00:00.000Z'),
        timeoutMs: 10_000,
      }),
    );

    const result = await createCoordinator().reconcileRun(owner);

    expect(result).toEqual({ cancelled: false, reconciled: 1, timedOut: 1 });
    expect(interruptOperation).toHaveBeenCalledWith('member-operation-1');
    expect(completeMember).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'member-operation-1', reason: 'timeout' }),
    );
  });

  it('finishes a cancelling run after a process restart', async () => {
    const running = makeSnapshot({ runStatus: 'cancelling' });
    const cancelled = makeSnapshot({ attemptStatus: 'cancelled', runStatus: 'cancelled' });
    getRun.mockResolvedValue(running);
    beginCancellation.mockResolvedValue({
      activeOperationIds: ['member-operation-1'],
      alreadyTerminal: false,
      snapshot: running,
      supervisorOperationId: 'supervisor-operation-1',
    });
    finalizeCancellation.mockResolvedValue(cancelled);

    const result = await createCoordinator().reconcileRun(owner);

    expect(result).toEqual({ cancelled: true, reconciled: 0, timedOut: 0 });
    expect(interruptOperation).toHaveBeenCalledTimes(2);
    expect(interruptOperation).toHaveBeenCalledWith('supervisor-operation-1');
    expect(interruptOperation).toHaveBeenCalledWith('member-operation-1');
    expect(completeMember).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'member-operation-1', reason: 'interrupted' }),
    );
    expect(finalizeCancellation).toHaveBeenCalledWith('run-1');
  });
});
