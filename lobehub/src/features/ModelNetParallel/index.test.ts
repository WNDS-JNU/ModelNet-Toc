import { type AiModelForSelect } from 'model-bank';
import { describe, expect, it } from 'vitest';

import {
  type AiProviderRuntimeConfig,
  AiProviderSourceEnum,
  type EnabledProviderWithModels,
} from '@/types/aiProvider';

import {
  createModelNetUserProviderAlias,
  getModelNetUserProviderCandidates,
  getModelNetParallelCandidates,
  getModelNetParallelProvider,
  isModelNetParallelModel,
  isModelNetSerialModel,
  modelIdsToModelNetSerialTopology,
  MODELNET_PARALLEL_MODEL_ID,
  MODELNET_SERIAL_MODEL_ID,
  normalizeModelNetParallelModelIds,
  normalizeModelNetSerialTopology,
  parseModelNetUserProviderAlias,
  withModelNetParallelModel,
} from './index';

const model = (id: string, displayName?: string): AiModelForSelect => ({
  abilities: {},
  displayName,
  id,
});

const provider = (
  id: string,
  children: AiModelForSelect[],
  source: EnabledProviderWithModels['source'] = AiProviderSourceEnum.Builtin,
): EnabledProviderWithModels => ({
  children,
  id,
  name: id,
  source,
});

const runtimeConfig = (
  sdkType: string,
  overrides: Partial<AiProviderRuntimeConfig> = {},
): AiProviderRuntimeConfig =>
  ({
    config: {},
    keyVaults: {},
    settings: { sdkType },
    ...overrides,
  }) as AiProviderRuntimeConfig;

describe('ModelNetParallel helpers', () => {
  it('injects the parallel pseudo model under the OpenAI provider that hosts ModelNet aliases', () => {
    const enabledList = [
      provider('openai', [
        model('gpt-4o', 'GPT-4o'),
        model('modelnet', 'ModelNet/ModelNet'),
        model('modelnet-auto', 'ModelNet/Auto Network'),
        model('inference-qwen3', 'ModelNet/Qwen3'),
        model('inference-deepseek', 'ModelNet/DeepSeek'),
      ]),
    ];

    const result = withModelNetParallelModel(enabledList);
    const openai = result.find((item) => item.id === 'openai');

    expect(openai?.children.map((item) => item.id)).toEqual([
      MODELNET_PARALLEL_MODEL_ID,
      MODELNET_SERIAL_MODEL_ID,
      'gpt-4o',
      'modelnet',
      'modelnet-auto',
      'inference-qwen3',
      'inference-deepseek',
    ]);
    expect(getModelNetParallelCandidates(result, 'openai').map((item) => item.id)).toEqual([
      'inference-qwen3',
      'inference-deepseek',
    ]);
  });

  it('does not inject the pseudo model when fewer than two ModelNet member models are available', () => {
    const result = withModelNetParallelModel([
      provider('openai', [model('gpt-4o', 'GPT-4o'), model('inference-qwen3', 'ModelNet/Qwen3')]),
    ]);

    expect(result[0].children.map((item) => item.id)).toEqual(['gpt-4o', 'inference-qwen3']);
  });

  it('normalizes selected models up to the current candidate count', () => {
    const candidates = Array.from({ length: 17 }, (_, index) =>
      model(`inference-model-${index + 1}`, `ModelNet/Model ${index + 1}`),
    );
    const parallelIds = candidates.map((item) => item.id);

    expect(normalizeModelNetParallelModelIds(parallelIds, candidates)).toEqual(parallelIds);

    const serialCandidates = candidates.slice(0, 10);
    const serialIds = serialCandidates.map((item) => item.id);
    const topology = normalizeModelNetSerialTopology(
      modelIdsToModelNetSerialTopology(serialIds),
      serialCandidates,
    );

    expect(topology.nodes.map((node) => node.modelId)).toEqual(serialIds);
  });

  it('keeps legacy lobehub provider compatibility but prefers OpenAI when both exist', () => {
    const enabledList = [
      provider('lobehub', [
        model('legacy-a', 'Legacy A'),
        model('legacy-b', 'Legacy B'),
        model('modelnet', 'ModelNet'),
      ]),
      provider('openai', [
        model('inference-qwen3', 'ModelNet/Qwen3'),
        model('inference-deepseek', 'ModelNet/DeepSeek'),
      ]),
    ];

    expect(getModelNetParallelProvider(enabledList)?.id).toBe('openai');
    expect(getModelNetParallelCandidates(enabledList, 'lobehub').map((item) => item.id)).toEqual([
      'legacy-a',
      'legacy-b',
    ]);
    expect(isModelNetParallelModel('openai', MODELNET_PARALLEL_MODEL_ID)).toBe(true);
    expect(isModelNetParallelModel('lobehub', MODELNET_PARALLEL_MODEL_ID)).toBe(true);
    expect(isModelNetParallelModel('anthropic', MODELNET_PARALLEL_MODEL_ID)).toBe(false);
    expect(isModelNetSerialModel('openai', MODELNET_SERIAL_MODEL_ID)).toBe(true);
    expect(isModelNetSerialModel('lobehub', MODELNET_SERIAL_MODEL_ID)).toBe(true);
    expect(isModelNetSerialModel('anthropic', MODELNET_SERIAL_MODEL_ID)).toBe(false);
  });

  it('includes custom OpenAI-compatible providers as ModelNet runtime candidates', () => {
    const customAlias = createModelNetUserProviderAlias('user-openai', 'user/model-a');
    const enabledList = [
      provider('openai', [model('inference-qwen3', 'ModelNet/Qwen3')]),
      provider('user-openai', [model('user/model-a', 'User Model A')], AiProviderSourceEnum.Custom),
      provider('user-ollama', [model('ollama-a', 'Ollama A')], AiProviderSourceEnum.Custom),
    ];
    const configs = {
      'user-openai': runtimeConfig('openai', {
        keyVaults: { apiKey: 'user-secret', baseURL: 'https://user.example.com/v1' },
      }),
      'user-ollama': runtimeConfig('ollama'),
    };

    const result = withModelNetParallelModel(enabledList, configs);
    const openai = result.find((item) => item.id === 'openai');

    expect(openai?.children.map((item) => item.id).slice(0, 3)).toEqual([
      MODELNET_PARALLEL_MODEL_ID,
      MODELNET_SERIAL_MODEL_ID,
      'inference-qwen3',
    ]);
    expect(getModelNetParallelCandidates(result, 'openai', configs).map((item) => item.id)).toEqual(
      ['inference-qwen3', customAlias],
    );
    expect(parseModelNetUserProviderAlias(customAlias)).toEqual({
      modelId: 'user/model-a',
      providerId: 'user-openai',
    });
  });

  it('includes keyed built-in DeepSeek models as ModelNet runtime candidates', () => {
    const deepseekAlias = createModelNetUserProviderAlias('deepseek', 'deepseek-v4-flash');
    const enabledList = [
      provider('openai', [model('inference-qwen3', 'ModelNet/Qwen3')]),
      provider('deepseek', [model('deepseek-v4-flash', 'DeepSeek V4 Flash')]),
    ];
    const configs = {
      deepseek: runtimeConfig('openai', { keyVaults: { apiKey: 'deepseek-secret' } }),
    };

    expect(getModelNetUserProviderCandidates(enabledList, configs).map((item) => item.id)).toEqual([
      deepseekAlias,
    ]);
    expect(
      getModelNetParallelCandidates(enabledList, 'openai', configs).map((item) => item.id),
    ).toEqual(['inference-qwen3', deepseekAlias]);
    expect(
      withModelNetParallelModel(enabledList, configs)[0].children.map((item) => item.id),
    ).toEqual([MODELNET_PARALLEL_MODEL_ID, MODELNET_SERIAL_MODEL_ID, 'inference-qwen3']);
  });
});
