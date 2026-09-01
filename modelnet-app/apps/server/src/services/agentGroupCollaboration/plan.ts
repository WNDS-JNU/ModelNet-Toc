import { createHash } from 'node:crypto';

import type {
  AgentGroupRunDebateSnapshot,
  AgentGroupRunPlanNodeInput,
  AgentGroupRunPlanNodeSnapshot,
  AgentGroupRunPlanSnapshot,
  AgentGroupRunPolicySnapshot,
  AgentGroupRunProtocol,
} from '@lobechat/types';

export type AgentGroupPlanValidationCode =
  | 'AGENT_GROUP_PLAN_AGENT_NOT_ALLOWED'
  | 'AGENT_GROUP_PLAN_CYCLE'
  | 'AGENT_GROUP_PLAN_DUPLICATE_DEPENDENCY'
  | 'AGENT_GROUP_PLAN_DUPLICATE_NODE'
  | 'AGENT_GROUP_PLAN_EMPTY'
  | 'AGENT_GROUP_PLAN_INVALID_DEBATE'
  | 'AGENT_GROUP_PLAN_INVALID_DEPENDENCY'
  | 'AGENT_GROUP_PLAN_INVALID_NODE'
  | 'AGENT_GROUP_PLAN_INVALID_PROTOCOL_SHAPE'
  | 'AGENT_GROUP_PLAN_INVALID_SUPERVISOR';

export class AgentGroupPlanValidationError extends Error {
  constructor(
    readonly code: AgentGroupPlanValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentGroupPlanValidationError';
  }
}

export interface CompileAgentGroupRunPlanInput {
  allowedAgentIds: Iterable<string>;
  debate?: AgentGroupRunDebateSnapshot;
  nodes: AgentGroupRunPlanNodeInput[];
  policySnapshot?: AgentGroupRunPolicySnapshot;
  protocol: AgentGroupRunProtocol;
  supervisorAgentId: string;
}

const NODE_KEY_PATTERN = /^[A-Z\d][\w.-]{0,63}$/i;

const fail = (code: AgentGroupPlanValidationCode, message: string): never => {
  throw new AgentGroupPlanValidationError(code, message);
};

const assertAcyclic = (nodes: AgentGroupRunPlanNodeSnapshot[]) => {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(nodes.map((node) => [node.key, node]));

  const visit = (key: string) => {
    if (visiting.has(key)) fail('AGENT_GROUP_PLAN_CYCLE', `Cycle detected at node "${key}".`);
    if (visited.has(key)) return;

    visiting.add(key);
    for (const dependency of byKey.get(key)!.dependencies) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };

  for (const node of nodes) visit(node.key);
};

const assertProtocolShape = (
  protocol: AgentGroupRunProtocol,
  nodes: AgentGroupRunPlanNodeSnapshot[],
  debate?: AgentGroupRunDebateSnapshot,
) => {
  if (protocol === 'single' && nodes.length !== 1) {
    fail('AGENT_GROUP_PLAN_INVALID_PROTOCOL_SHAPE', 'single requires exactly one node.');
  }

  if (
    (protocol === 'single' || protocol === 'broadcast' || protocol === 'parallel_tasks') &&
    nodes.some((node) => node.dependencies.length > 0)
  ) {
    fail(
      'AGENT_GROUP_PLAN_INVALID_PROTOCOL_SHAPE',
      `${protocol} does not accept node dependencies.`,
    );
  }

  if (protocol === 'debate') {
    const participants = debate?.participantAgentIds ?? [];
    const rounds = debate?.rounds ?? 0;
    const judge = nodes.find((node) => node.role === 'judge');
    const expectedFinalRound = participants.map((_, index) => `debate-r${rounds}-p${index + 1}`);
    const shapeMatches =
      debate?.termination === 'fixed_rounds' &&
      Number.isInteger(rounds) &&
      rounds >= 1 &&
      rounds <= 5 &&
      participants.length >= 2 &&
      participants.length <= 8 &&
      new Set(participants).size === participants.length &&
      Boolean(debate.judgeAgentId) &&
      !participants.includes(debate.judgeAgentId) &&
      nodes.length === participants.length * rounds + 1 &&
      judge?.key === 'debate-judge' &&
      judge.agentId === debate.judgeAgentId &&
      JSON.stringify(judge.dependencies) === JSON.stringify(expectedFinalRound) &&
      nodes.filter((node) => node.role === 'judge').length === 1;
    if (!shapeMatches) {
      fail(
        'AGENT_GROUP_PLAN_INVALID_DEBATE',
        'debate requires 2-8 fixed participants, 1-5 rounds, and one distinct final judge.',
      );
    }

    for (let round = 1; round <= rounds; round += 1) {
      const previousRound =
        round === 1 ? [] : participants.map((_, index) => `debate-r${round - 1}-p${index + 1}`);
      participants.forEach((agentId, index) => {
        const node = nodes.find((candidate) => candidate.key === `debate-r${round}-p${index + 1}`);
        if (
          !node ||
          node.agentId !== agentId ||
          node.role !== 'debater' ||
          node.barrierKey !== `debate-round-${round}` ||
          node.toolPolicy?.disableTools !== true ||
          JSON.stringify(node.dependencies) !== JSON.stringify(previousRound)
        ) {
          fail('AGENT_GROUP_PLAN_INVALID_DEBATE', `Invalid Debate round ${round} topology.`);
        }
      });
    }
    if (judge?.toolPolicy?.disableTools !== true) {
      fail('AGENT_GROUP_PLAN_INVALID_DEBATE', 'The Debate judge must run with tools disabled.');
    }
  } else if (debate) {
    fail('AGENT_GROUP_PLAN_INVALID_DEBATE', 'Debate metadata is only valid for debate runs.');
  }
};

export const compileAgentGroupRunPlan = ({
  allowedAgentIds,
  debate,
  nodes,
  policySnapshot,
  protocol,
  supervisorAgentId,
}: CompileAgentGroupRunPlanInput): {
  planHash: string;
  planSnapshot: AgentGroupRunPlanSnapshot;
} => {
  if (nodes.length === 0) fail('AGENT_GROUP_PLAN_EMPTY', 'At least one plan node is required.');

  const allowed = new Set(allowedAgentIds);
  if (!allowed.has(supervisorAgentId)) {
    fail(
      'AGENT_GROUP_PLAN_INVALID_SUPERVISOR',
      'The supervisor must be an enabled member of the group.',
    );
  }

  const seen = new Set<string>();
  const normalizedNodes = nodes.map<AgentGroupRunPlanNodeSnapshot>((node, sortOrder) => {
    const key = node.key.trim();
    const instruction = node.instruction.trim();

    if (!NODE_KEY_PATTERN.test(key) || !instruction) {
      fail(
        'AGENT_GROUP_PLAN_INVALID_NODE',
        `Node ${sortOrder + 1} requires a valid key and non-empty instruction.`,
      );
    }
    if (seen.has(key)) {
      fail('AGENT_GROUP_PLAN_DUPLICATE_NODE', `Duplicate node key "${key}".`);
    }
    seen.add(key);

    if (!allowed.has(node.agentId)) {
      fail(
        'AGENT_GROUP_PLAN_AGENT_NOT_ALLOWED',
        `Agent "${node.agentId}" is not an enabled member of the group.`,
      );
    }

    const dependencies = node.dependencies ?? [];
    if (new Set(dependencies).size !== dependencies.length) {
      fail(
        'AGENT_GROUP_PLAN_DUPLICATE_DEPENDENCY',
        `Node "${key}" contains a duplicate dependency.`,
      );
    }
    const executionPolicy = node.executionPolicy
      ? {
          ...node.executionPolicy,
          ...(node.executionPolicy.baseRef?.trim()
            ? { baseRef: node.executionPolicy.baseRef.trim() }
            : {}),
          ...(node.executionPolicy.deviceId?.trim()
            ? { deviceId: node.executionPolicy.deviceId.trim() }
            : {}),
          ...(node.executionPolicy.workingDirectory?.trim()
            ? { workingDirectory: node.executionPolicy.workingDirectory.trim() }
            : {}),
          verification: node.executionPolicy.verification?.requirement?.trim()
            ? {
                requirement: node.executionPolicy.verification.requirement.trim(),
                verifierType: 'llm' as const,
              }
            : undefined,
        }
      : undefined;
    const codeMode = executionPolicy?.codeMode;
    if (
      codeMode !== undefined &&
      !['integrator', 'isolated_write', 'read_only'].includes(codeMode)
    ) {
      fail('AGENT_GROUP_PLAN_INVALID_NODE', `Node "${key}" has an invalid codeMode.`);
    }
    if (codeMode && (protocol !== 'pipeline' || executionPolicy?.runtimeKind !== 'heterogeneous')) {
      fail(
        'AGENT_GROUP_PLAN_INVALID_NODE',
        `Node "${key}" code collaboration requires a heterogeneous Pipeline member.`,
      );
    }
    if (codeMode === 'isolated_write' || codeMode === 'integrator') {
      if (
        policySnapshot?.requireHumanApprovalForWrites !== true ||
        executionPolicy?.executionTarget !== 'device' ||
        !executionPolicy.deviceId ||
        !executionPolicy.workingDirectory ||
        !executionPolicy.verification?.requirement
      ) {
        fail(
          'AGENT_GROUP_PLAN_INVALID_NODE',
          `Node "${key}" writes require approval, a pinned device repository, and Verify.`,
        );
      }
    }
    if (codeMode === 'integrator' && dependencies.length === 0) {
      fail('AGENT_GROUP_PLAN_INVALID_NODE', `Integrator node "${key}" requires dependencies.`);
    }

    const maxAttempts = node.maxAttempts ?? 1;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      fail('AGENT_GROUP_PLAN_INVALID_NODE', `Node "${key}" has an invalid maxAttempts.`);
    }
    if (
      node.timeoutMs !== undefined &&
      (!Number.isInteger(node.timeoutMs) || node.timeoutMs <= 0)
    ) {
      fail('AGENT_GROUP_PLAN_INVALID_NODE', `Node "${key}" has an invalid timeoutMs.`);
    }

    return {
      agentId: node.agentId,
      ...(node.barrierKey?.trim() ? { barrierKey: node.barrierKey.trim() } : {}),
      dependencies: [...dependencies],
      ...(executionPolicy ? { executionPolicy } : {}),
      instruction,
      key,
      maxAttempts,
      ...(node.role?.trim() ? { role: node.role.trim() } : {}),
      sortOrder,
      ...(node.timeoutMs ? { timeoutMs: node.timeoutMs } : {}),
      ...(node.toolPolicy ? { toolPolicy: node.toolPolicy } : {}),
    };
  });

  for (const node of normalizedNodes) {
    for (const dependency of node.dependencies) {
      if (dependency === node.key || !seen.has(dependency)) {
        fail(
          'AGENT_GROUP_PLAN_INVALID_DEPENDENCY',
          `Node "${node.key}" has invalid dependency "${dependency}".`,
        );
      }
    }
  }

  assertAcyclic(normalizedNodes);
  assertProtocolShape(protocol, normalizedNodes, debate);

  const planSnapshot: AgentGroupRunPlanSnapshot = {
    ...(debate ? { debate } : {}),
    nodes: normalizedNodes,
    protocol,
    supervisorAgentId,
    version: 1,
  };
  const planHash = createHash('sha256').update(JSON.stringify(planSnapshot)).digest('hex');

  return { planHash, planSnapshot };
};
