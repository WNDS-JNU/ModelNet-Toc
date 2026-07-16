import type { ModelProviderCard } from '@/types/llm';

import modelnetModels from '../aiModels/modelnet';

const ModelNet: ModelProviderCard = {
  chatModels: modelnetModels,
  checkModel: 'modelnet-auto',
  description:
    'ModelNet routes requests across the local ModelNet model network through the TOC gateway.',
  enabled: true,
  id: 'modelnet',
  modelList: { showModelFetcher: true },
  name: 'ModelNet',
  settings: {
    proxyUrl: {
      placeholder: 'http://modelnet-router:8000/v1',
    },
    sdkType: 'openai',
    showModelFetcher: true,
  },
  url: 'https://github.com/WNDS-JNU/ModelNet-Toc',
};

export default ModelNet;
