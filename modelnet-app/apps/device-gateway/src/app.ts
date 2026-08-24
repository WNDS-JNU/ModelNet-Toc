import { once } from 'node:events';
import { serve, type ServerType } from '@hono/node-server';
import type {
  AgentRunRequestMessage,
  MessageApiRequestMessage,
  RpcRequestMessage,
  SystemInfoRequestMessage,
  ToolCallRequestMessage,
} from '@lobechat/device-gateway-client';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError, type ZodType } from 'zod';

import { serviceTokenMatches, type Authenticator } from './auth.js';
import type { GatewayConfig } from './config.js';
import { GatewayError, asGatewayError } from './errors.js';
import { DeviceGateway } from './gateway.js';
import type { GatewayLogger } from './logger.js';
import {
  agentRunBodySchema,
  messageApiBodySchema,
  principalBodySchema,
  rpcBodySchema,
  systemInfoBodySchema,
  toolCallBodySchema,
} from './schemas.js';

export interface CreateGatewayAppOptions {
  authenticator: Authenticator;
  config: GatewayConfig;
  logger: GatewayLogger;
}

export interface StartedGateway {
  close: () => Promise<void>;
  gateway: DeviceGateway;
  port: number;
  server: ServerType;
  url: string;
}

const principalKey = (value: { userId: string; workspaceId?: string }): string =>
  value.workspaceId ? `workspace:${value.workspaceId}` : `user:${value.userId}`;

const parseJson = async <T>(request: Request, schema: ZodType<T>): Promise<T> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new GatewayError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new GatewayError(400, 'INVALID_REQUEST', 'Request body is invalid');
    }
    throw error;
  }
};

const requestTimeout = (
  requested: number | undefined,
  fallback: number,
  maxRequestTimeoutMs: number,
): number => Math.min(requested ?? fallback, maxRequestTimeoutMs);

export const createGatewayApp = ({ authenticator, config, logger }: CreateGatewayAppOptions) => {
  const gateway = new DeviceGateway(config, authenticator, logger);
  const app = new Hono();

  app.get('/healthz', (context) =>
    context.json({
      service: 'modelnet-device-gateway',
      status: 'ok',
    }),
  );
  app.all('/ws', (context) => context.json({ error: 'WebSocket upgrade required' }, 426));

  app.use(
    '/api/device/*',
    bodyLimit({
      maxSize: config.maxPayloadBytes,
      onError: (context) =>
        context.json({ code: 'PAYLOAD_TOO_LARGE', error: 'Request body is too large' }, 413),
    }),
  );
  app.use('/api/device/*', async (context, next) => {
    if (!serviceTokenMatches(context.req.header('Authorization'), config.serviceToken)) {
      return context.json({ code: 'UNAUTHORIZED', error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.post('/api/device/status', async (context) => {
    const body = await parseJson(context.req.raw, principalBodySchema);
    const deviceCount = gateway.registry.countDevices(principalKey(body));
    return context.json({ deviceCount, online: deviceCount > 0 });
  });

  app.post('/api/device/devices', async (context) => {
    const body = await parseJson(context.req.raw, principalBodySchema);
    return context.json({ devices: gateway.registry.listDevices(principalKey(body)) });
  });

  app.post('/api/device/tool-call', async (context) => {
    const body = await parseJson(context.req.raw, toolCallBodySchema);
    const timeout = requestTimeout(body.timeout, 30_000, config.maxRequestTimeoutMs);
    const requestId = crypto.randomUUID();
    const message: ToolCallRequestMessage = {
      operationId: body.operationId,
      requestId,
      timeout,
      toolCall: body.toolCall,
      type: 'tool_call_request',
    };
    const result = await gateway.relay<object>({
      correlationId: requestId,
      deviceId: body.deviceId,
      message,
      principalKey: principalKey(body),
      responseType: 'tool_call_response',
      timeoutMs: timeout,
    });
    return context.json(result);
  });

  app.post('/api/device/system-info', async (context) => {
    const body = await parseJson(context.req.raw, systemInfoBodySchema);
    const timeout = requestTimeout(body.timeout, 10_000, config.maxRequestTimeoutMs);
    const requestId = crypto.randomUUID();
    const message: SystemInfoRequestMessage = { requestId, type: 'system_info_request' };
    const result = await gateway.relay<object>({
      correlationId: requestId,
      deviceId: body.deviceId,
      message,
      principalKey: principalKey(body),
      responseType: 'system_info_response',
      timeoutMs: timeout,
    });
    return context.json(result);
  });

  app.post('/api/device/message-api', async (context) => {
    const body = await parseJson(context.req.raw, messageApiBodySchema);
    const timeout = requestTimeout(body.timeout, 30_000, config.maxRequestTimeoutMs);
    const requestId = crypto.randomUUID();
    const message: MessageApiRequestMessage = {
      api: body.api,
      requestId,
      type: 'message_api_request',
    };
    const result = await gateway.relay<object>({
      correlationId: requestId,
      deviceId: body.deviceId,
      message,
      principalKey: principalKey(body),
      responseType: 'message_api_response',
      timeoutMs: timeout,
    });
    return context.json(result);
  });

  app.post('/api/device/rpc', async (context) => {
    const body = await parseJson(context.req.raw, rpcBodySchema);
    const timeout = requestTimeout(body.timeout, 30_000, config.maxRequestTimeoutMs);
    const requestId = crypto.randomUUID();
    const message: RpcRequestMessage = {
      method: body.method,
      params: body.params,
      requestId,
      timeout,
      type: 'rpc_request',
    };
    const result = await gateway.relay<object>({
      correlationId: requestId,
      deviceId: body.deviceId,
      message,
      principalKey: principalKey(body),
      responseType: 'rpc_response',
      timeoutMs: timeout,
    });
    return context.json(result);
  });

  app.post('/api/device/agent/run', async (context) => {
    const body = await parseJson(context.req.raw, agentRunBodySchema);
    const timeout = requestTimeout(body.timeout, 30_000, config.maxRequestTimeoutMs);
    const message: AgentRunRequestMessage = {
      agentType: body.agentType,
      args: body.args,
      cwd: body.cwd,
      imageList: body.imageList,
      jwt: body.jwt,
      operationId: body.operationId,
      prompt: body.prompt,
      resumeSessionId: body.resumeSessionId,
      systemContext: body.systemContext,
      topicId: body.topicId,
      type: 'agent_run_request',
    };
    const ack = await gateway.relay<{ reason?: string; status: 'accepted' | 'rejected' }>({
      correlationId: body.operationId,
      deviceId: body.deviceId,
      message,
      principalKey: principalKey(body),
      responseType: 'agent_run_ack',
      timeoutMs: timeout,
    });
    return context.json({ ...ack, success: ack.status === 'accepted' });
  });

  app.notFound((context) => context.json({ code: 'NOT_FOUND', error: 'Not found' }, 404));
  app.onError((error, context) => {
    if (error instanceof HTTPException) return error.getResponse();
    const gatewayError = asGatewayError(error);
    if (gatewayError.status >= 500 && gatewayError.code === 'INTERNAL_ERROR') {
      logger.error('unhandled request error');
    }
    return context.json(
      { code: gatewayError.code, error: gatewayError.message },
      gatewayError.status as ContentfulStatusCode,
    );
  });

  return { app, gateway };
};

export const startGatewayServer = async (
  options: CreateGatewayAppOptions,
): Promise<StartedGateway> => {
  const { app, gateway } = createGatewayApp(options);
  const server = serve({
    fetch: app.fetch,
    hostname: options.config.host,
    port: options.config.port,
  });
  server.on('upgrade', gateway.handleUpgrade);
  if (!server.listening) await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Device Gateway did not bind a TCP port');
  }

  return {
    close: async () => {
      await gateway.close();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
    gateway,
    port: address.port,
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
};
