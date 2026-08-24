import { DEFAULT_ONBOARDING_MODEL, DEFAULT_ONBOARDING_PROVIDER } from '@lobechat/business-const';
import { describe, expect, it } from 'vitest';

import { WEB_ONBOARDING } from '../../packages/builtin-agents/src/agents/web-onboarding';

describe('WEB_ONBOARDING', () => {
  it('persists with the dedicated onboarding default model and provider', () => {
    expect(DEFAULT_ONBOARDING_PROVIDER).toBe('modelnet');
    expect(DEFAULT_ONBOARDING_MODEL).toBe('inference-qwen-qwen3-5-35b-a3b-gptq-int4');
    expect(WEB_ONBOARDING.persist).toMatchObject({
      model: DEFAULT_ONBOARDING_MODEL,
      provider: DEFAULT_ONBOARDING_PROVIDER,
    });
  });
});
