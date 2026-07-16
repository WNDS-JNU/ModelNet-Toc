// @vitest-environment node

import { once } from 'node:events';

import {
  GatewayClient,
  GatewayHttpClient,
  type GatewayClientOptions,
} from '@lobechat/device-gateway-client';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { Authenticator } from '../src/auth.js';
import { startGatewayServer, type StartedGateway } from '../src/app.js';
import type { GatewayConfig } from '../src/config.js';
import { GatewayError } from '../src/errors.js';
import { silentLogger } from '../src/logger.js';

const serviceToken = 'service-token-which-is-at-least-32-bytes-long';

const baseConfig = (overrides: Partial<GatewayConfig> = {}): GatewayConfig => ({
  allowedServerOrigins: new Set(['https://modelnet.example.com']),
  authTimeoutMs: 100,
  heartbeatSweepMs: 20,
  heartbeatTimeoutMs: 90_000,
  host: '127.0.0.1',
  internalAppUrl: 'http://modelnet-app:3210',
  maxConnectionsPerPrincipal: 64,
  maxPayloadBytes: 1024 * 1024,
  maxPendingPerPrincipal: 256,
  maxRequestTimeoutMs: 300_000,
  oidcJwksUrl: 'http://modelnet-app:3210/oidc/jwks',
  port: 0,
  serviceToken,
  ...overrides,
});

const authenticator: Authenticator = {
  authenticate: async (message, query) => {
    if (message.token !== 'valid-token') {
      throw new GatewayError(401, 'AUTH_FAILED', 'Invalid token');
    }
    const principalId = query.workspaceId ?? query.userId!;
    return {
      principalId,
      principalKey: query.workspaceId ? `workspace:${principalId}` : `user:${principalId}`,
      principalType: query.workspaceId ? 'workspace' : 'user',
    };
  },
};

const waitFor = async (condition: () => boolean, timeoutMs = 1000): Promise<void> => {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const connectClient = async (options: GatewayClientOptions): Promise<GatewayClient> => {
  const client = new GatewayClient({ autoReconnect: false, ...options });
  const connected = new Promise<void>((resolve, reject) => {
    client.once('connected', resolve);
    client.once('auth_failed', (reason) => reject(new Error(reason)));
    client.once('error', reject);
  });
  await client.connect();
  await connected;
  return client;
};

const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    body: JSON.stringify(body),
    headers: {
      'Authorization': `Bearer ${serviceToken}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

const rawSocketUrl = (baseUrl: string): string => {
  const url = new URL('/ws', baseUrl);
  url.protocol = 'ws:';
  url.searchParams.set('channel', 'desktop');
  url.searchParams.set('connectionId', 'raw-connection');
  url.searchParams.set('deviceId', 'raw-device');
  url.searchParams.set('hostname', 'mac.local');
  url.searchParams.set('platform', 'darwin');
  url.searchParams.set('userId', 'user-1');
  return url.toString();
};

describe('Device Gateway protocol', () => {
  let started: StartedGateway | undefined;
  const clients: GatewayClient[] = [];
  const rawSockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.disconnect()));
    for (const socket of rawSockets.splice(0)) socket.terminate();
    if (started) await started.close();
    started = undefined;
  });

  it('closes a socket that misses the first-packet authentication deadline', async () => {
    started = await startGatewayServer({
      authenticator,
      config: baseConfig({ authTimeoutMs: 40 }),
      logger: silentLogger,
    });
    const socket = new WebSocket(rawSocketUrl(started.url));
    rawSockets.push(socket);
    const messages: unknown[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    const closed = once(socket, 'close');
    await once(socket, 'open');

    const [code, reason] = await closed;
    expect(code).toBe(4003);
    expect(reason.toString()).toBe('Authentication timeout');
    expect(messages).toContainEqual({ reason: 'AUTH_TIMEOUT', type: 'auth_failed' });
  });

  it('rejects HTTP and WebSocket payloads larger than 1 MiB', async () => {
    const maxPayloadBytes = 1024 * 1024;
    started = await startGatewayServer({
      authenticator,
      config: baseConfig({ maxPayloadBytes }),
      logger: silentLogger,
    });

    const httpResponse = await post(started.url, '/api/device/status', {
      padding: 'x'.repeat(maxPayloadBytes),
      userId: 'user-1',
    });
    expect(httpResponse.status).toBe(413);
    await expect(httpResponse.json()).resolves.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

    const socket = new WebSocket(rawSocketUrl(started.url));
    rawSockets.push(socket);
    const closed = once(socket, 'close');
    await once(socket, 'open');
    const authenticated = once(socket, 'message');
    socket.send(JSON.stringify({ token: 'valid-token', type: 'auth' }));
    const [authMessage] = await authenticated;
    expect(JSON.parse(authMessage.toString())).toEqual({ type: 'auth_success' });
    socket.send('x'.repeat(maxPayloadBytes + 1));

    const [code] = await closed;
    expect(code).toBe(1009);
  });

  it('relays the complete current protocol through real gateway clients', async () => {
    started = await startGatewayServer({
      authenticator,
      config: baseConfig(),
      logger: silentLogger,
    });
    const desktop = await connectClient({
      channel: 'desktop',
      connectionId: 'desktop-connection',
      deviceId: 'mac-device',
      gatewayUrl: started.url,
      token: 'valid-token',
      userId: 'user-1',
    });
    clients.push(desktop);

    desktop.on('tool_call_request', (request) => {
      desktop.sendToolCallResponse({
        requestId: request.requestId,
        result: { content: 'tool-ok', state: { directory: '/tmp' }, success: true },
      });
    });
    desktop.on('message_api_request', (request) => {
      desktop.sendMessageApiResponse({
        requestId: request.requestId,
        result: { content: 'message-ok', success: true },
      });
    });
    desktop.on('system_info_request', (request) => {
      desktop.sendSystemInfoResponse({
        requestId: request.requestId,
        result: {
          success: true,
          systemInfo: {
            arch: 'arm64',
            desktopPath: '/Users/test/Desktop',
            documentsPath: '/Users/test/Documents',
            downloadsPath: '/Users/test/Downloads',
            homePath: '/Users/test',
            musicPath: '/Users/test/Music',
            picturesPath: '/Users/test/Pictures',
            userDataPath: '/Users/test/Library/Application Support',
            videosPath: '/Users/test/Movies',
            workingDirectory: '/Users/test',
          },
        },
      });
    });
    desktop.on('rpc_request', (request) => {
      desktop.sendRpcResponse({
        requestId: request.requestId,
        result: { data: { initialized: true }, success: true },
      });
    });
    desktop.on('agent_run_request', (request) => {
      desktop.sendAgentRunAck({ operationId: request.operationId, status: 'accepted' });
    });

    const http = new GatewayHttpClient({ gatewayUrl: started.url, serviceToken });
    await expect(http.queryDeviceStatusStrict('user-1')).resolves.toEqual({
      deviceCount: 1,
      online: true,
    });
    await expect(http.queryDeviceListStrict('user-1')).resolves.toMatchObject([
      {
        channels: [{ channel: 'desktop', connectionId: 'desktop-connection' }],
        deviceId: 'mac-device',
      },
    ]);

    await expect(
      http.executeMcpCall({
        apiName: 'listDirectory',
        arguments: '{}',
        deviceId: 'mac-device',
        identifier: 'local-system',
        params: { args: [], command: 'safe-readonly-command', name: 'readonly', type: 'stdio' },
        timeout: 1000,
        userId: 'user-1',
      }),
    ).resolves.toEqual({
      content: 'tool-ok',
      error: undefined,
      state: { directory: '/tmp' },
      success: true,
    });
    await expect(
      http.executeMessageApi(
        { deviceId: 'mac-device', userId: 'user-1' },
        { apiName: 'getChats', payload: {}, platform: 'wechat' },
      ),
    ).resolves.toMatchObject({ content: 'message-ok', success: true });
    await expect(
      http.invokeRpc(
        { deviceId: 'mac-device', userId: 'user-1' },
        { method: 'initWorkspace', params: { readonly: true } },
      ),
    ).resolves.toEqual({ data: { initialized: true }, error: undefined, success: true });
    await expect(http.getDeviceSystemInfo('user-1', 'mac-device')).resolves.toMatchObject({
      success: true,
      systemInfo: { arch: 'arm64', homePath: '/Users/test' },
    });
    await expect(
      http.dispatchAgentRun({
        agentType: 'codex',
        deviceId: 'mac-device',
        jwt: 'operation-jwt',
        operationId: 'operation-1',
        prompt: 'read only',
        topicId: 'topic-1',
        userId: 'user-1',
      }),
    ).resolves.toEqual({ success: true });
  });

  it('aggregates channels, prefers desktop, replaces reconnects, and isolates workspace', async () => {
    started = await startGatewayServer({
      authenticator,
      config: baseConfig(),
      logger: silentLogger,
    });
    const desktop = await connectClient({
      channel: 'desktop',
      connectionId: 'desktop-connection',
      deviceId: 'mac-device',
      gatewayUrl: started.url,
      token: 'valid-token',
      userId: 'user-1',
    });
    const cli = await connectClient({
      channel: 'cli',
      connectionId: 'cli-connection',
      deviceId: 'mac-device',
      gatewayUrl: started.url,
      token: 'valid-token',
      userId: 'user-1',
    });
    const workspace = await connectClient({
      channel: 'desktop',
      connectionId: 'workspace-connection',
      deviceId: 'workspace-device',
      gatewayUrl: started.url,
      token: 'valid-token',
      workspaceId: 'workspace-1',
    });
    clients.push(desktop, cli, workspace);

    let desktopCalls = 0;
    let cliCalls = 0;
    let workspaceCalls = 0;
    desktop.on('tool_call_request', (request) => {
      desktopCalls += 1;
      desktop.sendToolCallResponse({
        requestId: request.requestId,
        result: { content: 'desktop', success: true },
      });
    });
    cli.on('tool_call_request', (request) => {
      cliCalls += 1;
      cli.sendToolCallResponse({
        requestId: request.requestId,
        result: { content: 'cli', success: true },
      });
    });
    workspace.on('tool_call_request', (request) => {
      workspaceCalls += 1;
      expect(request.operationId).toBe('workspace-operation');
      expect(request.timeout).toBe(42_000);
      expect(request.toolCall).toMatchObject({
        apiName: 'getStock',
        params: { args: ['stock-mcp'], command: 'npx', name: 'stock-mcp', type: 'stdio' },
        type: 'mcp',
      });
      workspace.sendToolCallResponse({
        requestId: request.requestId,
        result: { content: 'workspace-mcp', state: { rows: 3 }, success: true },
      });
    });

    const http = new GatewayHttpClient({ gatewayUrl: started.url, serviceToken });
    await expect(http.queryDeviceListStrict('user-1')).resolves.toMatchObject([
      {
        channels: expect.arrayContaining([
          expect.objectContaining({ channel: 'desktop' }),
          expect.objectContaining({ channel: 'cli' }),
        ]),
        deviceId: 'mac-device',
      },
    ]);
    await expect(
      http.executeToolCall(
        { deviceId: 'mac-device', userId: 'user-1' },
        { apiName: 'readDirectory', arguments: '{}', identifier: 'local-system' },
      ),
    ).resolves.toMatchObject({ content: 'desktop', success: true });
    expect(desktopCalls).toBe(1);
    expect(cliCalls).toBe(0);

    await expect(http.queryDeviceListStrict('user-1', 'workspace-1')).resolves.toMatchObject([
      { deviceId: 'workspace-device' },
    ]);
    await expect(http.queryDeviceListStrict('user-1')).resolves.not.toMatchObject([
      { deviceId: 'workspace-device' },
    ]);
    await expect(
      http.executeMcpCall({
        apiName: 'getStock',
        arguments: '{}',
        deviceId: 'workspace-device',
        identifier: 'stock-mcp',
        operationId: 'workspace-operation',
        params: { args: ['stock-mcp'], command: 'npx', name: 'stock-mcp', type: 'stdio' },
        timeout: 42_000,
        userId: 'user-1',
        workspaceId: 'workspace-1',
      }),
    ).resolves.toEqual({
      content: 'workspace-mcp',
      error: undefined,
      state: { rows: 3 },
      success: true,
    });
    expect(workspaceCalls).toBe(1);
    expect(desktopCalls).toBe(1);
    expect(cliCalls).toBe(0);

    const replacement = await connectClient({
      channel: 'desktop',
      connectionId: 'desktop-connection',
      deviceId: 'mac-device',
      gatewayUrl: started.url,
      token: 'valid-token',
      userId: 'user-1',
    });
    clients.push(replacement);
    await waitFor(() => started!.gateway.registry.countConnections('user:user-1') === 2);
    await expect(http.queryDeviceListStrict('user-1')).resolves.toMatchObject([
      { channels: expect.arrayContaining([expect.objectContaining({ channel: 'desktop' })]) },
    ]);
  });

  it('enforces service auth, pending limits, request timeout, and disconnect cleanup', async () => {
    started = await startGatewayServer({
      authenticator,
      config: baseConfig({ maxPendingPerPrincipal: 1, maxRequestTimeoutMs: 100 }),
      logger: silentLogger,
    });
    const desktop = await connectClient({
      channel: 'desktop',
      connectionId: 'desktop-connection',
      deviceId: 'mac-device',
      gatewayUrl: started.url,
      token: 'valid-token',
      userId: 'user-1',
    });
    clients.push(desktop);

    const unauthorized = await fetch(`${started.url}/api/device/status`, {
      body: JSON.stringify({ userId: 'user-1' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(unauthorized.status).toBe(401);

    const first = post(started.url, '/api/device/tool-call', {
      deviceId: 'mac-device',
      timeout: 100,
      toolCall: { apiName: 'wait', arguments: '{}', identifier: 'local-system', type: 'tool' },
      userId: 'user-1',
    });
    await waitFor(() => true, 1);
    const second = await post(started.url, '/api/device/tool-call', {
      deviceId: 'mac-device',
      timeout: 100,
      toolCall: { apiName: 'wait', arguments: '{}', identifier: 'local-system', type: 'tool' },
      userId: 'user-1',
    });
    expect(second.status).toBe(429);
    expect((await second.json()) as object).toMatchObject({ code: 'PENDING_LIMIT_EXCEEDED' });

    const timedOut = await first;
    expect(timedOut.status).toBe(504);
    expect((await timedOut.json()) as object).toMatchObject({ code: 'DEVICE_REQUEST_TIMEOUT' });

    const disconnected = post(started.url, '/api/device/tool-call', {
      deviceId: 'mac-device',
      timeout: 100,
      toolCall: { apiName: 'wait', arguments: '{}', identifier: 'local-system', type: 'tool' },
      userId: 'user-1',
    });
    await desktop.disconnect();
    const disconnectedResponse = await disconnected;
    expect(disconnectedResponse.status).toBe(503);
    expect((await disconnectedResponse.json()) as object).toMatchObject({
      code: expect.stringMatching(/DEVICE_(DISCONNECTED|OFFLINE)/),
    });
  });

  it('removes connections that miss the heartbeat deadline', async () => {
    started = await startGatewayServer({
      authenticator,
      config: baseConfig({ heartbeatSweepMs: 10, heartbeatTimeoutMs: 30 }),
      logger: silentLogger,
    });
    const desktop = await connectClient({
      channel: 'desktop',
      connectionId: 'desktop-connection',
      deviceId: 'mac-device',
      gatewayUrl: started.url,
      token: 'valid-token',
      userId: 'user-1',
    });
    clients.push(desktop);

    await waitFor(() => started!.gateway.registry.countDevices('user:user-1') === 0);
    const http = new GatewayHttpClient({ gatewayUrl: started.url, serviceToken });
    await expect(http.queryDeviceStatusStrict('user-1')).resolves.toEqual({
      deviceCount: 0,
      online: false,
    });
  });
});
