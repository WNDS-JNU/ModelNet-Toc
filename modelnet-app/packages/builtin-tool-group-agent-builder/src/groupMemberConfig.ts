import type { LobeAgentAgencyConfig } from '@lobechat/types';

import type { CreateAgentParams, CreateAgentRuntime } from './types';

const CLI_RUNTIME_DEFAULTS = {
  'claude-code': { command: 'claude', type: 'claude-code' },
  'codex': { command: 'codex', type: 'codex' },
} as const;

export interface GroupBuilderMemberConfig {
  agencyConfig?: LobeAgentAgencyConfig;
  avatar?: string;
  description?: string;
  plugins?: string[];
  provider?: string;
  systemRole: string;
  title: string;
}

const isCliRuntime = (
  runtime: CreateAgentRuntime | undefined,
): runtime is keyof typeof CLI_RUNTIME_DEFAULTS => runtime === 'claude-code' || runtime === 'codex';

/**
 * Convert Group Agent Builder input into a persisted member config.
 *
 * Claude Code and Codex are external CLI runtimes, not chat-model providers.
 * Their model/effort/API fields stay unset so the spawned CLI uses its own
 * configured defaults and the subscription credentials already present on the
 * machine executing the run.
 */
export const resolveGroupBuilderMemberConfig = (
  params: CreateAgentParams,
): GroupBuilderMemberConfig => {
  const base = {
    avatar: params.avatar,
    description: params.description,
    systemRole: params.systemRole,
    title: params.title,
  };

  if (!isCliRuntime(params.runtime)) {
    return { ...base, plugins: params.tools };
  }

  const runtime = CLI_RUNTIME_DEFAULTS[params.runtime];

  return {
    ...base,
    agencyConfig: {
      executionTarget: 'local',
      heterogeneousProvider: {
        authMode: 'subscription',
        command: runtime.command,
        systemContext: params.systemRole,
        type: runtime.type,
      },
    },
    provider: runtime.type,
  };
};
