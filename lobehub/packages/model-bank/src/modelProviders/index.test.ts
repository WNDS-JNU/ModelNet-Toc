import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type ModelProviderCard } from '@/types/llm';

import { ModelProvider } from '../const/modelProvider';
import { DEFAULT_MODEL_PROVIDER_LIST, isProviderDisableBrowserRequest } from './index';

describe('DEFAULT_MODEL_PROVIDER_LIST', () => {
  it('registers ModelNet as a first-class provider', () => {
    const modelnet = DEFAULT_MODEL_PROVIDER_LIST.find((item) => item.id === ModelProvider.ModelNet);

    expect(modelnet).toMatchObject({
      checkModel: 'modelnet-auto',
      enabled: true,
      id: ModelProvider.ModelNet,
      name: 'ModelNet',
    });
    expect(modelnet?.settings).toMatchObject({
      sdkType: 'openai',
      showModelFetcher: true,
    });
    expect(modelnet?.chatModels.map((model) => model.id)).toEqual([
      'modelnet',
      'modelnet-auto',
      'inference-qwen-qwen3-5-35b-a3b-gptq-int4',
    ]);
  });
});

describe('isProviderDisableBrowserRequest', () => {
  const originalProviders = [...DEFAULT_MODEL_PROVIDER_LIST];

  const createProvider = (overrides: Partial<ModelProviderCard>): ModelProviderCard => ({
    chatModels: [],
    id: 'test-provider',
    name: 'Test Provider',
    settings: {},
    url: 'https://example.com',
    ...overrides,
  });

  beforeEach(() => {
    DEFAULT_MODEL_PROVIDER_LIST.length = 0;
    DEFAULT_MODEL_PROVIDER_LIST.push(
      createProvider({ id: 'root-disabled', disableBrowserRequest: true }),
      createProvider({ id: 'settings-disabled', settings: { disableBrowserRequest: true } }),
      createProvider({ id: 'enabled-provider' }),
    );
  });

  afterEach(() => {
    DEFAULT_MODEL_PROVIDER_LIST.length = 0;
    DEFAULT_MODEL_PROVIDER_LIST.push(...originalProviders);
  });

  it('returns true for providers with root-level disableBrowserRequest', () => {
    expect(isProviderDisableBrowserRequest('root-disabled')).toBe(true);
  });

  it('returns true for providers with settings.disableBrowserRequest', () => {
    expect(isProviderDisableBrowserRequest('settings-disabled')).toBe(true);
  });

  it('returns false for providers without disableBrowserRequest', () => {
    expect(isProviderDisableBrowserRequest('enabled-provider')).toBe(false);
  });

  it('returns false for unknown provider id', () => {
    expect(isProviderDisableBrowserRequest('not-exists')).toBe(false);
  });
});
