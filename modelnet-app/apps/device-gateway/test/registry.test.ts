// @vitest-environment node

import type WebSocket from 'ws';
import { describe, expect, it } from 'vitest';

import { ConnectionRegistry, type ConnectionRecord } from '../src/registry.js';

const record = (connectionId: string, channel: string, connectedAt: number): ConnectionRecord => ({
  channel,
  connectedAt,
  connectionId,
  deviceId: 'device-1',
  hostname: 'mac.local',
  lastHeartbeatAt: connectedAt,
  platform: 'darwin',
  principalId: 'user-1',
  principalKey: 'user:user-1',
  principalType: 'user',
  socket: {} as WebSocket,
  userId: 'user-1',
});

describe('ConnectionRegistry', () => {
  it('enforces the per-principal connection limit but permits reconnect replacement', () => {
    const registry = new ConnectionRegistry(2);
    const desktop = record('desktop-connection', 'desktop', 100);
    registry.add(desktop);
    registry.add(record('cli-connection', 'cli', 200));

    expect(() => registry.add(record('third-connection', 'desktop-dev', 300))).toThrowError(
      expect.objectContaining({ code: 'CONNECTION_LIMIT_EXCEEDED' }),
    );

    const replacement = record('desktop-connection', 'desktop', 400);
    expect(registry.add(replacement)).toBe(desktop);
    expect(registry.countConnections('user:user-1')).toBe(2);
    expect(registry.select('user:user-1')).toBe(replacement);
  });

  it('uses desktop > cli > desktop-dev > cli-dev > other priority before recency', () => {
    const registry = new ConnectionRegistry(10);
    registry.add(record('other', 'custom', 500));
    registry.add(record('cli-dev', 'cli-dev', 600));
    registry.add(record('desktop-dev', 'desktop-dev', 700));
    registry.add(record('cli', 'cli', 800));
    const desktop = record('desktop', 'desktop', 100);
    registry.add(desktop);

    expect(registry.select('user:user-1')).toBe(desktop);
  });
});
