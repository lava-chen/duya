/**
 * packages/ai/src/types.ts
 *
 * Core types for the multi-model AI adapter layer.
 *
 * Design principles (from spec §4.2):
 * - Reuse existing ApiFormat from src/lib/providers/types.ts (no new KnownApi).
 * - Single AssistantMessage storage (no VisibleMessageRecord + ProviderTurnRecord split).
 * - thinkingLevelMap + null semantics replaces verbose union types.
 * - compat flags (forceAdaptiveThinking, openAIThinkingFormat, etc.) are flat, not nested.
 * - SSEEvent is migrated here from packages/agent/src/types.ts to break circular deps.
 *
 * SHARED TYPES (TextContent, Message, SSEEvent, etc.) are supersets of the
 * original packages/agent definitions — all existing fields preserved, new
 * signature fields added. This ensures the re-export in Task 0.3 does not
 * break any consumer.
 */

// ─── ApiFormat (re-exported from src/lib/providers/types.ts conceptually) ───
export type ApiFormat =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'bedrock'
  | 'vertex';

// ─── Message role ───
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

// ─── Content block types (superset of packages/agent definitions) ───

export interface TextContent {
  type: 'text';
  text: string;
  /** Provider signature for text content (Anthropic text signature). */
  textSignature?: string;
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type: string;
    data: string;
  };
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Provider signature for tool call (Anthropic thought signature). */
  thoughtSignature?: string;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | MessageContent[];
  is_error?: boolean;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  /** Provider signature for thinking (Anthropic thinking signature). */
  thinkingSignature?: string;
  /** True if the thinking block was redacted by the provider. */
  redacted?: boolean;
}

export type MessageContent =
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent;

// ─── Tool types ───

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultMetadata {
  durationMs?: number;
  filePath?: string;
  lineCount?: number;
  charCount?: number;
  exitCode?: number;
  matchCount?: number;
  truncated?: boolean;
  engine?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  id: string;
  name: string;
  result: string;
  error?: boolean;
  duration_ms?: number;
  metadata?: ToolResultMetadata;
  /**
   * Optional deferred second result. When present, StreamingToolExecutor
   * keeps a reference and, after the main result has been delivered, awaits
   * this promise and yields a synthetic second tool_result.
   */
  pendingExtraResult?: Promise<{ result: string; is_error?: boolean }>;
  /**
   * Optional deferred context associated with a tool result. When present,
   * StreamingToolExecutor surfaces it as a `deferredContext` update so the
   * agent can inject it as transient runtime context on the next provider
   * turn (never persisted to the durable history). Resolves to a string or
   * JSON-serializable value (e.g. a follow-up review payload).
   */
  pendingContext?: Promise<unknown>;
  /**
   * Inline image attachments for multimodal main models. When present,
   * StreamingToolExecutor builds the tool_result content as a
   * `MessageContent[]` array ([text, ...ImageContent]) instead of a plain
   * string, so vision-capable models can see the image directly.
   *
   * Downstream consumers handle non-vision models:
   *   - transformMessages downgrades image blocks to placeholder text when
   *     `model.input` lacks 'image'.
   *   - OpenAI tool messages cannot carry images at all; the OpenAI adapter
   *     strips them with a fallback hint.
   *
   * Mirrors the FileAttachment.imageChunks shape ({ base64, mediaType }).
   */
  images?: Array<{ data: string; mediaType: string }>;
}

// ─── Token usage ───

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  /** Cache hit tokens (cache read) - Anthropic prompt caching */
  cache_hit_tokens?: number;
  /** Cache creation tokens (cache write) - Anthropic prompt caching */
  cache_creation_tokens?: number;
  /** Upstream provider name when using an aggregator like OpenRouter.
   *  E.g., "Anthropic", "OpenAI", "Google". Undefined for direct API calls. */
  upstreamProvider?: string;
}

// ─── Stop reason ───

export type StopReason =
  | 'completed'
  | 'aborted'
  | 'max_turns'
  | 'error'
  | 'tool_use'
  | 'end_turn';

// ─── SSE Event types (migrated from packages/agent) ───
// mode_changed.mode uses `string` instead of AgentRuntimeMode to avoid
// a dependency on agent-specific types. packages/agent can narrow it.

export interface PermissionRequestEvent {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  mode: 'generic' | 'ask_user_question' | 'exit_plan_mode';
  expiresAt: number;
  decisionReason?: string;
}

export interface AgentProgressEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'started' | 'done' | 'error';
  data?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  duration?: number;
  agentId?: string;
  agentType?: string;
  agentName?: string;
  agentDescription?: string;
  sessionId?: string;
}

export type SSEEvent =
  | { type: 'text'; data: string }
  | { type: 'tool_use_started'; data: ToolUse }
  | { type: 'tool_use'; data: ToolUse }
  | { type: 'tool_result'; data: ToolResult }
  | { type: 'tool_progress'; data: { toolName: string; elapsedSeconds: number } }
  | { type: 'tool_timeout'; data: { toolName: string; elapsedSeconds: number } }
  | { type: 'thinking'; data: string; signature?: string }
  | { type: 'done'; reason?: StopReason }
  | { type: 'error'; data: string; code?: string; metadata?: { errorType?: string; statusCode?: number; isRetryable?: boolean } }
  | { type: 'result'; data: TokenUsage }
  | { type: 'turn_start'; data: { turnCount: number } }
  | { type: 'permission_request'; data: PermissionRequestEvent }
  | { type: 'agent_progress'; data: AgentProgressEvent }
  | { type: 'system'; data: string; metadata?: { retryAttempt?: number; maxAttempts?: number; retryDelayMs?: number; diagnostic?: ParameterDiagnostic } }
  | { type: 'text_delta'; data: string }
  | { type: 'thinking_delta'; data: string }
  | { type: 'mode_changed'; data: { mode: string; source: 'agent' | 'user'; reason?: string } };

// ─── Message types (superset of packages/agent definitions) ───

export interface Message {
  role: MessageRole;
  content: string | MessageContent[];
  id?: string;
  name?: string;
  tool_call_id?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
  msg_type?: string;
  thinking?: string;
  tool_name?: string;
  tool_input?: string;
  parent_tool_call_id?: string;
  viz_spec?: string;
  status?: string;
  seq_index?: number;
  duration_ms?: number;
  sub_agent_id?: string;
  /** File attachments (name, type, url, size, text, imageChunks, etc.) */
  attachments?: unknown[];
  /** User-facing rendering content. */
  displayContent?: string | MessageContent[];
  /** True if this message is a compact boundary marker */
  isCompactBoundary?: boolean;
  /** True if this message is a compact summary */
  isCompactSummary?: boolean;
  /** Number of messages compacted into this summary */
  compactedMessageCount?: number;
  /** IDs of the original messages compacted into this summary */
  compactedMessageIds?: string[];
  /** Unique ID of the compact boundary this summary belongs to */
  compactBoundaryId?: string;
  /** Token usage for this message */
  tokenUsage?: TokenUsage;
  // ─── NEW: multi-model adapter fields ───
  /** Provider ID that produced this message (for isSameModel guard) */
  providerId?: string;
  /** Model name that produced this message */
  model?: string;
  /** API format used to produce this message */
  api?: ApiFormat;
}

// ─── AssistantMessage (superset of packages/agent definition) ───

export interface AssistantMessage {
  role: 'assistant';
  content: MessageContent[];
  id?: string;
  timestamp?: number;
  // ─── NEW: multi-model adapter fields ───
  api?: ApiFormat;
  providerId?: string;
  model?: string;
  responseId?: string;
  usage?: TokenUsage;
  stopReason?: StopReason;
}

// ─── Reasoning capability types (NEW) ───

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelThinkingLevel = 'off' | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

export type OpenAIThinkingFormat =
  | 'openai-standard'
  | 'reasoning-content'
  | 'qwen-style'
  | 'glm-style'
  | 'think-tag-fallback';

export interface ModelCompat {
  openAIThinkingFormat?: OpenAIThinkingFormat;
  forceAdaptiveThinking?: boolean;
  fixedTemperature?: number;
  ignoredParameters?: string[];
  rejectedParameters?: string[];
  streamOnly?: boolean;
}

export interface Model<TApi extends ApiFormat = ApiFormat> {
  id: string;
  name: string;
  api: TApi;
  providerId: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  compat?: ModelCompat;
}

// ─── Internal events (not exposed to consumers) ───

export type AssistantMessageEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'text_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'thinking_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'toolcall_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolUseContent; partial: AssistantMessage }
  | { type: 'done'; reason: StopReason; message: AssistantMessage }
  | { type: 'error'; reason: string; error: AssistantMessage };

// ─── Parameter diagnostic (P1, but type defined here) ───

export interface ParameterDiagnostic {
  code: 'PARAMETER_IGNORED' | 'PARAMETER_UNSUPPORTED' | 'PARAMETER_REJECTED';
  parameter: string;
  routeId: string;
  message: string;
}

// ─── DuyaReasoningSettings (P1: effort superset) ───

/**
 * Superset of the simple `effort` string, providing granular control
 * over reasoning behavior. When both `effort` and `reasoning` are set
 * in streamChat options, `reasoning` takes precedence.
 *
 * Design: the existing `effort?: string` field stays in ChatOptions for
 * backward compatibility. Callers who want fine-grained control pass
 * `reasoningSettings` instead.
 */
export interface DuyaReasoningSettings {
  /** Reasoning intensity. Maps to the existing effort levels.
   *  When set, this is equivalent to setting `effort` in the options. */
  intensity?: ThinkingLevel | 'off';

  /** Reasoning mode.
   *  - 'standard': normal reasoning (default)
   *  - 'deep': extended thinking with higher budget
   *  - 'fast': minimal reasoning for speed
   *  Maps to provider-specific parameters when supported. */
  mode?: 'standard' | 'deep' | 'fast';

  /** Display preferences for the thinking content. */
  display?: {
    /** Whether to show thinking content to the user. Default true. */
    showThinking?: boolean;
    /** Whether to collapse thinking by default. Default true. */
    collapseByDefault?: boolean;
  };

  /** Continuity control for reasoning state.
   *  - 'always': always carry forward reasoning signatures
   *  - 'never': never carry forward (start fresh each turn)
   *  - 'auto': carry forward only when the previous turn had reasoning
   *  Default: 'auto'. */
  continuity?: 'always' | 'never' | 'auto';
}

// ─── AIClient interface (compatible with existing LLMClient) ───

export interface AIClientOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  authStyle?: 'api_key' | 'auth_token';
  apiFormat: ApiFormat;
  headers?: Record<string, string>;
  providerId: string;
  modelCapabilities?: ModelCompat;
}

export interface AIClient {
  streamChat(
    messages: Message[],
    options?: {
      systemPrompt?: string;
      tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
      maxTokens?: number;
      temperature?: number;
      disableThinking?: boolean;
      signal?: AbortSignal;
      effort?: string;
      maxOutputTokens?: number;
      /** Tokens reserved specifically for reasoning/thinking.
       *  For Anthropic: maps to thinking.budget_tokens.
       *  For OpenAI: ignored (reasoning_effort controls budget).
       *  When set, totalOutputBudget must be >= reasoningBudget + 1. */
      reasoningBudget?: number;
      /** Total output token budget (thinking + text combined).
       *  For Anthropic: maps to max_tokens.
       *  For OpenAI: maps to max_tokens (max_completion_tokens).
       *  When set, takes precedence over maxOutputTokens/maxTokens. */
      totalOutputBudget?: number;
      /** Granular reasoning settings. When set, takes precedence
       *  over the simple `effort` field. */
      reasoningSettings?: DuyaReasoningSettings;
    },
  ): AsyncGenerator<SSEEvent, AssistantMessage, unknown>;

  chat?(
    messages: Message[],
    options?: {
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ content: string; usage?: TokenUsage }>;
}
