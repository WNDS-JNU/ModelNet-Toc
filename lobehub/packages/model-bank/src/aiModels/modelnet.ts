import type { AIChatModelCard } from '../types/aiModel';

const modelNetChatModels: AIChatModelCard[] = [
  {
    abilities: {
      functionCall: false,
    },
    displayName: 'ModelNet',
    enabled: true,
    id: 'modelnet',
    type: 'chat',
  },
  {
    abilities: {
      functionCall: false,
    },
    displayName: 'Auto Network',
    enabled: true,
    id: 'modelnet-auto',
    type: 'chat',
  },
  {
    abilities: {
      functionCall: false,
    },
    displayName: 'Qwen3.5-35B-A3B-GPTQ-Int4',
    enabled: true,
    id: 'inference-qwen-qwen3-5-35b-a3b-gptq-int4',
    type: 'chat',
  },
];

export const allModels = [...modelNetChatModels];

export default allModels;
