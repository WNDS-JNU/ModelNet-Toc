import { type AiModelForSelect } from 'model-bank';

import {
  type AiProviderRuntimeConfig,
  AiProviderSourceEnum,
  type EnabledProviderWithModels,
} from '@/types/aiProvider';

export const MODELNET_OPENAI_PROVIDER_ID = 'openai';
export const MODELNET_LEGACY_PROVIDER_ID = 'lobehub';
export const MODELNET_PROVIDER_IDS = [
  MODELNET_OPENAI_PROVIDER_ID,
  MODELNET_LEGACY_PROVIDER_ID,
] as const;
export const MODELNET_AUTO_MODEL_ID = 'modelnet-auto';
export const MODELNET_PARALLEL_MODEL_ID = 'modelnet-parallel';
export const MODELNET_PARALLEL_DISPLAY_NAME = 'ModelNet \u5E76\u8054';
export const MIN_MODELNET_PARALLEL_MODELS = 2;
export const MODELNET_SERIAL_MODEL_ID = 'modelnet-serial';
export const MODELNET_SERIAL_DISPLAY_NAME = 'ModelNet \u4E32\u8054';
export const MIN_MODELNET_SERIAL_MODELS = 2;
export const MODELNET_USER_PROVIDER_ALIAS_PREFIX = 'user-provider:';

export type ModelNetProviderRuntimeConfigMap = Record<string, AiProviderRuntimeConfig | undefined>;
export const MODELNET_DEFAULT_PROVIDER_API_BASES: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
};

export interface ModelNetSerialTopology {
  edges: { source: string; target: string }[];
  nodes: { id: string; modelId: string }[];
  version: 'modelnet.serial.v1';
}

export interface ModelNetUserProviderAlias {
  modelId: string;
  providerId: string;
}

const MODELNET_SYSTEM_MODEL_IDS = new Set([
  'modelnet',
  MODELNET_AUTO_MODEL_ID,
  MODELNET_PARALLEL_MODEL_ID,
  MODELNET_SERIAL_MODEL_ID,
]);

export const createModelNetUserProviderAlias = (providerId: string, modelId: string) =>
  `${MODELNET_USER_PROVIDER_ALIAS_PREFIX}${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`;

export const parseModelNetUserProviderAlias = (
  alias: string | undefined,
): ModelNetUserProviderAlias | undefined => {
  if (!alias?.startsWith(MODELNET_USER_PROVIDER_ALIAS_PREFIX)) return undefined;

  const payload = alias.slice(MODELNET_USER_PROVIDER_ALIAS_PREFIX.length);
  const separatorIndex = payload.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= payload.length - 1) return undefined;

  try {
    return {
      providerId: decodeURIComponent(payload.slice(0, separatorIndex)),
      modelId: decodeURIComponent(payload.slice(separatorIndex + 1)),
    };
  } catch {
    return undefined;
  }
};

export const isModelNetUserProviderAlias = (alias: string | undefined) =>
  !!parseModelNetUserProviderAlias(alias);

export const isModelNetParallelModel = (provider?: string, model?: string) =>
  !!provider &&
  MODELNET_PROVIDER_IDS.includes(provider as (typeof MODELNET_PROVIDER_IDS)[number]) &&
  model === MODELNET_PARALLEL_MODEL_ID;

export const isModelNetSerialModel = (provider?: string, model?: string) =>
  !!provider &&
  MODELNET_PROVIDER_IDS.includes(provider as (typeof MODELNET_PROVIDER_IDS)[number]) &&
  model === MODELNET_SERIAL_MODEL_ID;

const isModelNetDisplayName = (displayName?: string) =>
  displayName?.trim().toLowerCase().startsWith('modelnet/') ?? false;

const isLikelyModelNetAlias = (id: string, providerId?: string) => {
  const normalizedId = id.toLowerCase();

  return (
    normalizedId.startsWith('modelnet/') ||
    normalizedId.startsWith('modelnet-') ||
    (providerId === MODELNET_OPENAI_PROVIDER_ID && normalizedId.startsWith('inference-'))
  );
};

export const getModelNetRuntimeProviderInfo = (
  provider: EnabledProviderWithModels,
  runtimeConfig: ModelNetProviderRuntimeConfigMap = {},
) => {
  const config = runtimeConfig[provider.id];
  const sdkType = config?.settings?.sdkType ?? 'openai';
  if (sdkType !== 'openai') return undefined;

  const apiKey = config?.keyVaults?.apiKey?.trim();
  const apiBase =
    config?.keyVaults?.baseURL?.trim() || MODELNET_DEFAULT_PROVIDER_API_BASES[provider.id];
  if (!apiBase) return undefined;

  const isCustom = provider.source === AiProviderSourceEnum.Custom;
  const isKeyedBuiltin = provider.source === AiProviderSourceEnum.Builtin && !!apiKey;
  if (!isCustom && !isKeyedBuiltin) return undefined;

  return {
    apiBase,
    apiKey,
  };
};

export const isModelNetParallelCandidate = (model: AiModelForSelect, providerId?: string) => {
  if (MODELNET_SYSTEM_MODEL_IDS.has(model.id)) return false;
  if (providerId === MODELNET_LEGACY_PROVIDER_ID) return true;

  return isModelNetDisplayName(model.displayName) || isLikelyModelNetAlias(model.id, providerId);
};

export const getModelNetUserProviderCandidates = (
  enabledList: EnabledProviderWithModels[],
  runtimeConfig: ModelNetProviderRuntimeConfigMap = {},
): AiModelForSelect[] =>
  enabledList.flatMap((provider) => {
    if (!getModelNetRuntimeProviderInfo(provider, runtimeConfig)) return [];

    return provider.children
      .filter((model) => !MODELNET_SYSTEM_MODEL_IDS.has(model.id))
      .map((model) => ({
        ...model,
        description: model.description,
        displayName: `${provider.name || provider.id}/${model.displayName || model.id}`,
        id: createModelNetUserProviderAlias(provider.id, model.id),
      }));
  });

const uniqueCandidates = (candidates: AiModelForSelect[]) => {
  const byId = new Map<string, AiModelForSelect>();
  for (const candidate of candidates) {
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  return [...byId.values()];
};

export const getModelNetParallelProvider = (
  enabledList: EnabledProviderWithModels[],
  runtimeConfig: ModelNetProviderRuntimeConfigMap = {},
): EnabledProviderWithModels | undefined => {
  const customCandidateCount = getModelNetUserProviderCandidates(enabledList, runtimeConfig).length;
  const providerMatches = enabledList
    .map((provider) => ({
      candidates: provider.children.filter((model) =>
        isModelNetParallelCandidate(model, provider.id),
      ),
      provider,
    }))
    .filter(
      ({ candidates }) => candidates.length + customCandidateCount >= MIN_MODELNET_PARALLEL_MODELS,
    );

  return (
    MODELNET_PROVIDER_IDS.map((providerId) =>
      providerMatches.find(({ provider }) => provider.id === providerId),
    ).find(Boolean)?.provider ?? providerMatches[0]?.provider
  );
};

export const getModelNetParallelCandidates = (
  enabledList: EnabledProviderWithModels[],
  providerId?: string,
  runtimeConfig: ModelNetProviderRuntimeConfigMap = {},
): AiModelForSelect[] => {
  const provider =
    (providerId && enabledList.find((item) => item.id === providerId)) ||
    getModelNetParallelProvider(enabledList, runtimeConfig);
  const registryCandidates =
    provider?.children.filter((model) => isModelNetParallelCandidate(model, provider.id)) ?? [];

  return uniqueCandidates([
    ...registryCandidates,
    ...getModelNetUserProviderCandidates(enabledList, runtimeConfig),
  ]);
};

export const getDefaultModelNetParallelModelIds = (candidates: AiModelForSelect[]) =>
  candidates.slice(0, MIN_MODELNET_PARALLEL_MODELS).map((model) => model.id);

export const normalizeModelNetParallelModelIds = (
  modelIds: string[] | undefined,
  candidates: AiModelForSelect[],
) => {
  const candidateIds = new Set(candidates.map((model) => model.id));
  const uniqueIds = [...new Set(modelIds ?? [])].filter((id) => candidateIds.has(id));

  if (uniqueIds.length >= MIN_MODELNET_PARALLEL_MODELS) {
    return uniqueIds;
  }

  return getDefaultModelNetParallelModelIds(candidates);
};

export const modelIdsToModelNetSerialTopology = (modelIds: string[]): ModelNetSerialTopology => {
  const nodes = modelIds.map((modelId, index) => ({
    id: `step-${index + 1}`,
    modelId,
  }));

  const edges: ModelNetSerialTopology['edges'] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const source = nodes[index];
    const target = nodes[index + 1];

    if (source && target) edges.push({ source: source.id, target: target.id });
  }

  return {
    version: 'modelnet.serial.v1',
    nodes,
    edges,
  };
};

export const getDefaultModelNetSerialTopology = (candidates: AiModelForSelect[]) =>
  modelIdsToModelNetSerialTopology(
    candidates.slice(0, MIN_MODELNET_SERIAL_MODELS).map((model) => model.id),
  );

export const normalizeModelNetSerialTopology = (
  topology: ModelNetSerialTopology | undefined,
  candidates: AiModelForSelect[],
) => {
  const candidateIds = new Set(candidates.map((model) => model.id));
  const modelIds = topology?.nodes.map((node) => node.modelId) ?? [];
  const uniqueIds = [...new Set(modelIds)].filter((id) => candidateIds.has(id));

  if (uniqueIds.length >= MIN_MODELNET_SERIAL_MODELS) {
    return modelIdsToModelNetSerialTopology(uniqueIds);
  }

  return getDefaultModelNetSerialTopology(candidates);
};

const parallelModel: AiModelForSelect = {
  abilities: {},
  description: 'Run selected ModelNet models in parallel and synthesize one answer.',
  displayName: MODELNET_PARALLEL_DISPLAY_NAME,
  id: MODELNET_PARALLEL_MODEL_ID,
};

const serialModel: AiModelForSelect = {
  abilities: {},
  description: 'Run selected ModelNet models in a gateway-managed serial chain.',
  displayName: MODELNET_SERIAL_DISPLAY_NAME,
  id: MODELNET_SERIAL_MODEL_ID,
};

export const withModelNetParallelModel = (
  enabledList: EnabledProviderWithModels[],
  runtimeConfig: ModelNetProviderRuntimeConfigMap = {},
): EnabledProviderWithModels[] => {
  const normalizedList = enabledList.map((provider) => ({
    ...provider,
    children: provider.children.filter(
      (model) => model.id !== MODELNET_PARALLEL_MODEL_ID && model.id !== MODELNET_SERIAL_MODEL_ID,
    ),
  }));
  const modelNetProvider = getModelNetParallelProvider(normalizedList, runtimeConfig);
  const candidates = modelNetProvider
    ? getModelNetParallelCandidates(normalizedList, modelNetProvider.id, runtimeConfig)
    : [];
  if (candidates.length < MIN_MODELNET_PARALLEL_MODELS) return normalizedList;

  return normalizedList.map((provider) => {
    if (provider.id !== modelNetProvider?.id) return provider;

    return {
      ...provider,
      children: [parallelModel, serialModel, ...provider.children],
    };
  });
};
