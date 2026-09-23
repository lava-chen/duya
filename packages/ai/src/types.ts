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

import type { CacheRetention } from './utils/prompt-caching.js';

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
  /**
   * Provider annotations captured verbatim (plan 440 phase 2): OpenAI
   * url_citation / file_citation / container_file_citation entries attached
   * to streamed output text. Capture-only; rendering is a frontend concern.
   */
  annotations?: unknown[];
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
  /**
   * Encrypted reasoning payload (plan 440 phase 2): OpenAI Responses
   * `reasoning.encrypted_content`, kept so store:false sessions can replay
   * reasoning server-side.
   */
  encrypted?: string;
}

/**
 * Opaque carrier for provider-native content that duya's block model does
 * not natively represent (plan 440): Anthropic server-side tool blocks
 * (`server_tool_use`, `web_search_tool_result`, `code_execution_*`,
 * `text_editor_*`), OpenAI Responses output items (`web_search_call`,
 * `code_interpreter_call`, `mcp_call`, `image_generation_call`, ...).
 * Parsers degrade unknown blocks into this carrier instead of dropping
 * them, so history replay stays valid. See api/degrade.ts for the
 * forward-or-downgrade outbound rule.
 */
export interface ProviderBlockContent {
  type: 'provider_block';
  /** API format whose stream produced this block. */
  origin: ApiFormat;
  /** Verbatim provider type tag, e.g. 'server_tool_use', 'web_search_call'. */
  kind: string;
  /** Verbatim provider payload (block / item object as received). */
  payload: unknown;
}

export type MessageContent =
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent
  | ProviderBlockContent;

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
  /**
   * Per-call usage ledger (pi-style). A tool-heavy turn emits one entry per
   * LLM API call; each entry snapshots the model / provider that produced
   * it, so a session that switches models mid-turn attributes every call to
   * the exact model that generated it. Absent on legacy records — parsers
   * fall back to the top-level cumulative fields.
   */
  calls?: UsageCall[];
  /**
   * Plan 445: single-call usage snapshot of the LARGEST-prompt call of the
   * turn (NOT necessarily the latest — see comment in
   * agent-process-entry.ts result handler). The cumulative top-level fields
   * sum every LLM call of the turn, which inflates the persisted anchor
   * ~N× on tool-heavy turns (10 tool_use = 10× the actual context size).
   * normalizePromptTokens / computeContextEstimate prefer this on reload
   * so the ring recovers to the real single-call prompt volume.
   *
   * Field shape mirrors the top-level usage block (no nested calls ledger).
   */
  last_call?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_hit_tokens?: number;
    cache_creation_tokens?: number;
  };
}

/**
 * Single LLM API call usage detail. Mirrors Anthropic's per-request usage
 * block; aliases for OpenAI-compatible gateways are normalized at parse time
 * (see packages/agent/src/process/call-usage.ts).
 */
export interface UsageCall {
  input_tokens: number;
  output_tokens: number;
  cache_hit_tokens?: number;
  cache_creation_tokens?: number;
  /** Reasoning tokens — a subset of output_tokens, never double-counted. */
  reasoning_tokens?: number;
  /** Anthropic ephemeral 1h cache write tokens. */
  cache_write_1h_tokens?: number;
  total_tokens?: number;
  /** Model id snapshot at the moment this call was made (hot-swap exact). */
  model?: string;
  /** Provider id snapshot at the moment this call was made. */
  provider_id?: string;
}

// ─── Stop reason ───

export type StopReason =
  | 'completed'
  | 'aborted'
  | 'max_turns'
  /** Output budget exhausted (OpenAI `finish_reason: 'length'`, Anthropic
   *  `stop_reason: 'max_tokens'`). Distinct from the run-level 'max_turns'
   *  cap: the DuyaAgent truncation guard keys on this value to fail
   *  partially-streamed tool calls (plan 418 L2). */
  | 'max_tokens'
  | 'error'
  | 'tool_use'
  | 'end_turn'
  | 'stop_sequence'
  | 'repeated_tool_calls';

// ─── SSE Event types (migrated from packages/agent) ───
// mode_changed.mode uses `string` instead of AgentRuntimeMode to avoid
// a dependency on agent-specific types. packages/agent can narrow it.

/**
 * Plan 450 Phase D: structured parameter display. The renderer
 * surfaces these as tidy label:value rows above the raw input JSON.
 */
export type ConnectorToolParamsDisplayEntry = {
  name: string;
  label: string;
  value: string;
};

export interface PermissionRequestEvent {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  mode: 'generic' | 'ask_user_question' | 'exit_plan_mode';
  expiresAt: number;
  decisionReason?: string;
  /**
   * Optional structured metadata attached by the agent core (Plan 450).
   * Currently used to carry `toolParamsDisplay` for connector tools so
   * the approval card can render a labeled summary instead of raw JSON.
   */
  metadata?: { toolParamsDisplay?: ConnectorToolParamsDisplayEntry[] };
}

export interface AgentProgressEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'started' | 'done' | 'error' | 'hook_invoked';
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
  /**
   * Plan 437: when `type === 'hook_invoked'`, the rest of the payload
   * (hookEventName / hookType / hookName / additionalContext / status /
   * durationMs / async / seq / ...) is carried as a nested object so
   * the existing flat envelope passes through unchanged. The renderer
   * unwraps this in `handleAgentProgressEvent`.
   */
  hookEvent?: {
    hookEventName: string;
    hookType: 'command' | 'process' | 'prompt' | 'http' | 'agent';
    hookName: string;
    matcher?: string;
    additionalContext?: string;
    exitCode?: number;
    async: boolean;
    backgroundTaskId?: string;
    durationMs: number;
    status: 'ok' | 'error' | 'timeout' | 'skipped';
    errorMessage?: string;
    seq: number;
    toolName?: string;
    toolUseId?: string;
  };
}

export type SSEEvent =
  | { type: 'text'; data: string }
  | { type: 'tool_use_started'; data: ToolUse }
  /** Plan 461: incremental tool-call argument fragment. `delta` is a raw
   *  JSON slice (not a complete object) — consumers must accumulate by
   *  `id` and parse leniently. Never persisted; it exists only so the UI
   *  can render a tool call's arguments while the model is still
   *  producing them (Codex/pi TUI parity). */
  | { type: 'tool_use_delta'; data: { id: string; name: string; delta: string } }
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
  /**
   * `retryReason` / `errorType` / `statusCode` are Plan 462 additions: the
   * retry notice carries the provider's own wording so the UI can explain
   * *why* it is reconnecting instead of showing a bare counter.
   */
  | { type: 'system'; data: string; metadata?: { retryAttempt?: number; maxAttempts?: number; retryDelayMs?: number; retryReason?: string; errorType?: string; statusCode?: number; diagnostic?: ParameterDiagnostic } }
  | { type: 'text_delta'; data: string }
  | { type: 'thinking_delta'; data: string }
  | { type: 'mode_changed'; data: { mode: string; source: 'agent' | 'user'; reason?: string } }
  | {
      type: 'goal_updated';
      data: {
        state: string;
        phase: string;
        objective: string;
        tokensUsed: number;
        tokenBudget: number;
        consecutiveNotAchieved: number;
        gapsSummary?: string;
        strategyProposal?: string;
      };
    }
  /** Plan 554: deterministic /copy — the renderer writes this to the clipboard. */
  | { type: 'clipboard_write'; data: { text: string } }
  /**
   * Plan 517 P2.2 + P3: compact lifecycle events surfaced to the renderer.
   * `compact:start` / `compact:done` / `compact:error` are the legacy
   * Plan 422 events; `compact:step` (Plan 517 P3) is a per-step boundary
   * inside `compact:start` and `compact:done`; `compact:over_threshold`
   * (Plan 517 P2.2) fires when a successful compaction could not shrink
   * the context under the budget. The renderer mirrors these into the
   * CompactSummary row + the compaction store phase.
   */
  | { type: 'compact:start' }
  | {
      type: 'compact:done';
      data?: {
        strategy?: string;
        tokensRemoved?: number;
        tokensRetained?: number;
        removedCount?: number;
      };
    }
  | { type: 'compact:error'; data: { message?: string } }
  | {
      type: 'compact:step';
      data: {
        step: 'projecting' | 'cutting' | 'summarizing' | 'rebuilding' | 'reinjecting' | 'trimming';
        phase: 'started' | 'finished';
        messageCount?: number;
        tokensBefore?: number;
        tokensEstimated?: number;
        filesCached?: number;
      };
    }
  | {
      type: 'compact:over_threshold';
      data: {
        tokensRetained: number;
        available: number;
      };
    };
// ─── Message types (superset of packages/agent definitions) ───

export interface Message {
  role: MessageRole;
  content: string | MessageContent[];
  id?: string;
  name?: string;
  tool_call_id?: string;
  timestamp?: number;
  /**
   * Tool names loaded at runtime (Plan 418 Phase 4 deferred tools). Set on
   * tool-result carriers when a tool was discovered on-demand (duya
   * tool_search / plan 241). Providers that support `tool_reference` blocks
   * emit a reference instead of resending the tool schema.
   */
  addedToolNames?: string[];
  /** UI-only: whether this message renders in the transcript. Hidden messages
   * (runtime context, notifications) are model/persistence only. */
  visibility?: 'visible' | 'hidden';
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
  /**
   * Message origin classifier (plan 489 P0.1): who produced this message.
   * Canonical values live in `@duya/agent/message` (`MessageSource`); kept
   * as `string` here so @duya/ai stays dependency-free. Inferred at the
   * IPC boundary when absent.
   */
  source?: string;
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

/** Observability metadata captured verbatim from provider responses
 *  (plan 440 phase 2). Never required; consumers must treat as optional. */
export interface ProviderResponseMeta {
  /** OpenAI service tier that served the request ('default', 'flex', ...). */
  serviceTier?: string;
  /** Chat Completions logprobs payload when requested by the caller. */
  logprobs?: unknown;
}

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
  /** Provider observability metadata (plan 440 phase 2), when available. */
  providerMeta?: ProviderResponseMeta;
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

/**
 * How tool results are transported back to the model on Anthropic-protocol
 * wire formats (Plan 418).
 *
 * - 'tool-result-block' (default): standard Anthropic `tool_result` content
 *   blocks, supported by first-party Anthropic and most compatible endpoints.
 * - 'text-user-message': fold tool results into plain-text `user` messages
 *   while keeping `tool_use` blocks on the assistant side. Used for endpoints
 *   whose content-block schema rejects `tool_result` entirely (e.g. the
 *   DeepSeek `/anthropic` compat surface, which only accepts
 *   `text | tool_reference | image | document`).
 */
export type ToolResultTransport = 'tool-result-block' | 'text-user-message' | 'none';

export interface ModelCompat {
  openAIThinkingFormat?: OpenAIThinkingFormat;
  forceAdaptiveThinking?: boolean;
  fixedTemperature?: number;
  ignoredParameters?: string[];
  rejectedParameters?: string[];
  streamOnly?: boolean;
  /**
   * Tool-result transport for Anthropic-protocol endpoints. Defaults to
   * 'tool-result-block' when unset (see resolveToolResultTransport in
   * packages/ai/src/api/anthropic-messages.ts).
   */
  toolResultTransport?: ToolResultTransport;
  /**
   * Whether the endpoint supports Anthropic tool-search style deferred tools
   * loaded by `tool_reference` blocks (Plan 418 Phase 4). Defaults to false
   * for third-party endpoints; only explicitly declared models opt in.
   */
  supportsToolReferences?: boolean;
  /**
   * Whether the endpoint terminates each streamed choice with an explicit
   * `finish_reason`. Defaults to true. A clean stream end without one is
   * treated as a premature close (Plan 439) so truncated output is retried
   * instead of silently executed. Set to false only for servers that
   * legitimately never send a finish_reason.
   */
  supportsFinishReason?: boolean;
  /**
   * Whether the endpoint respects a `thinking_token_budget` parameter that
   * caps the number of tokens spent on internal reasoning/thinking, keeping
   * the rest for the visible answer. When true, duya computes a budget
   * that reserves at least 1024 tokens for the answer and applies it as
   * `thinking_token_budget` in the request. Prevents reasoning-heavy models
   * (e.g. ox-alpha) from consuming the entire `max_tokens` budget in
   * thinking and leaving zero visible output.
   */
  supportsThinkingTokenBudget?: boolean;
  /**
   * Default max output tokens the endpoint accepts for this model, surfaced
   * through findModelCompat so the agent layer requests a sane `max_tokens`
   * instead of falling back to the global 8192 default. Official-harness
   * parity: MiniMax advertises 131072 (M2.x) / 128000 (M3).
   */
  maxOutputTokens?: number;
}

// ─── Model pricing (per million tokens, USD) ───

export interface ModelCostRates {
  /** $/million input tokens. */
  input: number;
  /** $/million output tokens. */
  output: number;
  /** $/million cache-read tokens. */
  cacheRead: number;
  /** $/million cache-write tokens. */
  cacheWrite: number;
}

export interface ModelCostTier extends ModelCostRates {
  /** Use this tier for requests whose total input usage exceeds this token count. */
  inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
  /** Request-wide pricing tiers. The highest matching input threshold applies. */
  tiers?: ModelCostTier[];
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
  /** $/million-token pricing. Optional — absent models report no cost. */
  cost?: ModelCost;
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
  /** Prompt-cache retention. 'long' enables 1h TTL on endpoints that support
   *  it (api.anthropic.com / api.vertex.ai) and is downgraded to ephemeral
   *  elsewhere. Defaults to 'short' (5-minute TTL). */
  cacheRetention?: CacheRetention;
}

export interface AIClient {
  streamChat(
    messages: Message[],
    options?: {
      systemPrompt?: string;
      tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
      /** Plan 523 P4: explicitly disable tool calling for this request (e.g.
       *  a compaction summarizer). When 'none', the tools field is omitted
       *  from the wire payload so the model cannot invoke tools. Official-
       *  harness parity: 'auto'/'any'/named-tool forward the native
       *  tool_choice shape (anthropic protocol). */
      toolChoice?: 'none' | 'auto' | 'any' | { type: 'tool'; name: string };
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

  /** Batch text embedding (plan 428 memory RAG). Returns one vector per
   *  input text. Optional — providers without an embeddings endpoint
   *  (e.g. Anthropic) leave it undefined and callers degrade to keyword
   *  search. */
  embed?(texts: string[]): Promise<number[][]>;
}
