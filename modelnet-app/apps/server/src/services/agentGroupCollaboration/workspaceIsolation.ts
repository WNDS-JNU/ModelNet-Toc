import { createHash } from 'node:crypto';

import type {
  AgentGroupRunAttemptOutputSnapshot,
  AgentGroupRunExecutionPolicySnapshot,
  DeviceGitWorkingTreePatch,
  VerifyCheckItem,
} from '@lobechat/types';
import { deriveWorktreePath } from '@lobechat/types';

import { WorkModel } from '@/database/models/work';
import { VerifyRunModel } from '@/database/models/verifyRun';
import type { LobeChatDatabase } from '@/database/type';
import type { GroupMemberPreparedOperation } from '@/server/services/agentRuntime/types';
import { deviceGateway } from '@/server/services/deviceGateway';

const MAX_PATCH_FILES = 100;
const MAX_PATCH_CONTENT_CHARS = 200_000;

export interface AgentGroupWorkspaceIsolationSnapshot {
  baseCommit?: string;
  baseRef?: string;
  branch?: string;
  cleanupState: 'not_applicable' | 'retained_for_review';
  deviceId?: string;
  isolationId: string;
  mode: 'integrator' | 'isolated_write' | 'read_only';
  publicationPolicy: 'explicit_user_authorization_required';
  sourcePath?: string;
  worktreePath?: string;
}

export interface PreparedAgentGroupExecution {
  permissionProfile?: 'read-only' | 'workspace-write';
  verifyRunId?: string;
  workingDirectoryOverride?: string;
  workspace?: AgentGroupWorkspaceIsolationSnapshot;
}

const stableToken = (value: string, length = 24): string =>
  createHash('sha256').update(value).digest('hex').slice(0, length);

const stableUuid = (value: string): string => {
  const hex = stableToken(value, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8).join(''),
    hex.slice(8, 12).join(''),
    hex.slice(12, 16).join(''),
    hex.slice(16, 20).join(''),
    hex.slice(20, 32).join(''),
  ].join('-');
};

const normalizePath = (value: string): string => value.replaceAll('\\', '/').replace(/\/$/, '');

const flattenPatches = (
  patches: DeviceGitWorkingTreePatch[],
  submodules: { patches: DeviceGitWorkingTreePatch[]; relativePath: string }[] | undefined,
): DeviceGitWorkingTreePatch[] => [
  ...patches,
  ...(submodules ?? []).flatMap((submodule) =>
    submodule.patches.map((patch) => ({
      ...patch,
      filePath: `${submodule.relativePath}/${patch.filePath}`,
    })),
  ),
];

const renderPatchBundle = (
  snapshot: AgentGroupWorkspaceIsolationSnapshot,
  patches: DeviceGitWorkingTreePatch[],
): string => {
  const header = [
    `# Agent Group code patch`,
    `isolation: ${snapshot.isolationId}`,
    `branch: ${snapshot.branch ?? 'n/a'}`,
    `base: ${snapshot.baseCommit ?? snapshot.baseRef ?? 'n/a'}`,
    '',
  ].join('\n');
  const body = patches
    .slice(0, MAX_PATCH_FILES)
    .map((patch) => {
      const detail = patch.patch || (patch.isBinary ? '[binary diff]' : '[patch truncated]');
      return [
        `## ${patch.status} ${patch.filePath}`,
        `+${patch.additions} -${patch.deletions}`,
        detail,
      ].join('\n');
    })
    .join('\n\n');
  return `${header}${body}`.slice(0, MAX_PATCH_CONTENT_CHARS);
};

/**
 * Pre-dispatch and completion boundary for code collaboration Attempts.
 *
 * It only composes existing Device Gateway, Work and Verify facts. It never
 * commits, pushes, opens a PR, merges or deploys; the isolated worktree is
 * retained for explicit human review.
 */
export class WorkspaceIsolationService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
    private readonly workspaceId?: string,
  ) {}

  prepareAttempt = async (params: {
    attemptNo: number;
    executionPolicy?: AgentGroupRunExecutionPolicySnapshot | null;
    prepared: GroupMemberPreparedOperation;
    runId: string;
    runNodeId: string;
  }): Promise<PreparedAgentGroupExecution> => {
    const { executionPolicy, prepared } = params;
    const verifyRunId = executionPolicy?.verification?.requirement
      ? await this.prepareVerifyRun(
          prepared.operationId,
          params.runId,
          params.runNodeId,
          params.attemptNo,
          executionPolicy.verification.requirement,
        )
      : undefined;
    const mode = executionPolicy?.codeMode;
    if (!mode) return { verifyRunId };

    const isolationId = `agw_${stableToken(
      `${params.runId}:${params.runNodeId}:${params.attemptNo}`,
    )}`;
    if (mode === 'read_only') {
      return {
        permissionProfile: 'read-only',
        verifyRunId,
        workspace: {
          cleanupState: 'not_applicable',
          isolationId,
          mode,
          publicationPolicy: 'explicit_user_authorization_required',
        },
      };
    }

    const plan = prepared.executionPlan;
    const deviceId = executionPolicy.deviceId;
    const sourcePath = executionPolicy.workingDirectory;
    if (
      prepared.runtimeKind !== 'heterogeneous' ||
      plan?.kind !== 'device' ||
      !deviceId ||
      plan.deviceId !== deviceId ||
      !sourcePath
    ) {
      throw new Error(
        'Isolated code writes require the approved heterogeneous device and repository path.',
      );
    }

    const branch = `codex/ag-${stableToken(isolationId, 20)}`;
    const worktreePath = deriveWorktreePath(sourcePath, branch);
    const worktrees =
      (await deviceGateway.listGitWorktrees({
        deviceId,
        path: sourcePath,
        userId: this.userId,
        workspaceId: this.workspaceId,
      })) ?? [];
    const source = worktrees.find((item) => normalizePath(item.path) === normalizePath(sourcePath));
    const existing = worktrees.find(
      (item) => normalizePath(item.path) === normalizePath(worktreePath),
    );
    if (!source?.head) {
      throw new Error('Unable to resolve the approved repository Git baseline.');
    }
    if (existing && existing.head !== source.head) {
      throw new Error(
        'The retained isolated worktree no longer matches the approved Git baseline.',
      );
    }
    if (!existing) {
      const created = await deviceGateway.addGitWorktree({
        branch,
        deviceId,
        path: sourcePath,
        userId: this.userId,
        workspaceId: this.workspaceId,
        worktreePath,
      });
      if (!created.success) {
        const replay =
          (await deviceGateway.listGitWorktrees({
            deviceId,
            path: sourcePath,
            userId: this.userId,
            workspaceId: this.workspaceId,
          })) ?? [];
        if (!replay.some((item) => normalizePath(item.path) === normalizePath(worktreePath))) {
          throw new Error(created.error || 'Failed to create isolated code worktree.');
        }
      }
    }
    const confirmed =
      existing ??
      (
        (await deviceGateway.listGitWorktrees({
          deviceId,
          path: sourcePath,
          userId: this.userId,
          workspaceId: this.workspaceId,
        })) ?? []
      ).find((item) => normalizePath(item.path) === normalizePath(worktreePath));
    if (!confirmed) throw new Error('Failed to confirm the isolated code worktree.');
    if (confirmed.head !== source.head) {
      throw new Error('The isolated worktree does not match the approved Git baseline.');
    }

    const workspace: AgentGroupWorkspaceIsolationSnapshot = {
      baseCommit: source.head,
      baseRef: executionPolicy.baseRef,
      branch,
      cleanupState: 'retained_for_review',
      deviceId,
      isolationId,
      mode,
      publicationPolicy: 'explicit_user_authorization_required',
      sourcePath,
      worktreePath,
    };
    return {
      permissionProfile: 'workspace-write',
      verifyRunId,
      workingDirectoryOverride: worktreePath,
      workspace,
    };
  };

  captureAttempt = async (params: {
    agentId?: string | null;
    attemptNo: number;
    operationId: string;
    runId: string;
    runNodeId: string;
    topicId?: string | null;
    workspace?: AgentGroupWorkspaceIsolationSnapshot;
  }): Promise<AgentGroupRunAttemptOutputSnapshot['workspace'] | undefined> => {
    const snapshot = params.workspace;
    if (!snapshot) return undefined;
    if (snapshot.mode === 'read_only') {
      return {
        additions: 0,
        changedFiles: 0,
        cleanupState: 'not_applicable',
        deletions: 0,
        isolationId: snapshot.isolationId,
        mode: snapshot.mode,
      };
    }
    if (!snapshot.deviceId || !snapshot.sourcePath || !snapshot.worktreePath) {
      throw new Error('Isolated workspace snapshot is incomplete.');
    }

    const worktrees =
      (await deviceGateway.listGitWorktrees({
        deviceId: snapshot.deviceId,
        path: snapshot.sourcePath,
        userId: this.userId,
        workspaceId: this.workspaceId,
      })) ?? [];
    const current = worktrees.find(
      (item) => normalizePath(item.path) === normalizePath(snapshot.worktreePath!),
    );
    if (!current) throw new Error('Isolated code worktree disappeared before capture.');
    if (!snapshot.baseCommit || !current.head) {
      throw new Error('Unable to verify the isolated worktree Git baseline.');
    }
    if (snapshot.baseCommit !== current.head) {
      throw new Error(
        'The isolated node created a Git commit without explicit user authorization.',
      );
    }

    const result = await deviceGateway.getGitWorkingTreePatches({
      deviceId: snapshot.deviceId,
      path: snapshot.worktreePath,
      userId: this.userId,
      workspaceId: this.workspaceId,
    });
    if (!result) throw new Error('Unable to capture the isolated code patch.');
    const patches = flattenPatches(result.patches, result.submodules);
    const additions = patches.reduce((sum, patch) => sum + patch.additions, 0);
    const deletions = patches.reduce((sum, patch) => sum + patch.deletions, 0);

    if (patches.length > 0) {
      await new WorkModel(this.db, this.userId, this.workspaceId).registerExternal({
        agentId: params.agentId,
        changeType: params.attemptNo === 1 ? 'created' : 'updated',
        content: renderPatchBundle(snapshot, patches),
        description: `${patches.length} changed files (+${additions} -${deletions})`,
        identifier: snapshot.branch,
        patchFields: ['content', 'description', 'identifier', 'status', 'title'],
        resourceId: `${params.runId}:${params.runNodeId}`,
        resourceType: 'code_patch',
        rootOperationId: params.operationId,
        status: 'pending_review',
        title: `Agent Group patch: ${snapshot.branch}`,
        toolCallId: `agent-group:${params.runNodeId}:${params.attemptNo}`,
        toolIdentifier: 'agent-group-code',
        toolName: 'captureIsolatedPatch',
        topicId: params.topicId,
      });
    }

    return {
      additions,
      baseRef: snapshot.baseCommit ?? snapshot.baseRef,
      branch: snapshot.branch,
      changedFiles: patches.length,
      cleanupState: 'retained_for_review',
      deletions,
      isolationId: snapshot.isolationId,
      mode: snapshot.mode,
      worktreePath: snapshot.worktreePath,
    };
  };

  private prepareVerifyRun = async (
    operationId: string,
    runId: string,
    runNodeId: string,
    attemptNo: number,
    requirement: string,
  ): Promise<string> => {
    const model = new VerifyRunModel(this.db, this.userId, this.workspaceId);
    const run = await model.ensureForOperation(operationId, {
      goal: requirement,
      title: `Agent Group node verification`,
    });
    if (!run.plan?.length) {
      const item: VerifyCheckItem = {
        description: requirement,
        id: stableUuid(`${runId}:${runNodeId}:${attemptNo}:verify`),
        index: 0,
        onFail: 'manual',
        required: true,
        title: requirement.slice(0, 160),
        verifierConfig: {
          expected: requirement,
          method: 'Judge the immutable Attempt deliverable and its recorded evidence.',
        },
        verifierType: 'llm',
      };
      await model.setPlan(run.id, [item]);
      await model.confirmPlan(run.id);
    }
    return run.id;
  };
}
