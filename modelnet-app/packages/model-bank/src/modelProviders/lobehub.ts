import type { ModelProviderCard } from '../types';

const LobeHub: ModelProviderCard = {
  chatModels: [],
  description:
    'ModelNet Cloud routes requests across the ModelNet model network through the TOC gateway.',
  enabled: true,
  id: 'lobehub',
  modelsUrl: 'https://123.56.135.150',
  name: 'ModelNet Cloud',
  settings: {
    modelEditable: false,
    showAddNewModel: false,
    showModelFetcher: false,
  },
  showConfig: false,
  url: 'https://123.56.135.150',
};

export default LobeHub;

export const planCardModels = [
  'deepseek-v4-pro',
  'claude-sonnet-4-6',
  'gemini-3.1-pro-preview',
  'gpt-5.5',
];
