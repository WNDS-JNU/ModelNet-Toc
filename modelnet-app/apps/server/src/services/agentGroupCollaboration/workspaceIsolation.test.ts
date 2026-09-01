// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addGitWorktree,
  confirmVerifyPlan,
  ensureVerifyRun,
  getGitWorkingTreePatches,
  listGitWorktrees,
  registerExternalWork,
  setVerifyPlan,
} = vi.hoisted(() => ({
  addGitWorktree: vi.fn(),
  confirmVerifyPlan: vi.fn(),
  ensureVerifyRun: vi.fn(),
  getGitWorkingTreePatches: vi.fn(),
  listGitWorktrees: vi.fn(),
  registerExternalWork: vi.fn(),
  setVerifyPlan: vi.fn(),
}));

vi.mock('@/server/services/deviceGateway', () => ({
  deviceGateway: {
    addGitWorktree,
    getGitWorkingTreePatches,
    listGitWorktrees,
  },
}));

vi.mock('@/database/models/work', () => ({
  WorkModel: class {
    registerExternal = registerExternalWork;
  },
}));

vi.mock('@/database/models/verifyRun', () => ({
  VerifyRunModel: class {
    confirmPlan = confirmVerifyPlan;
    ensureForOperation = ensureVerifyRun;
    setPlan = setVerifyPlan;
  },
}));

import { WorkspaceIsolationService } from './workspaceIsolation';

const prepared = {
  executionPlan: { deviceId: 'device-1', kind: 'device', target: 'device' },
  operationId: 'operation-1',
  runtimeKind: 'heterogeneous',
  threadId: 'thread-1',
} as const;

describe('WorkspaceIsolationService', () => {
  beforeEach(() => {
    addGitWorktree.mockReset().mockResolvedValue({ success: true });
    confirmVerifyPlan.mockReset().mockResolvedValue(undefined);
    ensureVerifyRun.mockReset().mockResolvedValue({ id: 'verify-1', plan: [] });
    getGitWorkingTreePatches.mockReset().mockResolvedValue({ patches: [], submodules: [] });
    listGitWorktrees.mockReset().mockResolvedValue([{ head: 'base-head', path: '/repo/main' }]);
    registerExternalWork.mockReset().mockResolvedValue(undefined);
    setVerifyPlan.mockReset().mockResolvedValue(undefined);
  });

  it('enforces read-only execution and prepares the immutable VerifyRun', async () => {
    const service = new WorkspaceIsolationService({} as any, 'user-1');
    const result = await service.prepareAttempt({
      attemptNo: 1,
      executionPolicy: {
        codeMode: 'read_only',
        runtimeKind: 'heterogeneous',
        verification: { requirement: 'Review the implementation' },
      },
      prepared,
      runId: 'run-1',
      runNodeId: 'node-1',
    });

    expect(result).toMatchObject({
      permissionProfile: 'read-only',
      verifyRunId: 'verify-1',
      workspace: {
        cleanupState: 'not_applicable',
        mode: 'read_only',
        publicationPolicy: 'explicit_user_authorization_required',
      },
    });
    expect(setVerifyPlan).toHaveBeenCalledWith(
      'verify-1',
      expect.arrayContaining([
        expect.objectContaining({
          onFail: 'manual',
          required: true,
          verifierType: 'llm',
        }),
      ]),
    );
    expect(confirmVerifyPlan).toHaveBeenCalledWith('verify-1');
    expect(addGitWorktree).not.toHaveBeenCalled();
  });

  it('creates an isolated worktree and records its patch as a reviewable WorkVersion', async () => {
    listGitWorktrees
      .mockResolvedValueOnce([{ head: 'base-head', path: '/repo/main' }])
      .mockImplementationOnce(async () => {
        const worktreePath = addGitWorktree.mock.calls[0]?.[0]?.worktreePath;
        return [
          { head: 'base-head', path: '/repo/main' },
          { head: 'base-head', path: worktreePath },
        ];
      });
    const service = new WorkspaceIsolationService({} as any, 'user-1', 'workspace-1');
    const execution = await service.prepareAttempt({
      attemptNo: 1,
      executionPolicy: {
        codeMode: 'isolated_write',
        deviceId: 'device-1',
        executionTarget: 'device',
        runtimeKind: 'heterogeneous',
        verification: { requirement: 'Tests pass' },
        workingDirectory: '/repo/main',
      },
      prepared,
      runId: 'run-1',
      runNodeId: 'node-1',
    });

    expect(execution).toMatchObject({
      permissionProfile: 'workspace-write',
      verifyRunId: 'verify-1',
      workspace: {
        baseCommit: 'base-head',
        cleanupState: 'retained_for_review',
        deviceId: 'device-1',
        mode: 'isolated_write',
      },
    });
    expect(addGitWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        path: '/repo/main',
        worktreePath: execution.workingDirectoryOverride,
      }),
    );

    listGitWorktrees.mockResolvedValue([
      {
        head: 'base-head',
        path: execution.workingDirectoryOverride,
      },
    ]);
    getGitWorkingTreePatches.mockResolvedValue({
      patches: [
        {
          additions: 4,
          deletions: 1,
          filePath: 'src/change.ts',
          isBinary: false,
          patch: '@@ -1 +1 @@',
          status: 'modified',
        },
      ],
      submodules: [],
    });

    const output = await service.captureAttempt({
      agentId: 'agent-1',
      attemptNo: 1,
      operationId: 'operation-1',
      runId: 'run-1',
      runNodeId: 'node-1',
      topicId: 'topic-1',
      workspace: execution.workspace,
    });

    expect(output).toMatchObject({
      additions: 4,
      changedFiles: 1,
      cleanupState: 'retained_for_review',
      deletions: 1,
      mode: 'isolated_write',
    });
    expect(registerExternalWork).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'code_patch',
        rootOperationId: 'operation-1',
        status: 'pending_review',
        topicId: 'topic-1',
      }),
    );
  });

  it('rejects code writes when the approved Git baseline cannot be resolved', async () => {
    const service = new WorkspaceIsolationService({} as any, 'user-1');
    listGitWorktrees.mockResolvedValue([{ path: '/repo/main' }]);

    await expect(
      service.prepareAttempt({
        attemptNo: 1,
        executionPolicy: {
          codeMode: 'isolated_write',
          deviceId: 'device-1',
          executionTarget: 'device',
          runtimeKind: 'heterogeneous',
          workingDirectory: '/repo/main',
        },
        prepared,
        runId: 'run-1',
        runNodeId: 'node-1',
      }),
    ).rejects.toThrow('Unable to resolve the approved repository Git baseline');
    expect(addGitWorktree).not.toHaveBeenCalled();
  });

  it('rejects an isolated workspace that created an unauthorized commit', async () => {
    const service = new WorkspaceIsolationService({} as any, 'user-1');
    const workspace = {
      baseCommit: 'base-head',
      branch: 'codex/ag-test',
      cleanupState: 'retained_for_review',
      deviceId: 'device-1',
      isolationId: 'agw_test',
      mode: 'integrator',
      publicationPolicy: 'explicit_user_authorization_required',
      sourcePath: '/repo/main',
      worktreePath: '/repo/worktree',
    } as const;
    listGitWorktrees.mockResolvedValue([{ head: 'new-commit', path: '/repo/worktree' }]);

    await expect(
      service.captureAttempt({
        attemptNo: 1,
        operationId: 'operation-1',
        runId: 'run-1',
        runNodeId: 'node-1',
        workspace,
      }),
    ).rejects.toThrow('created a Git commit without explicit user authorization');
    expect(getGitWorkingTreePatches).not.toHaveBeenCalled();
    expect(registerExternalWork).not.toHaveBeenCalled();
  });
});
