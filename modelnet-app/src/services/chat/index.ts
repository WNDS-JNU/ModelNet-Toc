import { AgentBuilderIdentifier } from '@lobechat/builtin-tool-agent-builder';
import {
  getConnectorCatalog,
  REQUEST_AGENT_ID_HEADER,
  REQUEST_TOPIC_ID_HEADER,
  REQUEST_TRIGGER_HEADER,
} from '@lobechat/const';
import { type OfficialToolItem } from '@lobechat/context-engine';
import { type FetchSSEOptions } from '@lobechat/fetch-sse';
import { fetchSSE, standardizeAnimationStyle } from '@lobechat/fetch-sse';
import type { ChatCompletionErrorPayload } from '@lobechat/model-runtime';
import { isResponsesAPIModel } from '@lobechat/model-runtime/providers/openai/modelId';
import { AgentRuntimeError } from '@lobechat/model-runtime/utils/createError';
import {
  ChatErrorType,
  getDisabledPluginIds,
  type RuntimeAdditionalContextFragment,
  type RuntimeInitialContext,
  type RuntimeStepContext,
  type TracePayload,
  TraceTagMap,
  type UIChatMessage,
} from '@lobechat/types';
import { merge } from 'es-toolkit/compat';
import { ModelProvider } from 'model-bank/modelProvider';

import { DEFAULT_AGENT_CONFIG } from '@/const/settings';
import {
  getModelNetRuntimeProviderInfo,
  isModelNetParallelModel,
  isModelNetSerialModel,
  MIN_MODELNET_PARALLEL_MODELS,
  MIN_MODELNET_SERIAL_MODELS,
  MODELNET_AUTO_MODEL_ID,
  MODELNET_PROVIDER_ID,
  parseModelNetUserProviderAlias,
} from '@/features/ModelNetParallel';
import { getSearchConfig } from '@/helpers/getSearchConfig';
import { isCanUseFC } from '@/helpers/isCanUseFC';
import { getAgentStoreState } from '@/store/agent';
import {
  agentByIdSelectors,
  agentChatConfigSelectors,
  agentSelectors,
} from '@/store/agent/selectors';
import { aiModelSelectors, aiProviderSelectors, getAiInfraStoreState } from '@/store/aiInfra';
import { getChatStoreState } from '@/store/chat';
import { getToolStoreState } from '@/store/tool';
import {
  builtinToolSelectors,
  composioStoreSelectors,
  lobehubSkillStoreSelectors,
} from '@/store/tool/selectors';
import { getUserStoreState, useUserStore } from '@/store/user';
import {
  settingsSelectors,
  userGeneralSettingsSelectors,
  userProfileSelectors,
} from '@/store/user/selectors';
import { type ChatStreamPayload, type OpenAIChatMessage } from '@/types/openai/chat';
import { createErrorResponse } from '@/utils/errorResponse';
import { createTraceHeader } from '@/utils/trace';

import { createHeaderWithAuth } from '../_auth';
import { API_ENDPOINTS } from '../_url';
import { findDeploymentName, isEnableFetchOnClient, resolveRuntimeProvider } from './helper';
import { type ResolvedAgentConfig } from './mecha';
import {
  contextEngineering,
  getTargetAgentId,
  initializeWithClientStore,
  resolveModelExtendParams,
} from './mecha';
import { type FetchOptions } from './types';

const providersWithDeploymentName = new Set<string>([
  ModelProvider.Azure,
  ModelProvider.AzureAI,
  ModelProvider.KimiCodingPlan,
  ModelProvider.Qwen,
  ModelProvider.Spark,
  ModelProvider.Volcengine,
  ModelProvider.VolcengineCodingPlan,
]);
export interface GetChatCompletionPayload extends Partial<Omit<ChatStreamPayload, 'messages'>> {
  additionalContexts?: readonly RuntimeAdditionalContextFragment[];
  agentId?: string;
  groupId?: string;
  messages: UIChatMessage[];
  /**
   * Pre-resolved agent config from AgentRuntime layer.
   * Required to ensure config consistency and proper isSubAgent filtering.
   */
  resolvedAgentConfig: ResolvedAgentConfig;
  topicId?: string;
}

export interface PreparedAssistantMessageContext {
  options: FetchOptions;
  params: Partial<ChatStreamPayload>;
}

type ChatStreamInputParams = Partial<Omit<ChatStreamPayload, 'messages'>> & {
  messages?: (UIChatMessage | OpenAIChatMessage)[];
};

const uniqueStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string'))]
    : [];

const modelNetSerialModelIds = (topology: unknown): string[] => {
  const nodes: unknown[] =
    typeof topology === 'object' && topology !== null && Array.isArray((topology as any).nodes)
      ? (topology as any).nodes
      : [];
  const modelIds = nodes
    .map((node) =>
      typeof node === 'object' && node !== null
        ? (node as { modelId?: unknown }).modelId
        : undefined,
    )
    .filter((modelId): modelId is string => typeof modelId === 'string');

  return [...new Set(modelIds)];
};

const buildModelNetRuntimeCandidates = (modelIds: string[]) => {
  const selectedIds = [...new Set(modelIds)];
  if (selectedIds.length === 0) return [];

  const { aiProviderRuntimeConfig = {}, enabledChatModelList = [] } = getAiInfraStoreState();

  return selectedIds.flatMap((id) => {
    const alias = parseModelNetUserProviderAlias(id);
    if (!alias) return [];

    const provider = enabledChatModelList.find((item) => item.id === alias.providerId);
    const model = provider?.children.find((item) => item.id === alias.modelId);
    const runtimeInfo = provider
      ? getModelNetRuntimeProviderInfo(provider, aiProviderRuntimeConfig)
      : undefined;

    if (!provider || !model || !runtimeInfo) return [];

    return [
      {
        backend: 'openai_compatible',
        capabilities: ['chat', 'streaming'],
        display_name: model.displayName || alias.modelId,
        id,
        model_id: alias.modelId,
        provider_id: alias.providerId,
        provider_name: provider.name || alias.providerId,
        source: 'user_provider',
        ...(typeof model.contextWindowTokens === 'number' && {
          context_length: model.contextWindowTokens,
        }),
        ...(typeof model.maxOutput === 'number' && {
          max_output_tokens: model.maxOutput,
        }),
        api_base: runtimeInfo.apiBase,
        ...(runtimeInfo.apiKey && { api_key: runtimeInfo.apiKey }),
      },
    ];
  });
};

const attachModelNetRuntimeCandidates = (modelnet: any, modelIds: string[]) => {
  const runtimeCandidates = buildModelNetRuntimeCandidates(modelIds);
  if (runtimeCandidates.length > 0) {
    modelnet.runtime_candidates = runtimeCandidates;
  }
};

interface FetchAITaskResultParams extends FetchSSEOptions {
  abortController?: AbortController;
  onError?: (e: Error, rawError?: any) => void;
  /**
   * Loading state change handler function
   * @param loading - Whether in loading state
   */
  onLoadingChange?: (loading: boolean) => void;
  /**
   * Request object
   */
  params: ChatStreamInputParams;
  trace?: TracePayload;
}

interface CreateAssistantMessageStream extends FetchSSEOptions {
  abortController?: AbortController;
  historySummary?: string;
  /** Initial context for page editor (captured at operation start) */
  initialContext?: RuntimeInitialContext;
  metadata?: FetchOptions['metadata'];
  params: GetChatCompletionPayload;
  /** Step context for page editor (updated each step) */
  stepContext?: RuntimeStepContext;
  trace?: TracePayload;
}

class ChatService {
  private resolveAgentDocumentsTargetId = (
    targetAgentId: string,
    enabledToolIds: string[] = [],
  ): string | undefined => {
    if (enabledToolIds.includes(AgentBuilderIdentifier)) {
      return getChatStoreState().activeAgentId || targetAgentId || undefined;
    }

    return targetAgentId || undefined;
  };

  buildAssistantMessageContext = async (
    {
      messages,
      agentId,
      groupId,
      additionalContexts,
      topicId,
      resolvedAgentConfig,
      ...params
    }: GetChatCompletionPayload,
    options?: FetchOptions,
  ): Promise<PreparedAssistantMessageContext> => {
    const payload = merge(
      {
        model: DEFAULT_AGENT_CONFIG.model,
        stream: true,
        ...DEFAULT_AGENT_CONFIG.params,
      },
      params,
    );

    // =================== 1. use pre-resolved agent config =================== //
    // Config is resolved in AgentRuntime layer (internal_createAgentState)
    // which handles isSubAgent filtering, disableTools, and tools generation

    const targetAgentId = getTargetAgentId(agentId);

    // Tools are pre-generated in internal_createAgentState and passed via resolvedAgentConfig
    // This avoids duplicate toolsEngine creation and ensures disableTools is properly handled
    const {
      agentConfig,
      chatConfig,
      enabledManifests = [],
      enabledToolIds = [],
      plugins,
      tools,
    } = resolvedAgentConfig;

    // Get search config with agentId for agent-specific settings
    const searchConfig = getSearchConfig(payload.model, payload.provider!, targetAgentId);

    // =================== 1.1 process user memories =================== //

    const userLevelMemoryEnabled = settingsSelectors.memoryEnabled(getUserStoreState());
    // Agent-level memory toggle takes priority over user-level setting,
    // matching the logic in useMemoryEnabled hook
    const enableUserMemories = chatConfig.memory?.enabled ?? userLevelMemoryEnabled;
    const userMemorySettings = settingsSelectors.currentMemorySettings(getUserStoreState());
    const effectiveMemoryEffort =
      chatConfig.memory?.effort ?? userMemorySettings.effort ?? 'medium';
    const enableAgentMode =
      chatConfig.enableAgentMode !== false && isCanUseFC(payload.model, payload.provider!);

    // =================== 1.2 build agent builder context =================== //

    // Check if Agent Builder tool is enabled and build context for it
    // Note: When Agent Builder is active, we need to get the context of the agent being edited,
    // which is stored in chatStore.activeAgentId, not the targetAgentId (which is the Agent Builder itself)
    const isAgentBuilderEnabled = enabledToolIds.includes(AgentBuilderIdentifier);
    const documentsAgentId = this.resolveAgentDocumentsTargetId(targetAgentId, enabledToolIds);
    let agentBuilderContext;
    let agentDocuments = documentsAgentId
      ? agentSelectors.getAgentDocumentsById(documentsAgentId)(getAgentStoreState())
      : undefined;

    if (documentsAgentId && agentDocuments === undefined) {
      try {
        agentDocuments = await getAgentStoreState().ensureAgentDocuments(documentsAgentId);
      } catch (error) {
        // Agent documents are optional on the client; keep generation working if hydration fails.
        console.error('[ChatService] Failed to ensure agent documents:', error);
      }
    }

    if (isAgentBuilderEnabled) {
      const activeAgentId = getChatStoreState().activeAgentId || '';
      const baseContext =
        agentByIdSelectors.getAgentBuilderContextById(activeAgentId)(getAgentStoreState());
      const activeAgentConfig =
        agentSelectors.getAgentConfigById(activeAgentId)(getAgentStoreState());

      // Build official tools list (builtin tools + Composio tools)
      const toolState = getToolStoreState();
      const enabledPlugins = activeAgentConfig?.plugins || [];

      const officialTools: OfficialToolItem[] = [];

      const isComposioEnabled = Boolean(
        typeof window !== 'undefined' &&
        window.global_serverConfigStore?.getState()?.serverConfig?.enableComposio,
      );
      const isLobehubSkillEnabled = Boolean(
        typeof window !== 'undefined' &&
        window.global_serverConfigStore?.getState()?.serverConfig?.enableLobehubSkill,
      );
      const connectorCatalog = getConnectorCatalog({
        composio: isComposioEnabled,
        lobehub: isLobehubSkillEnabled,
      });
      const connectorIdentifiers = new Set(
        connectorCatalog.map((item) =>
          item.type === 'lobehub' ? item.provider.id : item.serverType.identifier,
        ),
      );

      // Get builtin tools (excluding connectors rendered through their canonical owner)
      const builtinTools = builtinToolSelectors.metaList(toolState);

      for (const tool of builtinTools) {
        if (connectorIdentifiers.has(tool.identifier)) continue;

        officialTools.push({
          description: tool.meta?.description,
          enabled: enabledPlugins.includes(tool.identifier),
          identifier: tool.identifier,
          installed: true,
          name: tool.meta?.title || tool.identifier,
          type: 'builtin',
        });
      }

      const allComposioServers = composioStoreSelectors.getServers(toolState);
      const allLobehubSkillServers = lobehubSkillStoreSelectors.getServers(toolState);
      for (const connector of connectorCatalog) {
        if (connector.type === 'composio') {
          const { serverType } = connector;
          const server = allComposioServers.find(
            (item) => item.identifier === serverType.identifier,
          );
          officialTools.push({
            description: `ModelNet Mcp Server: ${serverType.label}`,
            enabled: enabledPlugins.includes(serverType.identifier),
            identifier: serverType.identifier,
            installed: !!server,
            name: serverType.label,
            type: 'composio',
          });
          continue;
        }

        const { provider } = connector;
        const server = allLobehubSkillServers.find((item) => item.identifier === provider.id);
        officialTools.push({
          description: `ModelNet Skill Provider: ${provider.label}`,
          enabled: enabledPlugins.includes(provider.id),
          identifier: provider.id,
          installed: !!server,
          name: provider.label,
          type: 'lobehub-skill',
        });
      }

      agentBuilderContext = {
        ...baseContext,
        officialTools,
      };
    }

    // Apply context engineering with preprocessing configuration
    // Note: agentConfig.systemRole is already resolved by resolveAgentConfig for builtin agents
    const modelMessages = await contextEngineering({
      agentBuilderContext,
      agentDocuments,
      agentId: targetAgentId,
      // `agentConfig.plugins` is the raw (pre-filter) field — `plugins` below
      // is already pinned-only (resolved upstream in agentConfigResolver).
      disabledPluginIds: getDisabledPluginIds(agentConfig.plugins),
      enableAgentMode,
      // Use raw chatConfig values, not selectors with business logic that may force false
      enableHistoryCount: chatConfig.enableHistoryCount,
      enableUserMemories,
      groupId,
      additionalContexts,
      // historyCount is number of history messages; add 1 for current user message
      historyCount: (chatConfig.historyCount ?? 20) + 1,
      // Page editor context from agent runtime
      initialContext: options?.initialContext,
      inputTemplate: chatConfig.inputTemplate,
      manifests: enabledManifests,
      messages,
      model: payload.model,
      plugins,
      provider: payload.provider!,
      sessionId: options?.trace?.sessionId,
      stepContext: options?.stepContext,
      systemRole: agentConfig.systemRole,
      tools: enabledToolIds,
      topicId,
      memoryContext: {
        effort: effectiveMemoryEffort,
      },
    });

    // ============  3. process extend params   ============ //

    // Make sure the user's saved model-instance reasoning config is loaded
    // before the synchronous resolution below — after a reload the
    // ReasoningConfigLoader SWR fetch may still be in flight when the user
    // sends the first message. No-op once cached; failures fall back to
    // level defaults.
    await getAiInfraStoreState().ensureModelReasoningConfig(payload.model, payload.provider!);

    const extendParams = resolveModelExtendParams({
      chatConfig,
      model: payload.model,
      provider: payload.provider!,
      subAgentChatConfigOverride: resolvedAgentConfig.subAgentChatConfigOverride,
    });

    // For models governed by the reasoning extend-params family the user-level
    // model-instance config is the single source of truth, so drop the legacy
    // per-agent Advanced `params.reasoning_effort` — otherwise a stale agent
    // value would leak into the payload whenever no instance value overlays it.
    if (
      aiModelSelectors.isModelHasReasoningExtendParams(
        payload.model,
        payload.provider!,
      )(getAiInfraStoreState())
    ) {
      delete (params as Record<string, unknown>).reasoning_effort;
    }

    return {
      options: { ...options, agentId: targetAgentId, topicId },
      params: {
        ...params,
        ...extendParams,
        enabledSearch: searchConfig.enabledSearch && searchConfig.useModelSearch ? true : undefined,
        messages: modelMessages,
        // Use the chatConfig from the target agent for streaming preference
        stream: chatConfig.enableStreaming !== false,
        tools,
      },
    };
  };

  createAssistantMessage = async (params: GetChatCompletionPayload, options?: FetchOptions) => {
    const prepared = await this.buildAssistantMessageContext(params, options);

    return this.getChatCompletion(prepared.params, prepared.options);
  };

  createAssistantMessageStream = async ({
    params,
    abortController,
    onAbort,
    onMessageHandle,
    onErrorHandle,
    onFinish,
    metadata,
    trace,
    historySummary,
    initialContext,
    stepContext,
  }: CreateAssistantMessageStream) => {
    await this.createAssistantMessage(params, {
      historySummary,
      initialContext,
      onAbort,
      onErrorHandle,
      onFinish,
      onMessageHandle,
      metadata,
      signal: abortController?.signal,
      stepContext,
      trace: this.mapChatTrace(trace),
    });
  };

  mapChatTrace = (trace?: TracePayload): TracePayload => this.mapTrace(trace, TraceTagMap.Chat);

  getChatCompletion = async (params: Partial<ChatStreamPayload>, options?: FetchOptions) => {
    const { agentId, metadata, signal, responseAnimation, topicId } = options ?? {};
    const requestTrigger = metadata?.trigger;

    const { provider = ModelProvider.OpenAI, ...res } = params;
    const modelnetParallelModelIds = uniqueStringList((res as any).modelnetParallelModelIds);
    delete (res as any).modelnetParallelModelIds;
    const modelnetSerialTopology = (res as any).modelnetSerialTopology;
    delete (res as any).modelnetSerialTopology;
    const modelnetAutoCandidateIds = uniqueStringList((res as any).modelnetAutoCandidateIds);
    delete (res as any).modelnetAutoCandidateIds;
    delete (res as any).modelnet;

    // =================== process model =================== //
    // ===================================================== //
    let model = res.model || DEFAULT_AGENT_CONFIG.model;
    const isModelNetParallel = isModelNetParallelModel(provider, model);
    const isModelNetSerial = isModelNetSerialModel(provider, model);
    const deploymentName = providersWithDeploymentName.has(provider)
      ? findDeploymentName(model, provider)
      : undefined;
    const shouldUseDeploymentField =
      (provider === ModelProvider.Azure && isResponsesAPIModel(model)) ||
      provider === ModelProvider.Spark;

    if (!shouldUseDeploymentField && deploymentName) {
      model = deploymentName;
    }

    // When user explicitly disables Responses API, set apiMode to 'chatCompletion'
    // This ensures the user's preference takes priority over provider's useResponseModels config
    // When user enables Responses API, set to 'responses' to force use Responses API
    const normalizedModel = model.toLowerCase();
    const isModelNetProvider =
      provider === MODELNET_PROVIDER_ID || provider === ModelProvider.OpenAI;
    const isModelNetAuto = isModelNetProvider && normalizedModel === MODELNET_AUTO_MODEL_ID;
    const isModelNetConcreteBackend =
      isModelNetProvider &&
      (normalizedModel.startsWith('inference-') ||
        normalizedModel.startsWith('llama-cpp-') ||
        normalizedModel.startsWith('siliconflow-'));
    const isModelNetAggregateEntrypoint =
      isModelNetParallel ||
      isModelNetSerial ||
      (isModelNetProvider &&
        (normalizedModel === 'modelnet' || normalizedModel === 'modelnet/modelnet'));
    const forceChatCompletions =
      isModelNetAggregateEntrypoint || isModelNetAuto || isModelNetConcreteBackend;
    if (isModelNetAggregateEntrypoint) {
      model = 'modelnet';
    }
    const apiMode: 'responses' | 'chatCompletion' =
      !forceChatCompletions &&
      aiProviderSelectors.isProviderEnableResponseApi(provider)(getAiInfraStoreState())
        ? 'responses'
        : 'chatCompletion';

    // Get the chat config to check streaming preference
    const chatConfig = agentChatConfigSelectors.currentChatConfig(getAgentStoreState());

    delete (res as any).scope;
    // Fork flow stores market metadata in agent.params; must not reach OpenAI-compatible / Responses API
    delete (res as any).forkedFromIdentifier;

    const payload = merge(
      {
        model: DEFAULT_AGENT_CONFIG.model,
        stream: chatConfig.enableStreaming !== false, // Default to true if not set
        ...DEFAULT_AGENT_CONFIG.params,
      },
      {
        ...res,
        apiMode,
        ...(shouldUseDeploymentField &&
          deploymentName &&
          deploymentName !== model && { deploymentName }),
        model,
      },
    );

    // Convert null to undefined for model params to prevent sending null values to API
    if (payload.temperature === null) payload.temperature = undefined;
    if (payload.top_p === null) payload.top_p = undefined;
    if (payload.presence_penalty === null) payload.presence_penalty = undefined;
    if (payload.frequency_penalty === null) payload.frequency_penalty = undefined;
    delete (payload as any).modelnetParallelModelIds;
    delete (payload as any).modelnetSerialTopology;
    delete (payload as any).modelnetAutoCandidateIds;

    if (isModelNetParallel) {
      if (modelnetParallelModelIds.length < MIN_MODELNET_PARALLEL_MODELS) {
        throw new Error(`ModelNet 并联至少需要选择 ${MIN_MODELNET_PARALLEL_MODELS} 个模型`);
      }

      payload.model = 'modelnet';
      payload.modelnet = {
        stream_options: {
          include_trace: true,
        },
        collaboration_plan: {
          aggregator: 'synthesize',
          models: modelnetParallelModelIds,
          runner: 'response.parallel',
          runner_config: {
            allow_degraded: false,
            show_parallel_flow: true,
          },
        },
      };
      attachModelNetRuntimeCandidates(payload.modelnet, modelnetParallelModelIds);
    }

    if (isModelNetAuto) {
      payload.modelnet = {
        stream_options: {
          include_trace: true,
        },
        ...(modelnetAutoCandidateIds.length > 0 && {
          candidate_aliases: modelnetAutoCandidateIds,
        }),
        collaboration_plan: {
          aggregator: 'auto',
          runner: 'auto.network',
          runner_config: {
            show_auto_flow: true,
          },
        },
      };
      attachModelNetRuntimeCandidates(payload.modelnet, modelnetAutoCandidateIds);
    }

    if (isModelNetSerial) {
      const serialTopology = modelnetSerialTopology as
        | { edges?: unknown[]; nodes?: { id?: unknown; modelId?: unknown }[]; version?: unknown }
        | undefined;
      const nodeCount = Array.isArray(serialTopology?.nodes) ? serialTopology.nodes.length : 0;

      if (nodeCount < MIN_MODELNET_SERIAL_MODELS) {
        throw new Error(`ModelNet 串联至少需要选择 ${MIN_MODELNET_SERIAL_MODELS} 个模型`);
      }

      payload.model = 'modelnet';
      payload.modelnet = {
        stream_options: {
          include_trace: true,
        },
        collaboration_plan: {
          aggregator: 'judge_refine',
          runner: 'response.serial',
          runner_config: {
            allow_degraded: false,
            serial_recovery_max_tokens: 4096,
            serial_reserved_output_tokens: 4096,
            serial_topology: {
              version: 'modelnet.serial.v1',
              nodes: serialTopology?.nodes,
              edges: serialTopology?.edges,
            },
            show_serial_flow: true,
          },
        },
      };
      attachModelNetRuntimeCandidates(payload.modelnet, modelNetSerialModelIds(serialTopology));
    }

    const sdkType = resolveRuntimeProvider(provider);

    /**
     * Use browser agent runtime
     */
    const enableFetchOnClient = isEnableFetchOnClient(provider);

    let fetcher: typeof fetch | undefined = undefined;

    if (enableFetchOnClient) {
      /**
       * Notes:
       * 1. Browser agent runtime will skip auth check if a key and endpoint provided by
       *    user which will cause abuse of plugins services
       * 2. This feature will be disabled by default
       */
      fetcher = async () => {
        try {
          return await this.fetchOnClient({ payload, provider, runtimeProvider: sdkType, signal });
        } catch (e) {
          const {
            errorType = ChatErrorType.BadRequest,
            error: errorContent,
            ...res
          } = e as ChatCompletionErrorPayload;

          const error = errorContent || e;
          // track the error at server side
          console.error(`Route: [${provider}] ${errorType}:`, error);

          return createErrorResponse(errorType, { error, ...res, provider });
        }
      };
    }

    const traceHeader = createTraceHeader({ ...options?.trace });

    const headers = await createHeaderWithAuth({
      headers: {
        'Content-Type': 'application/json',
        ...traceHeader,
        ...(agentId && { [REQUEST_AGENT_ID_HEADER]: agentId }),
        ...(requestTrigger && { [REQUEST_TRIGGER_HEADER]: requestTrigger }),
        ...(topicId && { [REQUEST_TOPIC_ID_HEADER]: topicId }),
      },
      provider,
    });
    const { getBusinessTrpcHeaders } = await import('@/business/client/trpc-headers');
    Object.assign(headers as Record<string, string>, await getBusinessTrpcHeaders());

    const { DEFAULT_MODEL_PROVIDER_LIST } = await import('model-bank/modelProviders');
    const providerConfig = DEFAULT_MODEL_PROVIDER_LIST.find((item) => item.id === provider);

    const userPreferTransitionMode =
      userGeneralSettingsSelectors.transitionMode(getUserStoreState());

    // The order of the array is very important.
    const mergedResponseAnimation = [
      providerConfig?.settings?.responseAnimation || {},
      userPreferTransitionMode,
      responseAnimation,
    ].reduce((acc, cur) => merge(acc, standardizeAnimationStyle(cur)), {});

    return fetchSSE(API_ENDPOINTS.chat(provider), {
      body: JSON.stringify(payload),
      fetcher,
      headers,
      method: 'POST',
      onAbort: options?.onAbort,
      onErrorHandle: options?.onErrorHandle,
      onFinish: options?.onFinish,
      onMessageHandle: options?.onMessageHandle,
      requestContext: {
        apiMode,
        fetchOnClient: enableFetchOnClient,
        model,
        provider,
      },
      responseAnimation: mergedResponseAnimation,
      signal,
    });
  };

  fetchPresetTaskResult = async ({
    params,
    onMessageHandle,
    onFinish,
    onError,
    onLoadingChange,
    abortController,
    trace,
  }: FetchAITaskResultParams) => {
    const errorHandle = (error: Error, errorContent?: any) => {
      onLoadingChange?.(false);
      if (abortController?.signal.aborted) {
        return;
      }
      onError?.(error, errorContent);
      console.error(error);
    };

    onLoadingChange?.(true);

    try {
      const llmMessages = await contextEngineering({
        messages: params.messages as any,
        model: params.model!,
        provider: params.provider!,
      });

      await this.getChatCompletion(
        { ...params, messages: llmMessages },
        {
          onErrorHandle: (error) => {
            errorHandle(new Error(error.message), error);
          },
          onFinish,
          onMessageHandle,
          signal: abortController?.signal,
          trace: this.mapTrace(trace, TraceTagMap.SystemChain),
        },
      );

      onLoadingChange?.(false);
    } catch (e) {
      errorHandle(e as Error);
    }
  };

  private mapTrace = (trace?: TracePayload, tag?: TraceTagMap): TracePayload => {
    const tags = agentSelectors.currentAgentMeta(getAgentStoreState()).tags || [];

    const enabled = userGeneralSettingsSelectors.telemetry(getUserStoreState());

    if (!enabled) return { ...trace, enabled: false };

    return {
      ...trace,
      enabled: true,
      tags: [tag, ...(trace?.tags || []), ...tags].filter(Boolean) as string[],
      userId: userProfileSelectors.userId(useUserStore.getState()),
    };
  };

  /**
   * Fetch chat completion on the client side.

   */
  private fetchOnClient = async (params: {
    payload: Partial<ChatStreamPayload>;
    provider: string;
    runtimeProvider: string;
    signal?: AbortSignal;
  }) => {
    /**
     * if enable login and not signed in, return unauthorized error
     */
    const userStore = useUserStore.getState();
    if (!userStore.isSignedIn) {
      throw AgentRuntimeError.createError(ChatErrorType.InvalidAccessCode);
    }

    const agentRuntime = await initializeWithClientStore({
      payload: params.payload,
      provider: params.provider,
      runtimeProvider: params.runtimeProvider,
    });
    const data = params.payload as ChatStreamPayload;

    return agentRuntime.chat(data, { signal: params.signal });
  };
}

export const chatService = new ChatService();
