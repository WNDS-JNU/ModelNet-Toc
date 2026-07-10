import { DEFAULT_ONBOARDING_MODEL, DEFAULT_ONBOARDING_PROVIDER } from '@lobechat/business-const';
import { describe, expect, it } from 'vitest';

import { ONBOARDING_PRODUCTION_DEFAULT_MODEL } from './onboarding';

describe('ONBOARDING_PRODUCTION_DEFAULT_MODEL', () => {
  it('uses the dedicated onboarding default model and provider', () => {
    expect(DEFAULT_ONBOARDING_PROVIDER).toBe('modelnet');
    expect(DEFAULT_ONBOARDING_MODEL).toBe('inference-qwen-qwen3-5-35b-a3b-gptq-int4');
    expect(ONBOARDING_PRODUCTION_DEFAULT_MODEL).toEqual({
      model: DEFAULT_ONBOARDING_MODEL,
      provider: DEFAULT_ONBOARDING_PROVIDER,
    });
  });
});
