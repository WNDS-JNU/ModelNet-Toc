// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { agentOperations, agents, chatGroups, chatGroupsAgents, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { AgentGroupCollaborationService } from '.';

const feature = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/envs/app', () => ({
  appEnv: {
    get enableAgentGroupDurableRuns() {
      return feature.enabled;
    },
  },
}));

const userId = 'collaboration-service-user';
const groupId = 'collaboration-service-group';
const supervisorAgentId = 'collaboration-service-supervisor';
const memberAgentId = 'collaboration-service-member';
const supervisorOperationId = 'collaboration-service-supervisor-operation';

const serverDB: LobeChatDatabase = await getTestDB();

beforeEach(async () => {
  feature.enabled = true;
  await serverDB.delete(agentOperations);
  await serverDB.delete(users);
  await serverDB.insert(users).values({ id: userId });
  await serverDB.insert(agents).values([
    { id: supervisorAgentId, title: 'Supervisor', userId },
    { id: memberAgentId, title: 'Member', userId },
  ]);
  await serverDB.insert(chatGroups).values({ id: groupId, title: 'Group', userId });
  await serverDB.insert(chatGroupsAgents).values([
    {
      agentId: supervisorAgentId,
      chatGroupId: groupId,
      order: 0,
      role: 'supervisor',
      userId,
    },
    {
      agentId: memberAgentId,
      chatGroupId: groupId,
      order: 1,
      role: 'participant',
      userId,
    },
  ]);
  await serverDB.insert(agentOperations).values({
    agentId: supervisorAgentId,
    chatGroupId: groupId,
    id: supervisorOperationId,
    status: 'running',
    userId,
  });
});

describe('AgentGroupCollaborationService', () => {
  it('compiles and persists an explicit run from the enabled group roster', async () => {
    const service = new AgentGroupCollaborationService(serverDB, userId);

    const result = await service.createRun({
      chatGroupId: groupId,
      idempotencyKey: 'tool-call-1',
      nodes: [{ agentId: memberAgentId, instruction: 'Investigate', key: 'member-1' }],
      protocol: 'single',
      supervisorAgentId,
      supervisorOperationId,
    });

    expect(result.created).toBe(true);
    expect(result.run).toMatchObject({
      chatGroupId: groupId,
      protocol: 'single',
      supervisorAgentId,
      supervisorOperationId,
    });
    expect(result.nodes[0]).toMatchObject({
      agentId: memberAgentId,
      instruction: 'Investigate',
      nodeKey: 'member-1',
    });
  });

  it('fails closed when durable runs are disabled', async () => {
    feature.enabled = false;
    const service = new AgentGroupCollaborationService(serverDB, userId);

    await expect(
      service.createRun({
        chatGroupId: groupId,
        idempotencyKey: 'tool-call-disabled',
        nodes: [{ agentId: memberAgentId, instruction: 'Investigate', key: 'member-1' }],
        protocol: 'single',
        supervisorAgentId,
        supervisorOperationId,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects a supervisor that is not the enabled supervisor membership', async () => {
    const service = new AgentGroupCollaborationService(serverDB, userId);

    await expect(
      service.createRun({
        chatGroupId: groupId,
        idempotencyKey: 'tool-call-wrong-supervisor',
        nodes: [{ agentId: memberAgentId, instruction: 'Investigate', key: 'member-1' }],
        protocol: 'single',
        supervisorAgentId: memberAgentId,
        supervisorOperationId,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});
