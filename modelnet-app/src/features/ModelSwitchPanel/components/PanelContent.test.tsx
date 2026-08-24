/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { EnabledProviderWithModels } from '@/types/aiProvider';

import { PanelContent } from './PanelContent';

const mocks = vi.hoisted(() => ({
  isDevMode: false,
}));

vi.mock('@/hooks/useEnabledChatModels', () => ({
  useEnabledChatModels: () => [],
}));

vi.mock('@/store/aiInfra', () => ({
  useAiInfraStore: (
    selector: (state: { aiProviderRuntimeConfig: Record<string, unknown> }) => unknown,
  ) => selector({ aiProviderRuntimeConfig: {} }),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: { settings: { general: { isDevMode: boolean } } }) => unknown) =>
    selector({ settings: { general: { isDevMode: mocks.isDevMode } } }),
}));

vi.mock('@/store/user/slices/settings/selectors/general', () => ({
  userGeneralSettingsSelectors: {
    config: (state: { settings: { general: { isDevMode: boolean } } }) => state.settings.general,
  },
}));

vi.mock('../hooks/usePanelSize', () => ({
  usePanelSize: () => ({
    handlePanelWidthChange: vi.fn(),
    panelHeight: 480,
    panelWidth: 460,
  }),
}));

vi.mock('./Toolbar', () => ({
  Toolbar: ({ showGroupModeSwitch }: { showGroupModeSwitch?: boolean }) => (
    <div data-testid="toolbar">{showGroupModeSwitch ? 'switch-visible' : 'switch-hidden'}</div>
  ),
}));

vi.mock('./List', () => ({
  List: ({ groupMode }: { groupMode: string }) => <div data-testid="model-list">{groupMode}</div>,
}));

vi.mock('react-rnd', () => ({
  Rnd: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const enabledList: EnabledProviderWithModels[] = [
  {
    children: [
      {
        abilities: {},
        displayName: 'GPT Test',
        id: 'gpt-test',
        type: 'chat',
      } as any,
    ],
    id: 'openai',
    name: 'OpenAI',
    source: 'builtin',
  },
];

describe('PanelContent', () => {
  it('groups models by provider for non-dev users', () => {
    mocks.isDevMode = false;

    render(<PanelContent enabledList={enabledList} />);

    expect(screen.getByTestId('toolbar')).toHaveTextContent('switch-hidden');
    expect(screen.getByTestId('model-list')).toHaveTextContent('byProvider');
  });

  it('groups models by provider for dev users as well', () => {
    mocks.isDevMode = true;

    render(<PanelContent enabledList={enabledList} />);

    expect(screen.getByTestId('toolbar')).toHaveTextContent('switch-hidden');
    expect(screen.getByTestId('model-list')).toHaveTextContent('byProvider');
  });
});
