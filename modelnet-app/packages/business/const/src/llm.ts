export const DEFAULT_EMBEDDING_PROVIDER = 'openai';

export const DEFAULT_MODEL = 'inference-qwen-qwen3-5-35b-a3b-gptq-int4';
export const DEFAULT_PROVIDER = 'modelnet';
export const DEFAULT_MINI_MODEL = DEFAULT_MODEL;
export const DEFAULT_MINI_PROVIDER = DEFAULT_PROVIDER;

export const DEFAULT_ONBOARDING_MODEL = DEFAULT_MODEL;
export const DEFAULT_ONBOARDING_PROVIDER = DEFAULT_PROVIDER;

/**
 * The vision-capable model used by Verify to review evidence screenshots.
 * Keep the ModelNet defaults above while exposing the new upstream contract.
 */
export const DEFAULT_REVIEW_PREDICT_MODEL = DEFAULT_MODEL;
export const DEFAULT_REVIEW_PREDICT_PROVIDER = DEFAULT_PROVIDER;
