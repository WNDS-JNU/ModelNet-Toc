import type { ChatModelCard } from '@lobechat/types';
import { ModelProvider } from 'model-bank';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';

export interface ModelNetModelCard {
  id: string;
}

export const params = {
  baseURL: 'http://modelnet-router:8000/v1',
  debug: {
    chatCompletion: () => process.env.DEBUG_MODELNET_CHAT_COMPLETION === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as any;
    const modelList: ModelNetModelCard[] = modelsPage.data || [];

    return modelList.map((model) => ({
      enabled: true,
      id: model.id,
    })) as ChatModelCard[];
  },
  provider: ModelProvider.ModelNet,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeModelNetAI = createOpenAICompatibleRuntime(params);
