import type { LLMRoleType } from '../llm';
import type { MessageToolCall, ModelReasoning } from '../message';
import type { OpenAIFunctionCall } from './functionCall';

export type ChatResponseFormat =
  | { type: 'json_object' }
  | {
      json_schema: {
        /**
         * Schema identifier required by OpenAI.
         */
        name: string;
        /**
         * JSON schema definition used for validation.
         */
        schema: Record<string, any>;
        /**
         * Enforce strict schema validation when true.
         */
        strict?: boolean;
      };
      type: 'json_schema';
    };

interface UserMessageContentPartText {
  text: string;
  type: 'text';
}
interface UserMessageContentPartImage {
  image_url: {
    detail?: 'auto' | 'low' | 'high';
    url: string;
  };
  type: 'image_url';
}
interface UserMessageContentPartVideo {
  type: 'video_url';
  video_url: { url: string };
}
interface UserMessageContentPartAudio {
  audio_url: {
    codec?: string;
    durationMs?: number;
    mimeType?: string;
    url: string;
  };
  type: 'audio_url';
}

export type UserMessageContentPart =
  | UserMessageContentPartText
  | UserMessageContentPartImage
  | UserMessageContentPartVideo
  | UserMessageContentPartAudio;

export interface OpenAIChatMessage {
  /**
   * @title Content
   * @description Message content
   */
  content: string | UserMessageContentPart[];

  /**
   * @deprecated
   */
  function_call?: OpenAIFunctionCall;
  model?: string;
  name?: string;
  provider?: string;
  reasoning?: ModelReasoning;
  reasoning_content?: string;
  /**
   * Role
   * @description Role of the message sender
   */
  role: LLMRoleType;
  tool_call_id?: string;
  tool_calls?: MessageToolCall[];
}

/**
 * @title Chat Stream Payload
 */
export interface ChatStreamPayload {
  /**
   * Provider deployment name
   */
  deploymentName?: string;
  /**
   * Whether search is enabled
   */
  enabledSearch?: boolean;
  /**
   * @title Penalty coefficient in generated text to reduce repetitiveness
   * @default 0
   */
  frequency_penalty?: number;
  /**
   * @title Maximum length of generated text
   */
  max_tokens?: number;
  /**
   * @title List of chat messages
   */
  messages: OpenAIChatMessage[];
  /**
   * @title Model name
   */
  model: string;
  modelnet?: {
    candidate_aliases?: string[];
    collaboration_plan: {
      aggregator: 'auto' | 'judge_refine' | 'synthesize';
      models?: string[];
      runner: 'auto.network' | 'response.parallel' | 'response.serial';
      runner_config: {
        allow_degraded?: boolean;
        serial_recovery_max_tokens?: number;
        serial_reserved_output_tokens?: number;
        serial_topology?: {
          edges?: unknown[];
          nodes?: { id?: unknown; modelId?: unknown }[];
          version: 'modelnet.serial.v1';
        };
        show_auto_flow?: boolean;
        show_parallel_flow?: boolean;
        show_serial_flow?: boolean;
      };
    };
    runtime_candidates?: Record<string, unknown>[];
    stream_options?: { include_trace?: boolean };
  };
  /** UI-only ModelNet automatic-network candidate aliases; removed before transport. */
  modelnetAutoCandidateIds?: string[];
  /** UI-only ModelNet parallel member IDs; removed before transport. */
  modelnetParallelModelIds?: string[];
  /** UI-only ModelNet serial topology; removed before transport. */
  modelnetSerialTopology?: {
    edges: { source: string; target: string }[];
    nodes: { id: string; modelId: string }[];
    version: 'modelnet.serial.v1';
  };
  /**
   * @title Number of texts to return
   */
  n?: number;
  /**
   * @title Penalty coefficient in generated text to reduce topic changes
   * @default 0
   */
  presence_penalty?: number;
  preserveThinking?: boolean;
  /**
   * @default openai
   */
  provider?: string;
  /**
   * Responses API reasoning configuration.
   */
  reasoning?: {
    effort?: string;
    mode?: 'standard' | 'pro';
    summary?: string;
  };
  response_format?: ChatResponseFormat;
  responseMode?: 'stream' | 'json';
  /**
   * @title Whether to enable streaming requests
   * @default true
   */
  stream?: boolean;
  /**
   * @title Randomness measure for generated text, used to control creativity and diversity
   * @default 1
   */
  temperature: number;
  tool_choice?: string;
  tools?: ChatCompletionTool[];
  /**
   * @title Controls the single token with highest probability in generated text
   * @default 1
   */
  top_p?: number;
}

export interface ChatCompletionFunctions {
  /**
   * The description of what the function does.
   * @type {string}
   * @memberof ChatCompletionFunctions
   */
  description?: string;
  /**
   * The name of the function to be called. Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64.
   * @type {string}
   * @memberof ChatCompletionFunctions
   */
  name: string;
  /**
   * The parameters the functions accepts, described as a JSON Schema object. See the [guide](/docs/guides/gpt/function-calling) for examples, and the [JSON Schema reference](https://json-schema.org/understanding-json-schema/) for documentation about the format.
   * @type {{ [key: string]: any }}
   * @memberof ChatCompletionFunctions
   */
  parameters?: {
    [key: string]: any;
  };
}

export interface ChatCompletionTool {
  function: ChatCompletionFunctions;

  /**
   * The type of the tool. Currently, only `function` is supported.
   */
  type: 'function';
}
