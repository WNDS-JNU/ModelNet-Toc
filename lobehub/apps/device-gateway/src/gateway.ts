import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type {
  AgentRunAckMessage,
  ClientMessage,
  ServerMessage,
} from '@lobechat/device-gateway-client';
import WebSocket, { type RawData, WebSocketServer } from 'ws';

import type { Authenticator } from './auth.js';
import type { GatewayConfig } from './config.js';
import { GatewayError, asGatewayError } from './errors.js';
import type { GatewayLogger } from './logger.js';
import { ConnectionRegistry, type ConnectionRecord } from './registry.js';
import { authMessageSchema, socketQuerySchema, type SocketQuery } from './schemas.js';

interface SocketSession {
  authTimer: ReturnType<typeof setTimeout>;
  authenticating: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
  query: SocketQuery;
  record?: ConnectionRecord;
}

type ResponseMessageType =
  | 'agent_run_ack'
  | 'message_api_response'
  | 'rpc_response'
  | 'system_info_response'
  | 'tool_call_response';

interface PendingRequest<T> {
  correlationId: string;
  principalKey: string;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
  responseType: ResponseMessageType;
  socket: WebSocket;
  timer: ReturnType<typeof setTimeout>;
}

export interface RelayRequest<T> {
  correlationId?: string;
  deviceId?: string;
  message: ServerMessage;
  principalKey: string;
  responseType: ResponseMessageType;
  timeoutMs: number;
}

const rejectUpgrade = (socket: Duplex, status: number, message: string): void => {
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }
};

const queryFromRequest = (request: IncomingMessage): SocketQuery => {
  const url = new URL(request.url ?? '/', 'http://gateway.internal');
  if (url.pathname !== '/ws') throw new GatewayError(404, 'NOT_FOUND', 'Not found');
  return socketQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
};

const safeSend = (socket: WebSocket, message: ServerMessage): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};

export class DeviceGateway {
  readonly registry: ConnectionRegistry;
  readonly webSocketServer: WebSocketServer;

  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly pendingByPrincipal = new Map<string, number>();
  private readonly sessions = new WeakMap<WebSocket, SocketSession>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: GatewayConfig,
    private readonly authenticator: Authenticator,
    private readonly logger: GatewayLogger,
  ) {
    this.registry = new ConnectionRegistry(config.maxConnectionsPerPrincipal);
    this.webSocketServer = new WebSocketServer({
      maxPayload: config.maxPayloadBytes,
      noServer: true,
    });
    this.sweepTimer = setInterval(() => this.sweepStaleConnections(), config.heartbeatSweepMs);
    this.sweepTimer.unref();
  }

  handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let query: SocketQuery;
    try {
      query = queryFromRequest(request);
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }

    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.acceptSocket(webSocket, query);
    });
  };

  async relay<T>(request: RelayRequest<T>): Promise<T> {
    if (
      (this.pendingByPrincipal.get(request.principalKey) ?? 0) >= this.config.maxPendingPerPrincipal
    ) {
      throw new GatewayError(
        429,
        'PENDING_LIMIT_EXCEEDED',
        'Principal pending request limit exceeded',
      );
    }

    const record = this.registry.select(request.principalKey, request.deviceId);
    const correlationId = request.correlationId ?? randomUUID();
    const pendingKey = this.pendingKey(request.principalKey, request.responseType, correlationId);
    if (this.pending.has(pendingKey)) {
      throw new GatewayError(
        409,
        'REQUEST_ALREADY_PENDING',
        'Request correlation id already pending',
      );
    }

    const timeoutMs = Math.min(
      Math.max(Math.trunc(request.timeoutMs), 0),
      this.config.maxRequestTimeoutMs,
    );
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.deletePending(pendingKey);
        reject(new GatewayError(504, 'DEVICE_REQUEST_TIMEOUT', 'Device request timed out'));
      }, timeoutMs);

      const pending: PendingRequest<T> = {
        correlationId,
        principalKey: request.principalKey,
        reject,
        resolve,
        responseType: request.responseType,
        socket: record.socket,
        timer,
      };
      this.pending.set(pendingKey, pending as PendingRequest<unknown>);
      this.incrementPending(request.principalKey);

      try {
        if (record.socket.readyState !== WebSocket.OPEN) {
          throw new GatewayError(503, 'DEVICE_OFFLINE', 'Selected device connection is closed');
        }
        record.socket.send(JSON.stringify(request.message));
      } catch (error) {
        this.deletePending(pendingKey);
        reject(asGatewayError(error));
      }
    });
  }

  close(): Promise<void> {
    clearInterval(this.sweepTimer);
    for (const connection of this.registry.allConnections()) {
      connection.socket.close(1001, 'Gateway shutdown');
    }
    for (const [key, pending] of this.pending) {
      this.deletePending(key);
      pending.reject(new GatewayError(503, 'GATEWAY_SHUTDOWN', 'Gateway is shutting down'));
    }
    return new Promise((resolve) => this.webSocketServer.close(() => resolve()));
  }

  private acceptSocket(socket: WebSocket, query: SocketQuery): void {
    const authTimer = setTimeout(() => {
      safeSend(socket, { reason: 'AUTH_TIMEOUT', type: 'auth_failed' });
      socket.close(4003, 'Authentication timeout');
    }, this.config.authTimeoutMs);
    const session: SocketSession = { authTimer, authenticating: false, query };
    this.sessions.set(socket, session);

    socket.on('message', (data, isBinary) => void this.handleMessage(socket, data, isBinary));
    socket.on('close', () => this.handleClose(socket));
    socket.on('error', () => {
      // The close handler owns cleanup. Never log frame contents or credentials.
    });
  }

  private async handleMessage(socket: WebSocket, data: RawData, isBinary: boolean): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session) return;
    if (isBinary) {
      socket.close(1003, 'Text messages only');
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      socket.close(1007, 'Invalid JSON');
      return;
    }

    if (!session.record) {
      if (session.authenticating) return;
      const parsed = authMessageSchema.safeParse(message);
      if (!parsed.success) {
        safeSend(socket, { reason: 'AUTH_REQUIRED', type: 'auth_failed' });
        socket.close(4003, 'Authentication required');
        return;
      }
      session.authenticating = true;
      try {
        const auth = await this.authenticator.authenticate(parsed.data, session.query);
        if (socket.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        const record: ConnectionRecord = {
          ...session.query,
          ...auth,
          connectedAt: now,
          lastHeartbeatAt: now,
          socket,
        };
        const replaced = this.registry.add(record);
        session.record = record;
        clearTimeout(session.authTimer);
        if (replaced) {
          this.cancelPendingForSocket(replaced.socket, 'Connection replaced by reconnect');
          replaced.socket.close(4001, 'Connection replaced');
        }
        if (record.expiresAt) {
          const expiresIn = record.expiresAt - now;
          if (expiresIn <= 0)
            throw new GatewayError(401, 'AUTH_EXPIRED', 'Authentication token expired');
          session.expiryTimer = setTimeout(() => {
            safeSend(socket, { type: 'auth_expired' });
            socket.close(4003, 'Authentication expired');
          }, expiresIn);
        }
        safeSend(socket, { type: 'auth_success' });
        this.logger.info('device connection authenticated', {
          channel: record.channel ?? 'other',
          principalType: record.principalType,
        });
      } catch (error) {
        const gatewayError = asGatewayError(error);
        safeSend(socket, { reason: gatewayError.code, type: 'auth_failed' });
        socket.close(4003, 'Authentication failed');
      } finally {
        session.authenticating = false;
      }
      return;
    }

    const clientMessage = message as Partial<ClientMessage>;
    if (clientMessage.type === 'heartbeat') {
      this.registry.touch(session.record);
      safeSend(socket, { type: 'heartbeat_ack' });
      return;
    }

    this.resolveResponse(session.record, clientMessage);
  }

  private handleClose(socket: WebSocket): void {
    const session = this.sessions.get(socket);
    if (!session) return;
    clearTimeout(session.authTimer);
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    if (session.record) {
      this.registry.remove(session.record);
      this.cancelPendingForSocket(socket, 'Device disconnected');
      this.logger.info('device connection closed', {
        channel: session.record.channel ?? 'other',
        principalType: session.record.principalType,
      });
    }
  }

  private resolveResponse(record: ConnectionRecord, message: Partial<ClientMessage>): void {
    let responseType: ResponseMessageType | undefined;
    let correlationId: string | undefined;
    let result: unknown;

    switch (message.type) {
      case 'tool_call_response':
      case 'message_api_response':
      case 'rpc_response':
      case 'system_info_response': {
        responseType = message.type;
        correlationId = 'requestId' in message ? message.requestId : undefined;
        result = 'result' in message ? message.result : undefined;
        break;
      }
      case 'agent_run_ack': {
        responseType = message.type;
        const ack = message as Partial<AgentRunAckMessage>;
        correlationId = ack.operationId;
        result = ack;
        break;
      }
      default: {
        return;
      }
    }
    if (!correlationId || !responseType) return;

    const key = this.pendingKey(record.principalKey, responseType, correlationId);
    const pending = this.pending.get(key);
    if (!pending || pending.socket !== record.socket) return;
    this.deletePending(key);
    pending.resolve(result);
  }

  private pendingKey(
    principalKey: string,
    responseType: ResponseMessageType,
    correlationId: string,
  ): string {
    return `${principalKey}\u0000${responseType}\u0000${correlationId}`;
  }

  private incrementPending(principalKey: string): void {
    this.pendingByPrincipal.set(principalKey, (this.pendingByPrincipal.get(principalKey) ?? 0) + 1);
  }

  private deletePending(key: string): PendingRequest<unknown> | undefined {
    const pending = this.pending.get(key);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    const count = (this.pendingByPrincipal.get(pending.principalKey) ?? 1) - 1;
    if (count <= 0) this.pendingByPrincipal.delete(pending.principalKey);
    else this.pendingByPrincipal.set(pending.principalKey, count);
    return pending;
  }

  private cancelPendingForSocket(socket: WebSocket, message: string): void {
    for (const [key, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      this.deletePending(key);
      pending.reject(new GatewayError(503, 'DEVICE_DISCONNECTED', message));
    }
  }

  private sweepStaleConnections(): void {
    for (const record of this.registry.staleConnections(
      Date.now(),
      this.config.heartbeatTimeoutMs,
    )) {
      this.registry.remove(record);
      this.cancelPendingForSocket(record.socket, 'Device heartbeat expired');
      record.socket.close(4000, 'Heartbeat timeout');
    }
  }
}
