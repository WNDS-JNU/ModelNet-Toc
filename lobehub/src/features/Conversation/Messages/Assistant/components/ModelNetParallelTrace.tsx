import { Flexbox } from '@lobehub/ui';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2 } from 'lucide-react';
import { memo, useMemo, useState } from 'react';

interface ModelNetParallelSourceState {
  error?: string;
  latencyMs?: number;
  model: string;
  sourceId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'summarized';
  summarized?: boolean;
  summary?: string;
  text: string;
}

interface ModelNetParallelMetadata {
  sourceOrder?: string[];
  sources?: Record<string, ModelNetParallelSourceState>;
}

const statusLabel: Record<ModelNetParallelSourceState['status'], string> = {
  completed: 'done',
  failed: 'failed',
  pending: 'pending',
  running: 'running',
  summarized: 'summarized',
};

const StatusIcon = ({ status }: { status: ModelNetParallelSourceState['status'] }) => {
  if (status === 'failed') return <AlertCircle size={14} />;
  if (status === 'completed' || status === 'summarized') return <CheckCircle2 size={14} />;
  if (status === 'running') return <Loader2 size={14} />;
  return <Clock size={14} />;
};

const ModelNetParallelTrace = memo<{ data?: ModelNetParallelMetadata | null }>(({ data }) => {
  const sources = data?.sources;
  const orderedSources = useMemo(() => {
    if (!sources) return [];
    const order = data?.sourceOrder?.length ? data.sourceOrder : Object.keys(sources);
    return order
      .map((id) => sources[id])
      .filter((source): source is ModelNetParallelSourceState => Boolean(source));
  }, [data?.sourceOrder, sources]);
  const [activeSourceId, setActiveSourceId] = useState<string | undefined>(
    orderedSources[0]?.sourceId,
  );

  if (!orderedSources.length) return null;

  const active = orderedSources.find((source) => source.sourceId === activeSourceId) ?? orderedSources[0];
  if (!active) return null;

  return (
    <Flexbox
      gap={8}
      style={{
        border: '1px solid var(--lobe-color-border-secondary)',
        borderRadius: 8,
        padding: 10,
      }}
    >
      <Flexbox gap={6} horizontal style={{ flexWrap: 'wrap' }}>
        {orderedSources.map((source) => {
          const activeChip = source.sourceId === active.sourceId;
          return (
            <button
              key={source.sourceId}
              onClick={() => setActiveSourceId(source.sourceId)}
              style={{
                alignItems: 'center',
                background: activeChip ? 'var(--lobe-color-fill-tertiary)' : 'transparent',
                border: '1px solid var(--lobe-color-border-secondary)',
                borderRadius: 18,
                color: 'inherit',
                cursor: 'pointer',
                display: 'inline-flex',
                font: 'inherit',
                gap: 6,
                maxWidth: '100%',
                minHeight: 28,
                padding: '3px 9px',
              }}
              title={source.model}
              type="button"
            >
              {activeChip ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <StatusIcon status={source.status} />
              <span
                style={{
                  maxWidth: 220,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {source.model || source.sourceId}
              </span>
              <span style={{ color: 'var(--lobe-color-text-secondary)', fontSize: 12 }}>
                {statusLabel[source.status]}
              </span>
            </button>
          );
        })}
      </Flexbox>

      {active && (
        <Flexbox gap={8}>
          <Flexbox
            horizontal
            style={{
              color: 'var(--lobe-color-text-secondary)',
              fontSize: 12,
              justifyContent: 'space-between',
            }}
          >
            <span>{active.sourceId}</span>
            {typeof active.latencyMs === 'number' && <span>{active.latencyMs} ms</span>}
          </Flexbox>

          {active.error ? (
            <pre
              style={{
                margin: 0,
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {active.error}
            </pre>
          ) : (
            <pre
              style={{
                margin: 0,
                maxHeight: 280,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {active.text || ''}
            </pre>
          )}

          {active.summarized && active.summary && (
            <Flexbox
              gap={4}
              style={{
                borderTop: '1px solid var(--lobe-color-border-secondary)',
                color: 'var(--lobe-color-text-secondary)',
                fontSize: 12,
                paddingTop: 8,
              }}
            >
              <span>Used summary for synthesis</span>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{active.summary}</pre>
            </Flexbox>
          )}
        </Flexbox>
      )}
    </Flexbox>
  );
});

ModelNetParallelTrace.displayName = 'ModelNetParallelTrace';

export default ModelNetParallelTrace;
