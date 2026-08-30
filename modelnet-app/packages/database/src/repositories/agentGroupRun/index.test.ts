// @vitest-environment node
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { getTestDB } from '../../core/getTestDB';
import { agents, chatGroups, chatGroupsAgents, users, workspaces } from '../../schemas';
import { AgentGroupRunRepository } from '.';

const ownerId = 'agent-group-run-repository-owner';
const memberId = 'agent-group-run-repository-member';
const workspaceId = 'agent-group-run-repository-workspace';
const groupId = 'agent-group-run-repository-group';

const serverDB: LobeChatDatabase = await getTestDB();

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values([{ id: ownerId }, { id: memberId }]);
  await serverDB.insert(workspaces).values({
    id: workspaceId,
    name: 'Agent Group Run Repository Workspace',
    primaryOwnerId: ownerId,
    slug: workspaceId,
  });
  await serverDB.insert(agents).values([
    { id: 'repository-supervisor', title: 'Supervisor', userId: ownerId, workspaceId },
    { id: 'repository-member', title: 'Member', userId: ownerId, workspaceId },
    { id: 'repository-disabled', title: 'Disabled', userId: ownerId, workspaceId },
  ]);
  await serverDB.insert(chatGroups).values({
    id: groupId,
    title: 'Repository Group',
    userId: ownerId,
    visibility: 'public',
    workspaceId,
  });
  await serverDB.insert(chatGroupsAgents).values([
    {
      agentId: 'repository-supervisor',
      chatGroupId: groupId,
      order: 0,
      role: 'supervisor',
      userId: ownerId,
      workspaceId,
    },
    {
      agentId: 'repository-member',
      chatGroupId: groupId,
      order: 1,
      role: 'participant',
      userId: ownerId,
      workspaceId,
    },
    {
      agentId: 'repository-disabled',
      chatGroupId: groupId,
      enabled: false,
      order: 2,
      role: 'participant',
      userId: ownerId,
      workspaceId,
    },
  ]);
});

describe('AgentGroupRunRepository', () => {
  it('returns only an accessible group and its enabled visible roster', async () => {
    const repository = new AgentGroupRunRepository(serverDB, memberId, workspaceId);

    const context = await repository.getExecutionContext(groupId);

    expect(context?.group.id).toBe(groupId);
    expect(context?.roster.map((item) => item.agentId)).toEqual([
      'repository-supervisor',
      'repository-member',
    ]);

    await serverDB
      .update(chatGroups)
      .set({ visibility: 'private' })
      .where(eq(chatGroups.id, groupId));

    expect(await repository.getExecutionContext(groupId)).toBeUndefined();
  });
});
