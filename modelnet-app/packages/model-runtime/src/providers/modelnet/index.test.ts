// @vitest-environment node
import { ModelProvider } from 'model-bank';
import { describe, expect, it } from 'vitest';

import { testProvider } from '../../providerTestUtils';
import { providerRuntimeMap } from '../../runtimeMap';
import { LobeModelNetAI } from './index';

testProvider({
  Runtime: LobeModelNetAI,
  provider: ModelProvider.ModelNet,
  defaultBaseURL: 'http://modelnet-router:8000/v1',
  chatDebugEnv: 'DEBUG_MODELNET_CHAT_COMPLETION',
  chatModel: 'modelnet-auto',
});

describe('LobeModelNetAI', () => {
  it('is registered in the provider runtime map', () => {
    expect(providerRuntimeMap[ModelProvider.ModelNet]).toBe(LobeModelNetAI);
  });
});
