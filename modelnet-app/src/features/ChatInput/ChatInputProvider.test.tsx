import { render } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ChatInputProvider } from './ChatInputProvider';
import { useChatInputStore } from './store';

vi.mock('@lobehub/editor/react', () => ({
  useEditor: () => undefined,
}));

vi.mock('./ReasoningConfigLoader', () => ({
  default: () => null,
}));

vi.mock('./StoreUpdater', () => ({
  default: () => null,
}));

const Probe = ({ onState }: { onState: (state: { left: unknown; right: unknown }) => void }) => {
  const leftActions = useChatInputStore((state) => state.leftActions);
  const rightActions = useChatInputStore((state) => state.rightActions);

  useEffect(() => {
    onState({ left: leftActions, right: rightActions });
  }, [leftActions, onState, rightActions]);

  return null;
};

describe('ChatInputProvider', () => {
  it('keeps action lists as arrays when optional props are omitted', () => {
    const onState = vi.fn();

    render(
      <ChatInputProvider>
        <Probe onState={onState} />
      </ChatInputProvider>,
    );

    expect(onState).toHaveBeenLastCalledWith({ left: [], right: [] });
  });
});
