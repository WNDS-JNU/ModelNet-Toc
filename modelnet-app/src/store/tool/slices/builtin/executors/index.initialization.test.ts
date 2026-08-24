import { AgentBuilderApiName, AgentBuilderIdentifier } from '@lobechat/builtin-tool-agent-builder';
import {
  AgentManagementApiName,
  AgentManagementIdentifier,
} from '@lobechat/builtin-tool-agent-management';
import {
  GroupAgentBuilderApiName,
  GroupAgentBuilderIdentifier,
} from '@lobechat/builtin-tool-group-agent-builder';
import { describe, expect, it, vi } from 'vitest';

import { invokeExecutor, registerBuiltinToolExecutors } from './index';

const { constructorSpy, createAgentSpy, getAvailableModelsSpy } = vi.hoisted(() => ({
  constructorSpy: vi.fn(),
  createAgentSpy: vi.fn().mockResolvedValue({ content: 'agent-ok', success: true }),
  getAvailableModelsSpy: vi.fn().mockResolvedValue({ content: 'models-ok', success: true }),
}));

vi.hoisted(() => {
  const storage = new Map<string, string>();

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
  });
});

vi.mock('@lobechat/agent-manager-runtime', () => ({
  AgentManagerRuntime: class {
    constructor() {
      constructorSpy();
    }

    createAgent = createAgentSpy;
    getAvailableModels = getAvailableModelsSpy;
  },
}));

describe('builtin executor runtime initialization', () => {
  it('constructs AgentManagerRuntime lazily and reuses it', async () => {
    expect(constructorSpy).not.toHaveBeenCalled();

    registerBuiltinToolExecutors();

    expect(constructorSpy).not.toHaveBeenCalled();

    const context = { messageId: 'test-message-id' };

    await invokeExecutor(
      AgentBuilderIdentifier,
      AgentBuilderApiName.getAvailableModels,
      {},
      context,
    );

    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(getAvailableModelsSpy).toHaveBeenCalledTimes(1);

    await invokeExecutor(
      AgentBuilderIdentifier,
      AgentBuilderApiName.getAvailableModels,
      {},
      context,
    );

    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(getAvailableModelsSpy).toHaveBeenCalledTimes(2);

    await invokeExecutor(
      GroupAgentBuilderIdentifier,
      GroupAgentBuilderApiName.getAvailableModels,
      {},
      context,
    );

    expect(constructorSpy).toHaveBeenCalledTimes(2);
    expect(getAvailableModelsSpy).toHaveBeenCalledTimes(3);

    await invokeExecutor(
      GroupAgentBuilderIdentifier,
      GroupAgentBuilderApiName.getAvailableModels,
      {},
      context,
    );

    expect(constructorSpy).toHaveBeenCalledTimes(2);
    expect(getAvailableModelsSpy).toHaveBeenCalledTimes(4);

    await invokeExecutor(
      AgentManagementIdentifier,
      AgentManagementApiName.createAgent,
      { title: 'Test agent' },
      context,
    );

    expect(constructorSpy).toHaveBeenCalledTimes(3);
    expect(createAgentSpy).toHaveBeenCalledTimes(1);

    await invokeExecutor(
      AgentManagementIdentifier,
      AgentManagementApiName.createAgent,
      { title: 'Test agent' },
      context,
    );

    expect(constructorSpy).toHaveBeenCalledTimes(3);
    expect(createAgentSpy).toHaveBeenCalledTimes(2);
  });
});
