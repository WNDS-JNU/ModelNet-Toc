import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OidcClientMetadata } from '@/types/oidc';

import { ConsentClient } from './index';

vi.mock('@lobehub/ui', () => ({
  Block: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  Flexbox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/features/AuthCard', () => ({
  default: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock('../OAuthApplicationLogo', () => ({
  default: () => <div />,
}));

vi.mock('./BuiltinConsent', () => ({
  default: ({ uid }: { uid: string }) => <output data-testid="builtin-consent-uid">{uid}</output>,
}));

afterEach(cleanup);

describe('ConsentClient', () => {
  it('passes the interaction uid to built-in client auto-consent', () => {
    render(
      <ConsentClient
        clientId="lobehub-desktop"
        clientMetadata={{} as OidcClientMetadata}
        scopes={[]}
        uid="interaction-uid"
      />,
    );

    expect(screen.getByTestId('builtin-consent-uid')).toHaveTextContent('interaction-uid');
  });
});
