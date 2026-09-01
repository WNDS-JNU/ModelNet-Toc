// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildFixedRoundDebatePlan } from './debate';

describe('buildFixedRoundDebatePlan', () => {
  it('expands fixed participants and rounds into deterministic barriers', () => {
    const result = buildFixedRoundDebatePlan({
      judgeAgentId: 'judge',
      motion: 'Use durable orchestration?',
      participants: [
        { agentId: 'pro', perspective: 'Argue for it' },
        { agentId: 'con', perspective: 'Argue against it' },
      ],
      roundTimeoutMs: 60_000,
      rounds: 2,
    });

    expect(result.debate).toEqual({
      judgeAgentId: 'judge',
      participantAgentIds: ['pro', 'con'],
      rounds: 2,
      termination: 'fixed_rounds',
    });
    expect(result.nodes.map(({ key }) => key)).toEqual([
      'debate-r1-p1',
      'debate-r1-p2',
      'debate-r2-p1',
      'debate-r2-p2',
      'debate-judge',
    ]);
    expect(result.nodes[2]).toMatchObject({
      barrierKey: 'debate-round-2',
      dependencies: ['debate-r1-p1', 'debate-r1-p2'],
      toolPolicy: { disableTools: true },
    });
    expect(result.nodes.at(-1)).toMatchObject({
      agentId: 'judge',
      dependencies: ['debate-r2-p1', 'debate-r2-p2'],
      role: 'judge',
    });
  });

  it.each([
    { judgeAgentId: 'pro', participants: [{ agentId: 'pro' }, { agentId: 'con' }], rounds: 1 },
    { judgeAgentId: 'judge', participants: [{ agentId: 'same' }, { agentId: 'same' }], rounds: 1 },
    { judgeAgentId: 'judge', participants: [{ agentId: 'pro' }, { agentId: 'con' }], rounds: 6 },
  ])('rejects an invalid fixed roster or round count', (invalid) => {
    expect(() =>
      buildFixedRoundDebatePlan({
        motion: 'Motion',
        ...invalid,
      }),
    ).toThrow('AGENT_GROUP_DEBATE_INVALID');
  });
});
