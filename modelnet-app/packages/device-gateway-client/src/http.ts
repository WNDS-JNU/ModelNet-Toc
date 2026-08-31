import type {
  DeviceSystemInfo,
  GatewayDevice,
  GatewayMcpParams,
  GatewayToolCallType,
} from './types';

const DEFAULT_GATEWAY_TOOL_CALL_TIMEOUT_MS = 30_000;
const HTTP_CALL_TIMEOUT_PADDING_MS = 30_000;

type JsonObject = Record<string, unknown>;

export interface DeviceStatusResult {
  deviceCount: number;
  online: boolean;
}

export interface DeviceToolCallResult {
  content: string;
  error?: string;
  state?: unknown;
  success: boolean;
}

export interface DeviceMessageApiResult {
  content: string;
  error?: string;
  success: boolean;
}

export interface DeviceRpcResult<T = unknown> {
  data?: T;
  error?: string;
  success: boolean;
}

export interface GatewayHttpClientOptions {
  gatewayUrl: string;
  serviceToken: string;
}

export class GatewayHttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'GatewayHttpError';
    this.status = status;
    this.code = code;
  }
}

const asJsonObject = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};

const readJsonObject = async (response: Response): Promise<JsonObject> =>
  asJsonObject(await response.json().catch(() => null));

const readHttpError = async (response: Response): Promise<GatewayHttpError> => {
  const body = await readJsonObject(response);
  const code = typeof body.code === 'string' ? body.code : `HTTP_${response.status}`;
  const message =
    typeof body.error === 'string'
      ? body.error
      : typeof body.message === 'string'
        ? body.message
        : `Device Gateway request failed (HTTP ${response.status})`;
  return new GatewayHttpError(response.status, code, message);
};

export class GatewayHttpClient {
  private gatewayUrl: string;
  private serviceToken: string;

  constructor(options: GatewayHttpClientOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/$/, '');
    this.serviceToken = options.serviceToken;
  }

  async queryDeviceStatusStrict(userId: string, workspaceId?: string): Promise<DeviceStatusResult> {
    const response = await this.post('/api/device/status', { userId, workspaceId });
    if (!response.ok) throw await readHttpError(response);
    const data = await readJsonObject(response);
    return {
      deviceCount: typeof data.deviceCount === 'number' ? data.deviceCount : 0,
      online: data.online === true,
    };
  }

  async queryDeviceStatus(userId: string, workspaceId?: string): Promise<DeviceStatusResult> {
    try {
      return await this.queryDeviceStatusStrict(userId, workspaceId);
    } catch {
      return { deviceCount: 0, online: false };
    }
  }

  async queryDeviceListStrict(userId: string, workspaceId?: string): Promise<GatewayDevice[]> {
    const response = await this.post('/api/device/devices', { userId, workspaceId });
    if (!response.ok) throw await readHttpError(response);
    const data = await readJsonObject(response);
    return Array.isArray(data.devices) ? (data.devices as GatewayDevice[]) : [];
  }

  async queryDeviceList(userId: string, workspaceId?: string): Promise<GatewayDevice[]> {
    try {
      return await this.queryDeviceListStrict(userId, workspaceId);
    } catch {
      return [];
    }
  }

  async executeToolCall(
    params: {
      deviceId?: string;
      operationId?: string;
      timeout?: number;
      userId: string;
      workspaceId?: string;
    },
    toolCall: { apiName: string; arguments: string; identifier: string },
  ): Promise<DeviceToolCallResult> {
    return this.postToolCall(params, { ...toolCall, type: 'tool' });
  }

  /** Tunnel a stdio MCP call through the same device tool-call relay. */
  async executeMcpCall(mcpCall: {
    apiName: string;
    arguments: string;
    deviceId?: string;
    identifier: string;
    operationId?: string;
    params: GatewayMcpParams;
    timeout?: number;
    userId: string;
    workspaceId?: string;
  }): Promise<DeviceToolCallResult> {
    const { deviceId, operationId, timeout, userId, workspaceId, ...toolCall } = mcpCall;
    return this.postToolCall(
      { deviceId, operationId, timeout, userId, workspaceId },
      { ...toolCall, type: 'mcp' },
    );
  }

  private async postToolCall(
    params: {
      deviceId?: string;
      operationId?: string;
      timeout?: number;
      userId: string;
      workspaceId?: string;
    },
    toolCall: {
      apiName: string;
      arguments: string;
      identifier: string;
      params?: GatewayMcpParams;
      type?: GatewayToolCallType;
    },
  ): Promise<DeviceToolCallResult> {
    const timeout =
      typeof params.timeout === 'number' && Number.isFinite(params.timeout)
        ? Math.max(Math.trunc(params.timeout), 0)
        : DEFAULT_GATEWAY_TOOL_CALL_TIMEOUT_MS;
    const response = await this.post(
      '/api/device/tool-call',
      {
        deviceId: params.deviceId,
        operationId: params.operationId,
        timeout: params.timeout,
        toolCall,
        userId: params.userId,
        workspaceId: params.workspaceId,
      },
      { timeout: timeout + HTTP_CALL_TIMEOUT_PADDING_MS },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        content: `Device tool call failed (HTTP ${response.status})`,
        error: text || `HTTP ${response.status}`,
        success: false,
      };
    }

    const data = await readJsonObject(response);
    return {
      content:
        typeof data.content === 'string'
          ? data.content
          : data.content !== undefined && data.content !== null
            ? JSON.stringify(data.content)
            : typeof data.error === 'string'
              ? data.error
              : '',
      error: typeof data.error === 'string' ? data.error : undefined,
      state: data.state,
      success: data.success !== false,
    };
  }

  async executeMessageApi(
    params: { deviceId?: string; timeout?: number; userId: string; workspaceId?: string },
    api: { apiName: string; payload: Record<string, unknown>; platform: string },
  ): Promise<DeviceMessageApiResult> {
    const response = await this.post('/api/device/message-api', {
      api,
      deviceId: params.deviceId,
      timeout: params.timeout,
      userId: params.userId,
      workspaceId: params.workspaceId,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        content: `Device message API call failed (HTTP ${response.status})`,
        error: text || `HTTP ${response.status}`,
        success: false,
      };
    }

    const data = await readJsonObject(response);
    return {
      content:
        typeof data.content === 'string'
          ? data.content
          : data.content === undefined || data.content === null
            ? ''
            : JSON.stringify(data.content),
      error: typeof data.error === 'string' ? data.error : undefined,
      success: data.success !== false,
    };
  }

  async dispatchAgentRun(params: {
    agentType: string;
    assistantMessageId: string;
    args?: string[];
    cwd?: string;
    deviceId?: string;
    imageList?: Array<{ id?: string; url: string }>;
    jwt: string;
    operationId: string;
    prompt: string;
    resumeFallbackSystemContext?: string;
    resumeSessionId?: string;
    systemContext?: string;
    timeout?: number;
    topicId: string;
    userId: string;
    workspaceId?: string;
    /**
     * Topic/run workspace for device-side ingest. Distinct from
     * {@link workspaceId}, which routes the request to a device pool. A
     * workspace topic dispatched to a personal device still needs this so
     * `lh hetero exec` can write back under the topic's scope.
     */
    ingestWorkspaceId?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const response = await this.post('/api/device/agent/run', params);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let error = text;
      try {
        const body = asJsonObject(JSON.parse(text));
        error =
          typeof body.code === 'string'
            ? body.code
            : typeof body.error === 'string'
              ? body.error
              : text;
      } catch {
        // Older gateways returned a plain-text machine code.
      }
      return { error: error || `HTTP ${response.status}`, success: false };
    }
    const data = await readJsonObject(response);
    if (data.success === false || data.status === 'rejected') {
      return {
        error:
          typeof data.error === 'string'
            ? data.error
            : typeof data.reason === 'string'
              ? data.reason
              : 'DEVICE_REJECTED',
        success: false,
      };
    }

    return { success: true };
  }

  async invokeRpc<T = unknown>(
    params: { deviceId?: string; timeout?: number; userId: string; workspaceId?: string },
    rpc: { method: string; params?: unknown },
  ): Promise<DeviceRpcResult<T>> {
    const timeout =
      typeof params.timeout === 'number' && Number.isFinite(params.timeout)
        ? Math.max(Math.trunc(params.timeout), 0)
        : DEFAULT_GATEWAY_TOOL_CALL_TIMEOUT_MS;
    const response = await this.post(
      '/api/device/rpc',
      {
        deviceId: params.deviceId,
        method: rpc.method,
        params: rpc.params,
        timeout: params.timeout,
        userId: params.userId,
        workspaceId: params.workspaceId,
      },
      { timeout: timeout + HTTP_CALL_TIMEOUT_PADDING_MS },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { error: text || `HTTP ${response.status}`, success: false };
    }

    const data = await readJsonObject(response);
    return {
      data: data.data as T | undefined,
      error: typeof data.error === 'string' ? data.error : undefined,
      success: data.success === true,
    };
  }

  async getDeviceSystemInfo(
    userId: string,
    deviceId: string,
    workspaceId?: string,
  ): Promise<{ success: boolean; systemInfo?: DeviceSystemInfo }> {
    const response = await this.post('/api/device/system-info', { deviceId, userId, workspaceId });
    if (!response.ok) return { success: false };

    const data = await readJsonObject(response);
    return {
      success: data.success === true,
      systemInfo: data.systemInfo as DeviceSystemInfo | undefined,
    };
  }

  private async post(
    path: string,
    body: unknown,
    options?: { timeout?: number },
  ): Promise<Response> {
    try {
      return await fetch(`${this.gatewayUrl}${path}`, {
        body: JSON.stringify(body),
        headers: {
          'Authorization': `Bearer ${this.serviceToken}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        ...(options?.timeout ? { signal: AbortSignal.timeout(options.timeout) } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Device Gateway request failed';
      throw new GatewayHttpError(0, 'GATEWAY_UNAVAILABLE', message);
    }
  }
}
