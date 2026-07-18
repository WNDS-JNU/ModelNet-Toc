/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import ModelNetTraceThinking from './ModelNetTraceThinking';

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({
    children,
    horizontal: _horizontal,
    ...props
  }: {
    children?: ReactNode;
    horizontal?: boolean;
  }) => <div {...props}>{children}</div>,
}));

vi.mock('@/features/Conversation/components/Thinking', () => ({
  default: ({ content, thinking }: { content?: ReactNode; thinking?: boolean }) => (
    <section data-testid="modelnet-thinking" data-thinking={String(Boolean(thinking))}>
      {content}
    </section>
  ),
}));

describe('ModelNetTraceThinking', () => {
  it('renders running ModelNet sources in the Thinking surface', () => {
    render(
      <ModelNetTraceThinking
        data={{
          sourceOrder: ['source-a'],
          sources: {
            'source-a': {
              model: 'inference-cyankiwi-llama-3-1-8b-instruct-awq-int4',
              sourceId: 'source-a',
              status: 'running',
              text: '',
            },
          },
        }}
      />,
    );

    expect(screen.getByTestId('modelnet-thinking')).toHaveAttribute('data-thinking', 'true');
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByTitle('inference-cyankiwi-llama-3-1-8b-instruct-awq-int4')).toBeInTheDocument();
  });

  it('keeps completed ModelNet sources in a collapsible Thinking surface', () => {
    render(
      <ModelNetTraceThinking
        data={{
          sourceOrder: ['source-a'],
          sources: {
            'source-a': {
              latencyMs: 1280,
              model: 'qwen3',
              sourceId: 'source-a',
              status: 'completed',
              text: 'answer',
            },
          },
        }}
      />,
    );

    expect(screen.getByTestId('modelnet-thinking')).toHaveAttribute('data-thinking', 'false');
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('1280 ms')).toBeInTheDocument();
  });
});
