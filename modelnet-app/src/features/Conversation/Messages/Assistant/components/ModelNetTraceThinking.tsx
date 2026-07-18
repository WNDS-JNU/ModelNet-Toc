import { memo } from 'react';

import Thinking from '@/features/Conversation/components/Thinking';

import ModelNetParallelTrace, { type ModelNetParallelMetadata } from './ModelNetParallelTrace';

const ACTIVE_SOURCE_STATUSES = new Set(['pending', 'running']);

const hasModelNetTraceSources = (data?: ModelNetParallelMetadata | null) =>
  Object.keys(data?.sources ?? {}).length > 0;

export const isModelNetTraceRunning = (data?: ModelNetParallelMetadata | null) =>
  Object.values(data?.sources ?? {}).some((source) => ACTIVE_SOURCE_STATUSES.has(source.status));

const ModelNetTraceThinking = memo<{ data?: ModelNetParallelMetadata | null }>(({ data }) => {
  if (!hasModelNetTraceSources(data)) return null;

  return (
    <Thinking
      content={<ModelNetParallelTrace data={data} />}
      thinking={isModelNetTraceRunning(data)}
    />
  );
});

ModelNetTraceThinking.displayName = 'ModelNetTraceThinking';

export default ModelNetTraceThinking;
