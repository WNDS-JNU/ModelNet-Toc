import { useCallback } from 'react';

import {
  getModelNetParallelCandidates,
  isModelNetParallelModel,
  isModelNetSerialModel,
  MIN_MODELNET_PARALLEL_MODELS,
  MIN_MODELNET_SERIAL_MODELS,
  type ModelNetProviderRuntimeConfigMap,
  normalizeModelNetParallelModelIds,
  normalizeModelNetSerialTopology,
} from '@/features/ModelNetParallel';
import { usePermission } from '@/hooks/usePermission';
import { useAgentStore } from '@/store/agent';
import { type EnabledProviderWithModels } from '@/types/aiProvider';

import { type ModelChangeParams } from '../types';

interface UsePanelHandlersProps {
  enabledList?: EnabledProviderWithModels[];
  onModelChange?: (params: ModelChangeParams) => Promise<void>;
  onOpenChange?: (open: boolean) => void;
  runtimeConfig?: ModelNetProviderRuntimeConfigMap;
}

export const usePanelHandlers = ({
  enabledList = [],
  onModelChange: onModelChangeProp,
  onOpenChange,
  runtimeConfig,
}: UsePanelHandlersProps) => {
  const { allowed: canCreateContent } = usePermission('create_content');
  const updateAgentConfig = useAgentStore((s) => s.updateAgentConfig);
  const currentAgentParams = useAgentStore((s) => s.agentMap?.[s.activeAgentId || '']?.params);

  const handleModelChange = useCallback(
    (modelId: string, providerId: string) => {
      if (!canCreateContent) return;

      // Commit synchronously so a quick send after closing the panel uses the new model.
      const params: ModelChangeParams = { model: modelId, provider: providerId };

      if (isModelNetParallelModel(providerId, modelId)) {
        const candidates = getModelNetParallelCandidates(enabledList, providerId, runtimeConfig);
        const modelnetParallelModelIds = normalizeModelNetParallelModelIds(
          currentAgentParams?.modelnetParallelModelIds,
          candidates,
        );

        if (modelnetParallelModelIds.length >= MIN_MODELNET_PARALLEL_MODELS) {
          params.params = { ...currentAgentParams, modelnetParallelModelIds };
        }
      }

      if (isModelNetSerialModel(providerId, modelId)) {
        const candidates = getModelNetParallelCandidates(enabledList, providerId, runtimeConfig);
        const modelnetSerialTopology = normalizeModelNetSerialTopology(
          currentAgentParams?.modelnetSerialTopology,
          candidates,
        );

        if (modelnetSerialTopology.nodes.length >= MIN_MODELNET_SERIAL_MODELS) {
          params.params = { ...currentAgentParams, modelnetSerialTopology };
        }
      }

      if (onModelChangeProp) {
        void onModelChangeProp(params);
      } else {
        void updateAgentConfig(params);
      }
    },
    [
      canCreateContent,
      currentAgentParams,
      enabledList,
      onModelChangeProp,
      runtimeConfig,
      updateAgentConfig,
    ],
  );

  const handleClose = useCallback(() => {
    onOpenChange?.(false);
  }, [onOpenChange]);

  return { handleClose, handleModelChange };
};
