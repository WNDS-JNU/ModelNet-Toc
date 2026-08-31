// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recoverGroupRuns } from '../recoverGroupRuns';

const mocks = vi.hoisted(() => ({
  coordinator: vi.fn(),
  getServerDB: vi.fn(),
  sweepOnce: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: mocks.getServerDB,
}));

vi.mock('@/server/services/agentGroupCollaboration/recovery', () => ({
  AgentGroupRunRecoveryCoordinator: mocks.coordinator,
}));

const buildContext = (body?: unknown, jsonThrows = false) => {
  const captures: Array<{ body: any; status: number }> = [];
  const ctx = {
    json: (value: any, status = 200) => {
      captures.push({ body: value, status });
      return Response.json(value, { status });
    },
    req: {
      json: jsonThrows
        ? async () => {
            throw new Error('invalid json');
          }
        : async () => body,
    },
  } as any;

  return { captures, ctx };
};

describe('recoverGroupRuns handler', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_GROUP_DURABLE_RUNS', '1');
    mocks.getServerDB.mockReset().mockResolvedValue({ id: 'db' });
    mocks.sweepOnce.mockReset().mockResolvedValue({
      cancelled: 1,
      failedRunIds: [],
      reconciled: 2,
      scanned: 3,
      timedOut: 1,
    });
    mocks.coordinator.mockReset().mockImplementation(() => ({ sweepOnce: mocks.sweepOnce }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips without touching the database when durable runs are disabled', async () => {
    vi.stubEnv('AGENT_GROUP_DURABLE_RUNS', '0');
    const { captures, ctx } = buildContext({ limit: 25 });

    const response = await recoverGroupRuns(ctx);

    expect(response.status).toBe(200);
    expect(captures[0].body).toEqual({ enabled: false, skipped: true });
    expect(mocks.getServerDB).not.toHaveBeenCalled();
  });

  it('runs one sweep with the requested batch size', async () => {
    const { captures, ctx } = buildContext({ limit: 25 });

    const response = await recoverGroupRuns(ctx);

    expect(response.status).toBe(200);
    expect(mocks.coordinator).toHaveBeenCalledWith({ id: 'db' }, { limit: 25 });
    expect(mocks.sweepOnce).toHaveBeenCalledTimes(1);
    expect(captures[0].body).toMatchObject({ enabled: true, reconciled: 2, scanned: 3 });
  });

  it('uses a bounded batch when the body is malformed or too large', async () => {
    const malformed = buildContext(undefined, true);
    await recoverGroupRuns(malformed.ctx);
    expect(mocks.coordinator).toHaveBeenLastCalledWith({ id: 'db' }, { limit: 100 });

    const oversized = buildContext({ limit: 10_000 });
    await recoverGroupRuns(oversized.ctx);
    expect(mocks.coordinator).toHaveBeenLastCalledWith({ id: 'db' }, { limit: 500 });
  });
});
