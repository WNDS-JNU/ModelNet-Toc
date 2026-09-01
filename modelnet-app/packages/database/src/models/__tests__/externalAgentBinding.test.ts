// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { agents, externalAgentBindings, users, workspaces } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { ExternalAgentBindingModel } from '../externalAgentBinding';

const serverDB: LobeChatDatabase = await getTestDB();

const ownerId = 'external-binding-owner';
const collaboratorId = 'external-binding-collaborator';
const workspaceId = 'external-binding-workspace';
const personalAgentId = 'external-binding-personal-agent';
const workspaceAgentId = 'external-binding-workspace-agent';
const trustPolicy = {
  allowedOrigin: 'https://agent.example.com',
  allowInsecureHttp: false,
  allowPrivateNetwork: false,
  maxResponseBytes: 1024,
  requestTimeoutMs: 1000,
};

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values([{ id: ownerId }, { id: collaboratorId }]);
  await serverDB.insert(workspaces).values({
    id: workspaceId,
    name: 'External binding workspace',
    primaryOwnerId: ownerId,
    slug: workspaceId,
  });
  await serverDB.insert(agents).values([
    { id: personalAgentId, title: 'Personal external Agent', userId: ownerId },
    {
      id: workspaceAgentId,
      title: 'Workspace external Agent',
      userId: ownerId,
      workspaceId,
    },
  ]);
});

const upsert = (model: ExternalAgentBindingModel, agentId: string, interactionMode = 'stream') =>
  model.upsert({
    agentId,
    authScheme: 'none',
    endpointUrl: 'https://agent.example.com/a2a/',
    interactionMode: interactionMode as 'poll' | 'stream',
    trustPolicy,
  });

describe('ExternalAgentBindingModel ownership', () => {
  it('keeps personal bindings private to their owner', async () => {
    await upsert(new ExternalAgentBindingModel(serverDB, ownerId), personalAgentId);

    await expect(
      new ExternalAgentBindingModel(serverDB, collaboratorId).findByAgentId(personalAgentId),
    ).resolves.toBeUndefined();
  });

  it('shares one workspace binding across authorized workspace callers', async () => {
    const ownerModel = new ExternalAgentBindingModel(serverDB, ownerId, workspaceId);
    const collaboratorModel = new ExternalAgentBindingModel(serverDB, collaboratorId, workspaceId);
    await upsert(ownerModel, workspaceAgentId);

    await expect(collaboratorModel.findEnabledByAgentId(workspaceAgentId)).resolves.toMatchObject({
      agentId: workspaceAgentId,
      interactionMode: 'stream',
      workspaceId,
    });

    await upsert(collaboratorModel, workspaceAgentId, 'poll');
    await expect(ownerModel.findByAgentId(workspaceAgentId)).resolves.toMatchObject({
      interactionMode: 'poll',
      userId: collaboratorId,
      workspaceId,
    });
    await expect(serverDB.select().from(externalAgentBindings)).resolves.toHaveLength(1);
  });
});
