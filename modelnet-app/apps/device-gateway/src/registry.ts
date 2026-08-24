import type { GatewayDevice } from '@lobechat/device-gateway-client';
import type WebSocket from 'ws';

import { GatewayError } from './errors.js';
import type { SocketQuery } from './schemas.js';

export interface ConnectionRecord extends SocketQuery {
  connectedAt: number;
  expiresAt?: number;
  lastHeartbeatAt: number;
  principalId: string;
  principalKey: string;
  principalType: 'user' | 'workspace';
  socket: WebSocket;
}

type ConnectionMap = Map<string, ConnectionRecord>;
type DeviceMap = Map<string, ConnectionMap>;

const CHANNEL_PRIORITY = new Map<string, number>([
  ['desktop', 0],
  ['cli', 1],
  ['desktop-dev', 2],
  ['cli-dev', 3],
]);

const priority = (channel?: string): number => CHANNEL_PRIORITY.get(channel ?? '') ?? 4;

const compareConnections = (left: ConnectionRecord, right: ConnectionRecord): number => {
  const priorityDifference = priority(left.channel) - priority(right.channel);
  if (priorityDifference !== 0) return priorityDifference;
  return right.connectedAt - left.connectedAt;
};

export class ConnectionRegistry {
  private readonly principals = new Map<string, DeviceMap>();

  constructor(private readonly maxConnectionsPerPrincipal: number) {}

  add(record: ConnectionRecord): ConnectionRecord | undefined {
    const principalDevices = this.principals.get(record.principalKey) ?? new Map();
    let replaced: ConnectionRecord | undefined;

    for (const [deviceId, connections] of principalDevices) {
      const existing = connections.get(record.connectionId);
      if (existing) {
        replaced = existing;
        connections.delete(record.connectionId);
        if (connections.size === 0) principalDevices.delete(deviceId);
        break;
      }
    }

    if (
      !replaced &&
      this.countConnections(record.principalKey) >= this.maxConnectionsPerPrincipal
    ) {
      throw new GatewayError(
        429,
        'CONNECTION_LIMIT_EXCEEDED',
        'Principal connection limit exceeded',
      );
    }

    const deviceConnections = principalDevices.get(record.deviceId) ?? new Map();
    deviceConnections.set(record.connectionId, record);
    principalDevices.set(record.deviceId, deviceConnections);
    this.principals.set(record.principalKey, principalDevices);
    return replaced;
  }

  countConnections(principalKey: string): number {
    let count = 0;
    for (const connections of this.principals.get(principalKey)?.values() ?? []) {
      count += connections.size;
    }
    return count;
  }

  countDevices(principalKey: string): number {
    return this.principals.get(principalKey)?.size ?? 0;
  }

  listDevices(principalKey: string): GatewayDevice[] {
    const devices = this.principals.get(principalKey);
    if (!devices) return [];

    return [...devices.entries()]
      .map(([deviceId, connections]) => {
        const ordered = [...connections.values()].sort((left, right) => {
          return right.connectedAt - left.connectedAt;
        });
        const newest = ordered[0];
        return {
          channels: ordered.map(({ channel, connectedAt, connectionId }) => ({
            channel,
            connectedAt,
            connectionId,
          })),
          connectedAt: newest.connectedAt,
          deviceId,
          hostname: newest.hostname,
          platform: newest.platform,
        } satisfies GatewayDevice;
      })
      .sort((left, right) => right.connectedAt - left.connectedAt);
  }

  remove(record: ConnectionRecord): boolean {
    const devices = this.principals.get(record.principalKey);
    const connections = devices?.get(record.deviceId);
    if (connections?.get(record.connectionId) !== record) return false;

    connections.delete(record.connectionId);
    if (connections.size === 0) devices!.delete(record.deviceId);
    if (devices!.size === 0) this.principals.delete(record.principalKey);
    return true;
  }

  select(principalKey: string, deviceId?: string): ConnectionRecord {
    const devices = this.principals.get(principalKey);
    if (!devices || devices.size === 0) {
      throw new GatewayError(503, 'DEVICE_OFFLINE', 'No authenticated device connection is online');
    }

    let connections: ConnectionMap | undefined;
    if (deviceId) {
      connections = devices.get(deviceId);
      if (!connections?.size) {
        throw new GatewayError(503, 'DEVICE_OFFLINE', 'Requested device is offline');
      }
    } else if (devices.size === 1) {
      connections = devices.values().next().value;
    } else {
      throw new GatewayError(409, 'DEVICE_SELECTION_REQUIRED', 'Multiple devices are online');
    }

    const selected = [...(connections?.values() ?? [])].sort(compareConnections)[0];
    if (!selected) {
      throw new GatewayError(503, 'DEVICE_OFFLINE', 'No authenticated device connection is online');
    }
    return selected;
  }

  staleConnections(now: number, timeoutMs: number): ConnectionRecord[] {
    const stale: ConnectionRecord[] = [];
    for (const devices of this.principals.values()) {
      for (const connections of devices.values()) {
        for (const record of connections.values()) {
          if (now - record.lastHeartbeatAt > timeoutMs) stale.push(record);
        }
      }
    }
    return stale;
  }

  touch(record: ConnectionRecord, now = Date.now()): void {
    record.lastHeartbeatAt = now;
  }

  allConnections(): ConnectionRecord[] {
    const records: ConnectionRecord[] = [];
    for (const devices of this.principals.values()) {
      for (const connections of devices.values()) records.push(...connections.values());
    }
    return records;
  }
}
