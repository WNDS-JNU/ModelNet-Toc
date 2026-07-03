import type { AIChatModelCard } from '../types/aiModel';

const modelNetChatModels: AIChatModelCard[] = [
  {
    abilities: {
      functionCall: true,
    },
    displayName: 'ModelNet',
    enabled: true,
    id: 'modelnet',
    type: 'chat',
  },
  {
    abilities: {
      functionCall: true,
    },
    displayName: 'Auto Network',
    enabled: true,
    id: 'modelnet-auto',
    type: 'chat',
  },
];

export const allModels = [...modelNetChatModels];

export default allModels;
