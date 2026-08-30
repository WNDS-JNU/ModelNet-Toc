import { createHash } from 'node:crypto';

import type {
  AgentGroupRunPlanNodeInput,
  AgentGroupRunPlanNodeSnapshot,
  AgentGroupRunPlanSnapshot,
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
  nodes: AgentGroupRunPlanNodeInput[];
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
    const judgeCount = nodes.filter((node) => node.role === 'judge').length;
    if (nodes.length < 3 || judgeCount !== 1) {
      fail(
        'AGENT_GROUP_PLAN_INVALID_DEBATE',
        'debate requires at least two participants and exactly one judge node.',
      );
    }
  }
};

export const compileAgentGroupRunPlan = ({
  allowedAgentIds,
  nodes,
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
      ...(node.executionPolicy ? { executionPolicy: node.executionPolicy } : {}),
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
  assertProtocolShape(protocol, normalizedNodes);

  const planSnapshot: AgentGroupRunPlanSnapshot = {
    nodes: normalizedNodes,
    protocol,
    supervisorAgentId,
    version: 1,
  };
  const planHash = createHash('sha256').update(JSON.stringify(planSnapshot)).digest('hex');

  return { planHash, planSnapshot };
};
