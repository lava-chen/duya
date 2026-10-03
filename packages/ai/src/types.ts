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
 * ## The transcript vocabulary no longer lives here (plan 587 T3.1)
 *
 * `Message`, the content blocks, `TokenUsage`, `UsageCall`, `StopReason`, the
 * permission and progress shapes, and the wire half of `ToolResult` are
 * defined in `@duya/agent-protocol/transcript` and RE-EXPORTED here
 * unchanged, so no consumer's source had to change. This file keeps what is
 * genuinely the provider layer: `Model`, `ModelCompat`, `AIClient`, the
 * thinking-level vocabulary, and `SSEEvent`.
 *
 * `SSEEvent` stayed rather than moving with the rest, because its
 * `tool_result` member carries the Promise-bearing `ToolResult` — see the
 * comment on the union below. `ToolResult` split into `ToolResultWire` (moved,
 * pure JSON) and `DeferredToolExtras` (stayed, the two Promises), joined at
 * runtime as `RuntimeToolResult`.
 *
 * @see packages/agent-protocol/MIGRATION.md for the compatibility window and
 * the named removal tasks.
 */

import type { CacheRetention } from './utils/prompt-caching.js';

// Imported (not just re-exported) because the rest of this file — SSEEvent,
// AssistantMessageEvent, Model, AIClient — annotates with these names, and
// `export type { X } from '...'` does not put X in this file's scope.
// The `export type { ... }` blocks further down are what make them part of
// this module's PUBLIC surface; the two are separate jobs.
import type {
  AgentProgressEvent,
  ApiFormat,
  AssistantMessage,
  DeferredToolExtras,
  Message,
  MessageContent,
  MessageRole,
  PermissionRequestEvent,
  StopReason,
  TextContent,
  ThinkingContent,
  TokenUsage,
  ToolGroupProgressSource,
  ToolResultWire,
  ToolUse,
  ToolUseContent,
} from '@duya/agent-protocol/transcript';

// ─── Moved to @duya/agent-protocol/transcript ───
//
// Plan 587 T3.1: the pure data crossed over to the protocol package so there
// is one definition of it rather than three drifting copies. These names are
// still exported here with identical structure, so no consumer's source
// changes; only the definition site moved.
//
// @deprecated Import from `@duya/agent-protocol/transcript`. Removal task
// 587-T3-1-REMOVE-TRANSCRIPT, gated on the compatibility window in
// `packages/agent-protocol/MIGRATION.md`.
export type {
  ApiFormat,
  MessageRole,
  MessageContentType,
} from '@duya/agent-protocol/transcript';

// ─── Content block types (now owned by the protocol) ───

export type {
  TextContent,
  ImageContent,
  ToolUseContent,
  ToolResultContent,
  ThinkingContent,
  ProviderBlockContent,
  MessageContent,
} from '@duya/agent-protocol/transcript';

/** @deprecated Import `MESSAGE_CONTENT_TYPES` from `@duya/agent-protocol/transcript`. */
export { MESSAGE_CONTENT_TYPES } from '@duya/agent-protocol/transcript';

// ─── Tool types ───

export type {
  ToolUse,
  ToolGroupProgressSource,
  ToolResultMetadata,
  ToolResultImage,
} from '@duya/agent-protocol/transcript';

/**
 * The RUNTIME tool result: the wire half plus two in-process handshakes.
 *
 * Plan 587 T3.1 split what used to be one interface in two. Everything a
 * transcript row, an SSE `tool_result` frame, or a checkpoint can hold moved
 * to `ToolResultWire` in `@duya/agent-protocol/transcript`, because a `Promise`
 * has no JSON representation and contract §A forbids one on the wire.
 *
 * The two Promise fields could not move, so they stay here and are intersected
 * back on at runtime. `RuntimeToolResult` is therefore not a projection of the
 * old type — it is the same object minus the two fields that were never on the
 * wire. `toToolResultWire()` in `./tool-result-wire.js` is the explicit
 * serializer that produces the wire form; nothing derives it structurally.
 *
 * The names `ToolResult` and `RuntimeToolResult` are the same type. Both are
 * exported because `ToolResult` appears 305 times across 100 files under
 * `packages/`, and renaming them is a behaviour-shaped diff, not a move.
 */
export type RuntimeToolResult = ToolResultWire & DeferredToolExtras;

/**
 * @deprecated Alias of {@link RuntimeToolResult}, kept so the existing
 * `ToolResult` annotations keep compiling unchanged. Removal task
 * 587-T3-1-RENAME-TOOLRESULT, in the same window as 587-T3-1-REMOVE-TRANSCRIPT.
 */
export type ToolResult = RuntimeToolResult;

/**
 * @deprecated Import from `@duya/agent-protocol/transcript`.
 */
export type { ToolResultWire, DeferredToolExtras } from '@duya/agent-protocol/transcript';

// ─── Token usage ───

export type { TokenUsage, UsageCall } from '@duya/agent-protocol/transcript';

/** @deprecated Import `StopReason` from `@duya/agent-protocol/transcript`. */
export type { StopReason } from '@duya/agent-protocol/transcript';

// ─── SSE Event types ───
// `SSEEvent` stays HERE rather than moving to the protocol, and the reason is
// worth stating because it looks like an oversight.
//
// Every other moved type is pure JSON. `SSEEvent` is not: its `tool_result`
// member carries `data: ToolResult`, and the runtime `ToolResult` holds two
// Promises. Moving the union would have meant either dropping those two fields
// from the event payload — losing them for a tidier type, which is the failure
// this task forbids — or restructuring how the frame is built, which is
// behaviour and belongs in the router cutover PR.
//
// The event TYPE strings are already mapped table-first in
// `@duya/agent-protocol/legacy` (`SSE_EVENT_TO_PROTOCOL`), so the cutover plan
// exists without moving this union. Removal task 587-T3-1-MOVE-SSE-UNION.
//
// `mode_changed.mode` stays `string` rather than the closed
// `AgentRuntimeMode` so this file keeps no agent dependency.

/**
 * Plan 450 Phase D: structured parameter display. The renderer
 * surfaces these as tidy label:value rows above the raw input JSON.
 *
 * @deprecated Import from `@duya/agent-protocol/transcript`.
 *
 * Note the Desktop carries a SUPERSET of `PermissionRequestEvent`: it adds
 * `connector` and `suggestions` (see `stream.ts` in apps/desktop). Pointing the
 * renderer at this shape would compile and silently drop "Always allow" for
 * app-connection tools, so the two were deliberately NOT merged here. Merging
 * them is router work — removal task 587-T3-1-MERGE-PERMISSION-EVENT.
 */
export type {
  ConnectorToolParamsDisplayEntry,
  PermissionRequestEvent,
  AgentProgressEvent,
  HookEventPayload,
} from '@duya/agent-protocol/transcript';

export type SSEEvent =
  | { type: 'text'; data: string }
  | { type: 'tool_use_started'; data: ToolUse }
  /** Plan 461: incremental tool-call argument fragment. `delta` is a raw
   *  JSON slice (not a complete object) — consumers must accumulate by
   *  `id` and parse leniently. Never persisted; it exists only so the UI
   *  can render a tool call's arguments while the model is still
   *  producing them (Codex/pi TUI parity). */
  | { type: 'tool_use_delta'; data: { id: string; name: string; delta: string } }
  | { type: 'tool_use'; data: ToolUse & { /** Provider thought signature (Gemini functionCall thoughtSignature) for replay continuity. */ signature?: string } }
  | { type: 'tool_group_progress'; data: { groupId?: string; title: string; source: ToolGroupProgressSource } }
  | { type: 'tool_result'; data: ToolResult }
  | { type: 'tool_progress'; data: { toolName: string; elapsedSeconds: number } }
  | { type: 'tool_timeout'; data: { toolName: string; elapsedSeconds: number } }
  | { type: 'thinking'; data: string; signature?: string; /** True when the provider redacted the reasoning (Anthropic redacted_thinking) — data is empty. */ redacted?: boolean; /** Opaque encrypted reasoning payload to replay as redacted_thinking. */ encrypted?: string }
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
// ─── Message types (now owned by the protocol) ───

/**
 * `Message` mixes four concerns on one interface — provider request body,
 * durable row, and renderer view — so it is classified field by field rather
 * than split. `visibility` is the clearest: read only by the renderer, and
 * meaningless to both a provider and a storage row. The full per-field record
 * is `MESSAGE_FIELDS` in `@duya/agent-protocol/transcript`.
 *
 * @deprecated Import from `@duya/agent-protocol/transcript`. Removal task
 * 587-T3-1-REMOVE-TRANSCRIPT.
 */
export type { Message, AssistantMessage, ProviderResponseMeta } from '@duya/agent-protocol/transcript';

// ─── Reasoning capability types (NEW) ───

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelThinkingLevel = 'off' | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

export type OpenAIThinkingFormat =
  | 'openai-standard'
  | 'reasoning-content'
  | 'qwen-style'
  | 'glm-style'
  /** DeepSeek V4+ hybrid-thinking toggle: `thinking: {type: enabled|disabled}`. */
  | 'deepseek-style'
  /** OpenRouter aggregator: `reasoning: {effort}` ('none' disables). */
  | 'openrouter-style'
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
  /**
   * DeepSeek thinking mode: every assistant message in history must carry a
   * `reasoning_content` field (empty string when that turn had no thinking),
   * otherwise the endpoint 400s when the request also carries tools.
   * Official-harness parity (pi-mono openai-completions detectCompat).
   */
  requiresReasoningContentOnAssistantMessages?: boolean;
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
  /**
   * Whether the endpoint accepts thinking blocks replayed with an empty
   * `signature`. When true, unsigned thinking from history is replayed as a
   * NATIVE thinking block (`signature: ""`) instead of being downgraded to
   * plain text. Official-harness parity (pi-mono compat.allowEmptySignature).
   *
   * Why it matters: downgrading unsigned thinking to text puts the model's
   * own reasoning into the assistant text channel of the replayed history.
   * Reasoning models imitate the channel distribution they see, so over a
   * long session the reasoning progressively leaks into the text channel —
   * observed live on MiniMax-M3 as "thinking paragraph overflow" (reasoning
   * rendered as visible reply text between tool calls). Verified 2026-09-23:
   * api.minimaxi.com/anthropic accepts `signature: ""` thinking blocks and
   * keeps reasoning classification clean when history preserves them.
   */
  allowEmptySignature?: boolean;
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
