import type { AgentGroupRunDebateSnapshot, AgentGroupRunPlanNodeInput } from '@lobechat/types';

export interface FixedRoundDebateParticipant {
  agentId: string;
  perspective?: string;
}

export interface BuildFixedRoundDebatePlanInput {
  judgeAgentId: string;
  judgeInstruction?: string;
  judgeTimeoutMs?: number;
  motion: string;
  participants: FixedRoundDebateParticipant[];
  roundMaxAttempts?: number;
  rounds: number;
  roundTimeoutMs?: number;
}

export interface FixedRoundDebatePlan {
  debate: AgentGroupRunDebateSnapshot;
  nodes: AgentGroupRunPlanNodeInput[];
}

const roundKeys = (round: number, participantCount: number) =>
  Array.from({ length: participantCount }, (_, index) => `debate-r${round}-p${index + 1}`);

export const buildFixedRoundDebatePlan = ({
  judgeAgentId,
  judgeInstruction,
  judgeTimeoutMs,
  motion,
  participants,
  roundMaxAttempts = 1,
  roundTimeoutMs,
  rounds,
}: BuildFixedRoundDebatePlanInput): FixedRoundDebatePlan => {
  const normalizedMotion = motion.trim();
  const normalizedJudgeAgentId = judgeAgentId.trim();
  const normalizedParticipants = participants.map((participant) => ({
    agentId: participant.agentId.trim(),
    perspective: participant.perspective?.trim(),
  }));
  const invalid =
    !normalizedMotion ||
    !normalizedJudgeAgentId ||
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    rounds > 5 ||
    normalizedParticipants.length < 2 ||
    normalizedParticipants.length > 8 ||
    normalizedParticipants.some((participant) => !participant.agentId) ||
    new Set(normalizedParticipants.map((participant) => participant.agentId)).size !==
      normalizedParticipants.length ||
    normalizedParticipants.some((participant) => participant.agentId === normalizedJudgeAgentId) ||
    !Number.isInteger(roundMaxAttempts) ||
    roundMaxAttempts < 1 ||
    roundMaxAttempts > 3 ||
    (roundTimeoutMs !== undefined &&
      (!Number.isSafeInteger(roundTimeoutMs) || roundTimeoutMs <= 0)) ||
    (judgeTimeoutMs !== undefined &&
      (!Number.isSafeInteger(judgeTimeoutMs) || judgeTimeoutMs <= 0));
  if (invalid) throw new Error('AGENT_GROUP_DEBATE_INVALID');

  const nodes: AgentGroupRunPlanNodeInput[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const dependencies = round === 1 ? [] : roundKeys(round - 1, normalizedParticipants.length);
    normalizedParticipants.forEach((participant, index) => {
      const perspective = participant.perspective
        ? `Assigned perspective: ${participant.perspective}`
        : 'Use your own expertise and state a clear position.';
      const roundInstruction =
        round === 1
          ? 'Present your opening position with concise reasons and evidence.'
          : `Read the structured viewpoints from round ${round - 1}, address their strongest points, and refine or defend your position.`;
      nodes.push({
        agentId: participant.agentId,
        barrierKey: `debate-round-${round}`,
        dependencies,
        instruction: [
          `Debate motion: ${normalizedMotion}`,
          perspective,
          `Round ${round} of ${rounds}. ${roundInstruction}`,
          'Return a self-contained structured viewpoint for the next round and final judge.',
        ].join('\n'),
        key: `debate-r${round}-p${index + 1}`,
        maxAttempts: roundMaxAttempts,
        role: 'debater',
        timeoutMs: roundTimeoutMs,
        toolPolicy: { disableTools: true },
      });
    });
  }

  const finalRoundKeys = roundKeys(rounds, normalizedParticipants.length);
  nodes.push({
    agentId: normalizedJudgeAgentId,
    barrierKey: 'debate-verdict',
    dependencies: finalRoundKeys,
    instruction: [
      `Debate motion: ${normalizedMotion}`,
      judgeInstruction?.trim() ||
        'Compare the final structured viewpoints, identify the strongest supported arguments, and issue a clear reasoned verdict.',
      'Do not introduce anonymous model votes or new participants. Return the final verdict for the supervisor.',
    ].join('\n'),
    key: 'debate-judge',
    maxAttempts: 1,
    role: 'judge',
    timeoutMs: judgeTimeoutMs,
    toolPolicy: { disableTools: true },
  });

  return {
    debate: {
      judgeAgentId: normalizedJudgeAgentId,
      participantAgentIds: normalizedParticipants.map((participant) => participant.agentId),
      rounds,
      termination: 'fixed_rounds',
    },
    nodes,
  };
};
