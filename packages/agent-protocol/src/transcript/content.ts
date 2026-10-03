/**
 * Transcript content vocabulary — the JSON shapes that carry a conversation.
 *
 * ## Why this lives in the protocol, and why it is NOT the event vocabulary
 *
 * `events/payloads.ts` already owns the protocol's own `TextContent`,
 * `ToolUse` and `MessageContent`. Those are the shapes the run event stream
 * uses, and they are deliberately narrower and deliberately different:
 * camelCase field names, `ToolCallOutcome` instead of an `error?: boolean`,
 * and no image or provider-native blocks.
 *
 * This file is the OTHER vocabulary: the one the transcript store has always
 * persisted and the one `@duya/ai` has always sent. snake_case token counts,
 * `error?: boolean`, images, and an opaque carrier for provider blocks the
 * block model cannot represent.
 *
 * ## Why the two are not collapsed
 *
 * They genuinely differ, and collapsing them would be the exact failure this
 * task forbids — "a smaller union that silently loses a field". Measured
 * differences, not stylistic ones:
 *
 *   - `ImageContent` and `ProviderBlockContent` exist ONLY here. The event
 *     union's `MessageContent` has four members; this one has six.
 *   - `ToolResultContent.content` is `string | MessageContent[]`, so a tool
 *     result can itself carry image blocks. The event `ToolResult.content` is
 *     `string`.
 *   - `TextContent.phase` is the closed set `'commentary' | 'final_answer'`
 *     here and `string` in the event payload. Narrowing the closed set to
 *     `string` loses an invariant; widening it loses the invariant in the
 *     other direction.
 *   - `TokenUsage.upstreamProvider`, `UsageCall.reasoning_tokens` and
 *     `UsageCall.cache_write_1h_tokens` have no event-payload equivalent.
 *
 * So both shapes are kept, each in its own module, each named by the surface
 * it belongs to. The rule for which one a caller wants is in
 * `classification.ts`, and the field-by-field record is enforced by
 * `test/23-wire-field-classification.test.ts`.
 *
 * ## Why a subpath and not the main entry
 *
 * The main entry already exports a `MessageContent`, a `TokenUsage` and a
 * `StopReason`. Re-exporting these names there would be a compile error, and
 * the fix — renaming one side — would rename types in every consumer's
 * source. A subpath keeps the names byte-identical to what `@duya/ai` has
 * always exported, so the compatibility shim is a genuine re-export rather
 * than a rename. It also follows this package's own rule: `legacy/` and
 * `testing/` are subpaths precisely so they cannot become permanent parts of
 * the main surface.
 *
 * @see ./classification.ts for the per-field record
 * @see ../events/payloads.ts for the event vocabulary this must not shadow
 * @deprecated Import from `@duya/agent-protocol/transcript`. Scheduled for
 * removal one release after the `@duya/ai` consumer migration lands; see
 * plan 587 T3.1 removal task 587-T3-1-REMOVE-TRANSCRIPT.
 */

/**
 * Provider wire dialect. A plain string union with no provider dependency:
 * naming a dialect is not importing the provider SDK, and protocol stays a
 * leaf.
 */
export type ApiFormat =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'bedrock'
  | 'vertex';

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

// ── content blocks ────────────────────────────────────────────────────────

export interface TextContent {
  type: 'text';
  text: string;
  /** Provider signature for text content (Anthropic text signature). */
  textSignature?: string;
  /** Exact Responses API phase. Only 'commentary' is used for tool progress titles. */
  phase?: 'commentary' | 'final_answer';
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
  /** Stable identity for the UI group that owns this tool call. */
  groupId?: string;
  /** Sanitized user-facing progress title for the owning tool group. */
  progressTitle?: string;
  /** Source of the title, or the deterministic tool fallback. */
  progressSource?: ToolGroupProgressSource;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  /** A tool result may itself carry blocks, including images. */
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
 *
 * Parsers degrade unknown blocks into this carrier instead of dropping them,
 * so history replay stays valid. Degradation happens on the provider boundary;
 * this shape only has to survive JSON.
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

export const MESSAGE_CONTENT_TYPES = [
  'text',
  'image',
  'tool_use',
  'tool_result',
  'thinking',
  'provider_block',
] as const;

export type MessageContentType = (typeof MESSAGE_CONTENT_TYPES)[number];

// ── compile-time completeness ─────────────────────────────────────────────

/**
 * The "no variant was dropped" guarantee, enforced where it is actually
 * checked.
 *
 * ## Why this lives in `src/` and not in `test/`
 *
 * `packages/agent-protocol/tsconfig.json` excludes `test`, and the root
 * tsconfig covers only the desktop renderer and conductor. So NOTHING in CI
 * ever typechecks a protocol test file — vitest runs them through esbuild,
 * which strips types without checking them. A union-completeness assertion
 * written in a test is therefore decorative: it passes whether or not the
 * assertion holds.
 *
 * That was measured, not assumed. Removing `ImageContent` from
 * `MessageContent` while leaving this file's own constant untouched left
 * `test/23-wire-field-classification.test.ts` fully green — 20 passed — because
 * the constant and the union had silently drifted apart and no compiler was
 * watching. These checks are in `src/` so `npm run build:protocol` and
 * `npm run typecheck:protocol` see them.
 */

/** The `type` tag of one content variant. */
type TagOf<C> = C extends { type: infer T extends string } ? T : never;

/** Exact-type equality. Not assignability: this must catch BOTH directions. */
type IsExactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Every tag the `MessageContent` union actually admits. */
export type MessageContentTag = TagOf<MessageContent>;

/** Every tag `MESSAGE_CONTENT_TYPES` declares. */
export type DeclaredMessageContentTag = (typeof MESSAGE_CONTENT_TYPES)[number];

/**
 * Fails to COMPILE if `MessageContent` and `MESSAGE_CONTENT_TYPES` disagree —
 * a variant dropped from the union, or a tag in the list with no variant.
 *
 * This is the check that makes "a smaller union that silently loses a field"
 * impossible to land: dropping `ImageContent` (and with it every inline image
 * and every provider block the model cannot express) breaks the build instead
 * of quietly narrowing a type.
 */
export type MessageContentUnionIsComplete = IsExactly<
  MessageContentTag,
  DeclaredMessageContentTag
>;

export const MESSAGE_CONTENT_UNION_IS_COMPLETE: MessageContentUnionIsComplete = true;

/**
 * Where a tool group progress title came from.
 *
 * Three sources, one per producer: the provider narrating its own tool
 * progress, a model-invoked progress tool, and the deterministic fallback
 * used when neither fires. Closed because the renderer switches on it.
 *
 * Declared here rather than in `./tool-result.ts` because `ToolUseContent`
 * above already uses it, and `tool-result.ts` imports from this file — the
 * reverse would be a module cycle.
 */
export type ToolGroupProgressSource = 'provider_commentary' | 'model_progress_tool' | 'tool_fallback';

// ── messages ──────────────────────────────────────────────────────────────

/**
 * One stored / transmitted message.
 *
 * This shape carries three concerns at once, which is why it is classified
 * field by field rather than split wholesale:
 *
 *   - the provider request body (`role`, `content`, `addedToolNames`),
 *   - the durable transcript row (`metadata`, `msg_type`, `seq_index`),
 *   - the renderer's view (`visibility`, `displayContent`).
 *
 * `visibility` is the clearest case: it is read only by the renderer and is
 * meaningless to a provider, so it is classified `ui-view` even though it
 * lives on the same interface. See `classification.ts`.
 */
export interface Message {
  role: MessageRole;
  content: string | MessageContent[];
  id?: string;
  name?: string;
  tool_call_id?: string;
  timestamp?: number;
  /**
   * Tool names loaded at runtime (Plan 418 Phase 4 deferred tools). Set on
   * tool-result carriers when a tool was discovered on-demand. Providers that
   * support `tool_reference` blocks emit a reference instead of resending the
   * tool schema.
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
   * The canonical values live in `@duya/agent/message`; kept as `string`
   * here so the protocol stays free of agent vocabulary. Inferred at the IPC
   * boundary when absent.
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
  /** Provider ID that produced this message (for isSameModel guard) */
  providerId?: string;
  /** Model name that produced this message */
  model?: string;
  /** API format used to produce this message */
  api?: ApiFormat;
}

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
  api?: ApiFormat;
  providerId?: string;
  model?: string;
  responseId?: string;
  usage?: TokenUsage;
  /** Provider observability metadata (plan 440 phase 2), when available. */
  providerMeta?: ProviderResponseMeta;
  stopReason?: StopReason;
}

// ── usage ─────────────────────────────────────────────────────────────────

/**
 * Per-turn token accounting as the transcript store records it.
 *
 * snake_case because that is how the rows are written and how
 * `packages/agent/src/process/call-usage.ts` reads them back. The event
 * vocabulary's `TokenUsage` is camelCase and is NOT interchangeable — see
 * `../events/payloads.ts`.
 */
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
   * turn (NOT necessarily the latest). The cumulative top-level fields sum
   * every LLM call of the turn, which inflates the persisted anchor ~Nx on
   * tool-heavy turns (10 tool_use = 10x the actual context size).
   * normalizePromptTokens / computeContextEstimate prefer this on reload so
   * the ring recovers to the real single-call prompt volume.
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
 *
 * Every field is optional except the two counters. That is deliberate: a
 * recorded call must not be dropped because one provider omitted a bucket.
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

/**
 * Why a turn or run stopped, as the agent runtime emits it.
 *
 * Nine values, and all nine are load-bearing. This is NOT the protocol
 * event vocabulary's `StopReason` (six values, pinned to the event stream);
 * see `../events/payloads.ts` for why the two differ. Collapsing them would
 * drop `max_turns`, `max_tokens`, `tool_use` and `repeated_tool_calls` from
 * every transcript written by the current runtime.
 */
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

/**
 * Every `StopReason` member, as a value.
 *
 * Exists so the union above can be checked for completeness at compile time
 * (`STOP_REASON_IS_COMPLETE`), for the same reason `MESSAGE_CONTENT_TYPES`
 * exists. Four of the nine members — `max_turns`, `max_tokens`, `tool_use` and
 * `repeated_tool_calls` — have no counterpart in the event vocabulary's
 * six-value `StopReason`, so a union narrowed to that vocabulary would compile
 * and silently drop the run-level turn cap, the output-budget cap, and the
 * repeated-tool-call guard.
 */
export const STOP_REASONS = [
  'completed',
  'aborted',
  'max_turns',
  'max_tokens',
  'error',
  'tool_use',
  'end_turn',
  'stop_sequence',
  'repeated_tool_calls',
] as const;

/** Fails to COMPILE if a `StopReason` member is added to or removed from the
 *  union without updating `STOP_REASONS`. See `MESSAGE_CONTENT_UNION_IS_COMPLETE`. */
export type StopReasonIsComplete = IsExactly<StopReason, (typeof STOP_REASONS)[number]>;

export const STOP_REASON_IS_COMPLETE: StopReasonIsComplete = true;

/** @see legacy/sse-event.ts for the cutover table to the event vocabulary. */
export type { LegacySseEventType } from '../legacy/sse-event.js';

