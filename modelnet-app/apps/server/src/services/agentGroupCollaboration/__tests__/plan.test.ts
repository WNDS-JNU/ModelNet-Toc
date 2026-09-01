// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildFixedRoundDebatePlan } from '../debate';
import type { AgentGroupPlanValidationError, CompileAgentGroupRunPlanInput } from '../plan';
import { compileAgentGroupRunPlan } from '../plan';

const supervisorAgentId = 'supervisor';
const memberAgentId = 'member';
const judgeAgentId = 'judge';

const compile = (overrides: Partial<CompileAgentGroupRunPlanInput> = {}) =>
  compileAgentGroupRunPlan({
    allowedAgentIds: [supervisorAgentId, memberAgentId, judgeAgentId],
    nodes: [{ agentId: memberAgentId, instruction: 'Do the work', key: 'work' }],
    protocol: 'single',
    supervisorAgentId,
    ...overrides,
  });

const expectCode = (run: () => unknown, code: AgentGroupPlanValidationError['code']) => {
  expect(run).toThrowError(expect.objectContaining({ code }));
};

describe('compileAgentGroupRunPlan', () => {
  it('normalizes a plan and produces a stable SHA-256 hash', () => {
    const first = compile({
      nodes: [
        {
          agentId: memberAgentId,
          barrierKey: ' final ',
          instruction: '  Do the work  ',
          key: ' work ',
          role: ' researcher ',
        },
      ],
    });
    const second = compile({
      nodes: [
        {
          agentId: memberAgentId,
          barrierKey: ' final ',
          instruction: '  Do the work  ',
          key: ' work ',
          role: ' researcher ',
        },
      ],
    });

    expect(first).toEqual(second);
    expect(first.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.planSnapshot).toEqual({
      nodes: [
        {
          agentId: memberAgentId,
          barrierKey: 'final',
          dependencies: [],
          instruction: 'Do the work',
          key: 'work',
          maxAttempts: 1,
          role: 'researcher',
          sortOrder: 0,
        },
      ],
      protocol: 'single',
      supervisorAgentId,
      version: 1,
    });
  });

  it('accepts a valid pipeline DAG', () => {
    const result = compile({
      nodes: [
        { agentId: memberAgentId, instruction: 'Research', key: 'research' },
        {
          agentId: supervisorAgentId,
          dependencies: ['research'],
          instruction: 'Synthesize',
          key: 'synthesize',
          maxAttempts: 2,
          timeoutMs: 30_000,
        },
      ],
      protocol: 'pipeline',
    });

    expect(result.planSnapshot.nodes[1]).toMatchObject({
      dependencies: ['research'],
      maxAttempts: 2,
      sortOrder: 1,
      timeoutMs: 30_000,
    });
  });

  it('rejects an empty plan and an invalid supervisor', () => {
    expectCode(() => compile({ nodes: [] }), 'AGENT_GROUP_PLAN_EMPTY');
    expectCode(
      () => compile({ allowedAgentIds: [memberAgentId] }),
      'AGENT_GROUP_PLAN_INVALID_SUPERVISOR',
    );
  });

  it('rejects duplicate or malformed node keys', () => {
    expectCode(
      () =>
        compile({
          nodes: [
            { agentId: memberAgentId, instruction: 'One', key: 'same' },
            { agentId: judgeAgentId, instruction: 'Two', key: 'same' },
          ],
          protocol: 'pipeline',
        }),
      'AGENT_GROUP_PLAN_DUPLICATE_NODE',
    );
    expectCode(
      () => compile({ nodes: [{ agentId: memberAgentId, instruction: '', key: 'bad key' }] }),
      'AGENT_GROUP_PLAN_INVALID_NODE',
    );
  });

  it('rejects agents outside the enabled roster', () => {
    expectCode(
      () => compile({ nodes: [{ agentId: 'outsider', instruction: 'Work', key: 'work' }] }),
      'AGENT_GROUP_PLAN_AGENT_NOT_ALLOWED',
    );
  });

  it('rejects duplicate, missing, and self dependencies', () => {
    expectCode(
      () =>
        compile({
          nodes: [
            {
              agentId: memberAgentId,
              dependencies: ['missing', 'missing'],
              instruction: 'Work',
              key: 'work',
            },
          ],
          protocol: 'pipeline',
        }),
      'AGENT_GROUP_PLAN_DUPLICATE_DEPENDENCY',
    );
    expectCode(
      () =>
        compile({
          nodes: [
            {
              agentId: memberAgentId,
              dependencies: ['missing'],
              instruction: 'Work',
              key: 'work',
            },
          ],
          protocol: 'pipeline',
        }),
      'AGENT_GROUP_PLAN_INVALID_DEPENDENCY',
    );
    expectCode(
      () =>
        compile({
          nodes: [
            {
              agentId: memberAgentId,
              dependencies: ['work'],
              instruction: 'Work',
              key: 'work',
            },
          ],
          protocol: 'pipeline',
        }),
      'AGENT_GROUP_PLAN_INVALID_DEPENDENCY',
    );
  });

  it('rejects dependency cycles', () => {
    expectCode(
      () =>
        compile({
          nodes: [
            {
              agentId: memberAgentId,
              dependencies: ['second'],
              instruction: 'First',
              key: 'first',
            },
            {
              agentId: judgeAgentId,
              dependencies: ['first'],
              instruction: 'Second',
              key: 'second',
            },
          ],
          protocol: 'pipeline',
        }),
      'AGENT_GROUP_PLAN_CYCLE',
    );
  });

  it('enforces protocol-specific shapes', () => {
    expectCode(
      () =>
        compile({
          nodes: [
            { agentId: memberAgentId, instruction: 'One', key: 'one' },
            { agentId: judgeAgentId, instruction: 'Two', key: 'two' },
          ],
        }),
      'AGENT_GROUP_PLAN_INVALID_PROTOCOL_SHAPE',
    );
    expectCode(
      () =>
        compile({
          nodes: [
            { agentId: memberAgentId, instruction: 'One', key: 'one' },
            {
              agentId: judgeAgentId,
              dependencies: ['one'],
              instruction: 'Two',
              key: 'two',
            },
          ],
          protocol: 'broadcast',
        }),
      'AGENT_GROUP_PLAN_INVALID_PROTOCOL_SHAPE',
    );
  });

  it('normalizes an approved isolated-write execution policy', () => {
    const result = compile({
      nodes: [
        {
          agentId: memberAgentId,
          executionPolicy: {
            baseRef: ' main ',
            codeMode: 'isolated_write',
            deviceId: ' device-1 ',
            executionTarget: 'device',
            runtimeKind: 'heterogeneous',
            verification: { requirement: ' tests pass ' },
            workingDirectory: ' /repo ',
          },
          instruction: 'Implement the change',
          key: 'write',
        },
      ],
      policySnapshot: { requireHumanApprovalForWrites: true },
      protocol: 'pipeline',
    });

    expect(result.planSnapshot.nodes[0].executionPolicy).toEqual({
      baseRef: 'main',
      codeMode: 'isolated_write',
      deviceId: 'device-1',
      executionTarget: 'device',
      runtimeKind: 'heterogeneous',
      verification: { requirement: 'tests pass', verifierType: 'llm' },
      workingDirectory: '/repo',
    });
  });

  it('rejects unsafe code-write policies and dependency-free integrators', () => {
    const isolatedWriteNode: CompileAgentGroupRunPlanInput['nodes'][number] = {
      agentId: memberAgentId,
      executionPolicy: {
        codeMode: 'isolated_write',
        deviceId: 'device-1',
        executionTarget: 'device',
        runtimeKind: 'heterogeneous',
        verification: { requirement: 'tests pass' },
        workingDirectory: '/repo',
      },
      instruction: 'Implement the change',
      key: 'write',
    };

    expectCode(
      () => compile({ nodes: [isolatedWriteNode], protocol: 'pipeline' }),
      'AGENT_GROUP_PLAN_INVALID_NODE',
    );
    expectCode(
      () =>
        compile({
          nodes: [
            {
              ...isolatedWriteNode,
              executionPolicy: {
                ...isolatedWriteNode.executionPolicy,
                verification: { requirement: '   ' },
              },
            },
          ],
          policySnapshot: { requireHumanApprovalForWrites: true },
          protocol: 'pipeline',
        }),
      'AGENT_GROUP_PLAN_INVALID_NODE',
    );
    expectCode(
      () =>
        compile({
          nodes: [
            {
              ...isolatedWriteNode,
              executionPolicy: {
                ...isolatedWriteNode.executionPolicy,
                codeMode: 'integrator',
              },
            },
          ],
          policySnapshot: { requireHumanApprovalForWrites: true },
          protocol: 'pipeline',
        }),
      'AGENT_GROUP_PLAN_INVALID_NODE',
    );
  });

  it('requires a fixed-round Debate DAG with one distinct final Judge', () => {
    expectCode(
      () =>
        compile({
          nodes: [
            { agentId: memberAgentId, instruction: 'Argue', key: 'one' },
            { agentId: judgeAgentId, instruction: 'Argue', key: 'two' },
          ],
          protocol: 'debate',
        }),
      'AGENT_GROUP_PLAN_INVALID_DEBATE',
    );

    const debatePlan = buildFixedRoundDebatePlan({
      judgeAgentId,
      motion: 'Should the system prefer deterministic orchestration?',
      participants: [
        { agentId: memberAgentId, perspective: 'Support determinism' },
        { agentId: supervisorAgentId, perspective: 'Challenge determinism' },
      ],
      rounds: 2,
    });
    const result = compile({
      ...debatePlan,
      protocol: 'debate',
    });

    expect(result.planSnapshot.debate).toEqual({
      judgeAgentId,
      participantAgentIds: [memberAgentId, supervisorAgentId],
      rounds: 2,
      termination: 'fixed_rounds',
    });
    expect(result.planSnapshot.nodes).toHaveLength(5);
    expect(result.planSnapshot.nodes.at(-1)).toMatchObject({
      dependencies: ['debate-r2-p1', 'debate-r2-p2'],
      key: 'debate-judge',
      role: 'judge',
      toolPolicy: { disableTools: true },
    });

    expectCode(
      () =>
        compile({
          ...debatePlan,
          debate: { ...debatePlan.debate, rounds: 3 },
          protocol: 'debate',
        }),
      'AGENT_GROUP_PLAN_INVALID_DEBATE',
    );
  });
});
