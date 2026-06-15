import { type AiModelForSelect } from 'model-bank';

import { type EnabledProviderWithModels } from '@/types/aiProvider';

export const MODELNET_OPENAI_PROVIDER_ID = 'openai';
export const MODELNET_LEGACY_PROVIDER_ID = 'lobehub';
export const MODELNET_PROVIDER_IDS = [
  MODELNET_OPENAI_PROVIDER_ID,
  MODELNET_LEGACY_PROVIDER_ID,
] as const;
export const MODELNET_PARALLEL_MODEL_ID = 'modelnet-parallel';
export const MODELNET_PARALLEL_DISPLAY_NAME = 'ModelNet \u5e76\u8054';
export const MIN_MODELNET_PARALLEL_MODELS = 2;
export const MAX_MODELNET_PARALLEL_MODELS = 16;

const MODELNET_SYSTEM_MODEL_IDS = new Set([
  'modelnet',
  'modelnet-auto',
  MODELNET_PARALLEL_MODEL_ID,
]);

export const isModelNetParallelModel = (provider?: string, model?: string) =>
  !!provider &&
  MODELNET_PROVIDER_IDS.includes(provider as (typeof MODELNET_PROVIDER_IDS)[number]) &&
  model === MODELNET_PARALLEL_MODEL_ID;

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

export const isModelNetParallelCandidate = (model: AiModelForSelect, providerId?: string) => {
  if (MODELNET_SYSTEM_MODEL_IDS.has(model.id)) return false;
  if (providerId === MODELNET_LEGACY_PROVIDER_ID) return true;

  return isModelNetDisplayName(model.displayName) || isLikelyModelNetAlias(model.id, providerId);
};

export const getModelNetParallelProvider = (
  enabledList: EnabledProviderWithModels[],
): EnabledProviderWithModels | undefined => {
  const providerMatches = enabledList
    .map((provider) => ({
      candidates: provider.children.filter((model) =>
        isModelNetParallelCandidate(model, provider.id),
      ),
      provider,
    }))
    .filter(({ candidates }) => candidates.length >= MIN_MODELNET_PARALLEL_MODELS);

  return (
    MODELNET_PROVIDER_IDS.map((providerId) =>
      providerMatches.find(({ provider }) => provider.id === providerId),
    ).find(Boolean)?.provider ?? providerMatches[0]?.provider
  );
};

export const getModelNetParallelCandidates = (
  enabledList: EnabledProviderWithModels[],
  providerId?: string,
): AiModelForSelect[] => {
  const provider =
    (providerId && enabledList.find((item) => item.id === providerId)) ||
    getModelNetParallelProvider(enabledList);

  return provider?.children.filter((model) => isModelNetParallelCandidate(model, provider.id)) ?? [];
};

export const getDefaultModelNetParallelModelIds = (candidates: AiModelForSelect[]) =>
  candidates.slice(0, MIN_MODELNET_PARALLEL_MODELS).map((model) => model.id);

export const normalizeModelNetParallelModelIds = (
  modelIds: string[] | undefined,
  candidates: AiModelForSelect[],
) => {
  const candidateIds = new Set(candidates.map((model) => model.id));
  const uniqueIds = [...new Set(modelIds ?? [])].filter((id) => candidateIds.has(id));

  if (
    uniqueIds.length >= MIN_MODELNET_PARALLEL_MODELS &&
    uniqueIds.length <= MAX_MODELNET_PARALLEL_MODELS
  ) {
    return uniqueIds;
  }

  return getDefaultModelNetParallelModelIds(candidates);
};

const parallelModel: AiModelForSelect = {
  abilities: {},
  description: 'Run selected ModelNet models in parallel and synthesize one answer.',
  displayName: MODELNET_PARALLEL_DISPLAY_NAME,
  id: MODELNET_PARALLEL_MODEL_ID,
};

export const withModelNetParallelModel = (
  enabledList: EnabledProviderWithModels[],
): EnabledProviderWithModels[] => {
  const normalizedList = enabledList.map((provider) => ({
    ...provider,
    children: provider.children.filter((model) => model.id !== MODELNET_PARALLEL_MODEL_ID),
  }));
  const modelNetProvider = getModelNetParallelProvider(normalizedList);
  const candidates = modelNetProvider
    ? getModelNetParallelCandidates(normalizedList, modelNetProvider.id)
    : [];
  if (candidates.length < MIN_MODELNET_PARALLEL_MODELS) return normalizedList;

  return normalizedList.map((provider) => {
    if (provider.id !== modelNetProvider?.id) return provider;

    return {
      ...provider,
      children: [parallelModel, ...provider.children],
    };
  });
};
