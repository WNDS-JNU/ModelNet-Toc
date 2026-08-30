import { describe, expect, it } from 'vitest';

import { resolveGroupBuilderMemberConfig } from './groupMemberConfig';

describe('resolveGroupBuilderMemberConfig', () => {
  it('keeps ordinary members on the built-in model runtime', () => {
    expect(
      resolveGroupBuilderMemberConfig({
        systemRole: 'Review the design.',
        title: 'Reviewer',
        tools: ['web-crawler'],
      }),
    ).toEqual({
      avatar: undefined,
      description: undefined,
      plugins: ['web-crawler'],
      systemRole: 'Review the design.',
      title: 'Reviewer',
    });
  });

  it.each([
    ['codex', 'codex'],
    ['claude-code', 'claude'],
  ] as const)(
    'creates %s members with the local subscription and CLI defaults',
    (runtime, command) => {
      const config = resolveGroupBuilderMemberConfig({
        runtime,
        systemRole: 'Work on the repository.',
        title: runtime,
        tools: ['lobe-cloud-sandbox'],
      });

      expect(config).toMatchObject({
        agencyConfig: {
          executionTarget: 'local',
          heterogeneousProvider: {
            authMode: 'subscription',
            command,
            systemContext: 'Work on the repository.',
            type: runtime,
          },
        },
        provider: runtime,
      });
      expect(config).not.toHaveProperty('model');
      expect(config).not.toHaveProperty('plugins');
    },
  );
});
