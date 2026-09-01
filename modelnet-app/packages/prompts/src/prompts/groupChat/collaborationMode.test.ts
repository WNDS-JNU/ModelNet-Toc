import { describe, expect, it } from 'vitest';

import {
  buildAgentGroupCollaborationModeInstruction,
  mergeAgentGroupCollaborationSystemPrompt,
} from './index';

describe('Agent Group collaboration mode prompt', () => {
  it('keeps auto mode free for Supervisor routing', () => {
    expect(buildAgentGroupCollaborationModeInstruction()).toBeUndefined();
    expect(buildAgentGroupCollaborationModeInstruction('auto')).toBeUndefined();
    expect(mergeAgentGroupCollaborationSystemPrompt('group role', 'auto')).toBe('group role');
  });

  it.each([
    ['single', 'Do not call any lobe-group-management orchestration tool'],
    ['broadcast', 'broadcast tool'],
    ['parallel_tasks', 'executeAgentTasks tool'],
    ['pipeline', 'createWorkflow tool'],
    ['debate', 'createDebate tool'],
  ] as const)('pins %s to its concrete orchestration tool', (mode, expected) => {
    const instruction = buildAgentGroupCollaborationModeInstruction(mode);

    expect(instruction).toContain(expected);
    expect(instruction).toContain('explicitly selected');
  });

  it('appends the run-scoped constraint after the persistent group prompt', () => {
    const result = mergeAgentGroupCollaborationSystemPrompt('Persistent group role', 'pipeline');

    expect(result).toMatch(/^Persistent group role\n\n/);
    expect(result).toContain('createWorkflow');
  });

  it('returns only the run constraint when no persistent prompt exists', () => {
    expect(mergeAgentGroupCollaborationSystemPrompt(undefined, 'debate')).toContain('createDebate');
  });
});
