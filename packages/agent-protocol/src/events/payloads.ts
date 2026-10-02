/**
 * Payload shapes for every event on the wire.
 *
 * ## `RunEventPayloads` is the single source of truth
 *
 * It is an INTERFACE keyed by event type, which buys two things a mapped type
 * over a const array cannot:
 *
 *  1. `RunEvent` is derived from `keyof RunEventPayloads`, so adding a key
 *     widens the union and the compiler immediately flags every exhaustive
 *     `switch (e.type)` that has not been updated.
 *  2. `EVENT_META` in registry.ts is typed `{ [K in EventType]: EventMeta }`,
 *     so a payload without runtime metadata — and metadata without a payload —
 *     are BOTH compile errors. No drift is representable.
 *
 * A const array carrying a phantom `payload` field cannot do (2): `payload:
 * null!` erases to `null` at runtime, so the derived union would carry `null`
 * instead of the interface. grok-build gets away with a macro here; a
 * TypeScript project cannot generate a type, so the union is written out and
 * a test holds it to `keyof RunEventPayloads`.
 *
 * ## Exclusions enforced by construction
 *
 *  - No `Map` / `Set` anywhere: `ToolPermissionRulesBySource` holds three
 *    `ReadonlyMap`s and cannot cross JSON. `PermissionRulesWire`
 *    is the flattened `Record` replacement.
 *  - No callbacks, no `ToolResult.pendingExtraResult` / `pendingContext`
 *    (delayed handles that must be resolved BEFORE the protocol boundary).
 *  - No credentials. `RunManifest.env` is `{ ref, hash }`; the Control Plane
 *    owns resolution and it never crosses this boundary.
 */

import type {
  AgentProfileId,
  CompactionId,
  ConnectorBinding,
  EventTimestamp,
  Millis,
  ProjectId,
  ProviderId,
  RequestId,
  RunBudget,
  RunId,
  SessionId,
  SubagentId,
  TaskId,
  ToolCallId,
  TraceId,
  TurnId,
  WorkspaceId,
} from '../primitives.js';
import type {
  PermissionResponse,
  PermissionKind,
  PermissionRequestMode,
  PermissionScope,
  PermissionSource,
} from '../permission.js';
import type { ProtocolErrorInfo } from '../errors.js';

// ── content blocks ────────────────────────────────────────────────────────

/**
 * Why a turn or run stopped.
 *
 * These are the values the agent actually produces, verbatim. An earlier draft
 * used a provider API's stop-reason vocabulary (`tool_use`, `refusal`) plus
 * two protocol-only values, and omitted the two the code really emits —
 * `length` for a token or context ceiling and `completed` for a normal finish.
 * A closed union is only worth having if it is pinned to its source; otherwise
 * it is a list of words a host will branch on that never arrive.
 *
 * Providers differ: some report `max_tokens` where this reports `length`. The
 * adapter normalises to the runtime's own spelling and puts the raw provider
 * value in `DiagnosticDetail` when a caller needs it.
 */
export type StopReason =
  | 'completed'
  | 'length'
  | 'end_turn'
  | 'stop_sequence'
  | 'aborted'
  | 'error';

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens: number;
  /** Per-call breakdown. `last_call` is the aggregate for the turn. */
  readonly calls?: readonly UsageCall[];
  readonly last_call?: UsageCall;
}

export interface UsageCall {
  readonly model: string;
  readonly providerId?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
}

export interface TextContent {
  readonly type: 'text';
  readonly text: string;
  readonly textSignature?: string;
  readonly phase?: string;
}

export interface ThinkingContent {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly thinkingSignature?: string;
  readonly redacted?: boolean;
  readonly encrypted?: boolean;
}

/** Tool invocation. NOTE: the 7.3 `Tool.mcpInfo` dispatch closure does not
 *  cross this boundary — only the descriptor shape. */
export interface ToolUse {
  readonly type: 'tool_use';
  readonly id: ToolCallId;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly mcp?: { readonly server: string; readonly tool: string };
}

/**
 * How a tool call ended, stated explicitly.
 *
 * ## Why not a boolean
 *
 * The legacy wire carries the failure bit in three places and all three are
 * optional: `error?: boolean` on the worker's `chat:tool_result`
 * (packages/agent/src/process/worker-protocol.ts:299-305, relayed verbatim by
 * router.ts:506), `is_error?: boolean` on `@duya/ai`'s `ToolResultContent`
 * (packages/ai/src/types.ts:75-80), and nothing at all on the stored rows. An
 * absent bit is indistinguishable from a successful call, so a failed tool and
 * a silent one are the same value on the wire and in the transcript.
 *
 * Making the field REQUIRED does not fix that — it only moves the lie. The
 * adapter would have to invent `false` for every call whose producer omitted
 * the bit, and nothing distinguishes an invented success from a real one.
 *
 * So absence gets its own outcome. `indeterminate` means "the producer did not
 * say", and a host can treat it differently from `success`: a cost dashboard
 * can count it, a correctness check can flag it, and a transcript can render it
 * as unknown rather than as a clean result.
 *
 * @see ToolCallCompletedPayload
 * @see ToolResult
 */
export type ToolCallOutcome =
  | { readonly outcome: 'success' }
  | { readonly outcome: 'tool_error'; readonly error: ProtocolErrorInfo }
  | { readonly outcome: 'timeout'; readonly afterMs: number }
  | { readonly outcome: 'cancelled'; readonly reason: string }
  /**
   * The producer emitted a completion with no status. The ONLY correct way for
   * an adapter to produce this is to pass the absence through.
   */
  | { readonly outcome: 'indeterminate'; readonly note: string };

export interface ToolResult {
  readonly type: 'tool_result';
  readonly toolCallId: ToolCallId;
  readonly content: string;
  /** Explicit outcome. See `ToolCallOutcome` for why this is not a boolean. */
  readonly outcome: ToolCallOutcome;
  readonly durationMs?: Millis;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly blocks?: readonly string[];
  readonly structured?: Readonly<Record<string, unknown>>;
  readonly images?: readonly { readonly mediaType: string; readonly data: string }[];
}

export type MessageContent = TextContent | ThinkingContent | ToolUse | ToolResult;

export interface MessageEntry {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: readonly MessageContent[];
  readonly timestamp: EventTimestamp;
}

// ── run ───────────────────────────────────────────────────────────────────

export interface RunStartedPayload {
  readonly manifestHash: string;
  readonly protocol: { readonly major: number; readonly minor: number };
  readonly runtime: { readonly name: string; readonly version: string; readonly pid?: number };
  readonly resumedFrom?: ResumeBoundaryRef;
}
export interface ResumeBoundaryRef {
  readonly kind: string;
  readonly value: string | number;
}

export type PausePoint = 'turn_boundary' | 'tool_boundary' | 'any';

export interface RunPausedPayload {
  readonly at: PausePoint;
}

export type RunStatus = 'completed' | 'cancelled' | 'budget_exhausted';

export interface RunCompletedPayload {
  readonly status: RunStatus;
  readonly stopReason?: StopReason;
  readonly usage?: TokenUsage;
  /** Set when the host asked; distinguishes "we stopped it" from "it ended". */
  readonly cancelRequested?: boolean;
}

/**
 * Terminal run failure.
 *
 * Carries a `ProtocolErrorInfo`, not a free-form `{ code, message }`. An
 * earlier draft used `{ code: string; message: string; details?: unknown }`,
 * which quietly reopened the taxonomy this package exists to close: every
 * closed `ErrorCode` in `errors.ts` would have had a second, stringly-typed
 * escape hatch at exactly the moment a host most needs to branch on it.
 */
export interface RunFailedPayload {
  readonly error: ProtocolErrorInfo;
}

// ── turn ──────────────────────────────────────────────────────────────────

export interface TurnStartedPayload {
  readonly turnId: TurnId;
  readonly index: number;
  readonly model: string;
  readonly providerId: ProviderId;
  readonly apiFormat: 'anthropic' | 'openai';
  readonly effort?: string;
}

/**
 * A model turn is being retried.
 *
 * `reason` is the worker's own `message`; there is no separate `errorClass`
 * on the source event. An earlier draft had one, which meant a host could
 * branch on a classification nothing ever produced. Classify at the adapter
 * from `reason` if a caller needs a bucket, and say so in a diagnostic rather
 * than asserting a field that arrives empty.
 */
export interface TurnRetryScheduledPayload {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly reason: string;
}

export interface TurnCompletedPayload {
  readonly turnId: TurnId;
  readonly index: number;
  readonly stopReason: StopReason;
  readonly usage: TokenUsage;
  readonly durationMs: Millis;
}

// ── assistant ─────────────────────────────────────────────────────────────

export interface AssistantTextBlockPayload {
  readonly messageId: string;
  readonly index: number;
  readonly text: string;
  readonly textSignature?: string;
  readonly phase?: string;
}

export interface AssistantTextDeltaPayload {
  readonly messageId: string;
  readonly index: number;
  readonly delta: string;
}

export interface AssistantThinkingBlockPayload {
  readonly messageId: string;
  readonly index: number;
  readonly thinking: string;
  readonly thinkingSignature?: string;
  readonly redacted?: boolean;
  readonly encrypted?: boolean;
}

export interface AssistantThinkingDeltaPayload {
  readonly messageId: string;
  readonly index: number;
  readonly delta: string;
}

export interface AssistantMessageFinalizedPayload {
  readonly messageId: string;
  readonly content: readonly MessageContent[];
  readonly stopReason: StopReason;
  readonly usage?: TokenUsage;
  readonly providerMeta?: Readonly<Record<string, unknown>>;
}

export interface AssistantUsagePayload {
  readonly usage: TokenUsage;
}

/**
 * The agent's behavioural mode — what the `SwitchMode` tool switches between,
 * and what the renderer shows as the input-box chip.
 *
 * The values are the agent's own, verbatim. An earlier draft of this file
 * invented a third vocabulary (`default | plan | research | conductor | goal`)
 * by reading the legacy SSE union, where `mode` is only `string` and therefore
 * carries no information at all. That draft was wrong twice over: it invented
 * values the runtime never emits, and it mixed in the plan-224 popover
 * `ModeModifier` vocabulary, which is a different layer entirely and is already
 * carried by `RunManifest.capabilities.modes`.
 *
 * A closed set is worth having, but only once it is pinned to what the runtime
 * actually produces. Anything else is a rename that silently changes meaning.
 */
export const ASSISTANT_MODES = ['general', 'plan', 'explore', 'verify', 'code-review'] as const;

/** One of the agent's behavioural modes. */
export type AssistantMode = (typeof ASSISTANT_MODES)[number];

export interface AssistantModeChangedPayload {
  readonly mode: AssistantMode;
  /** Who initiated the switch. The agent switches itself via the mode tool. */
  readonly source: 'agent' | 'user';
  readonly reason?: string;
}

export type GoalState = 'idle' | 'active' | 'achieved' | 'exhausted' | 'paused';

/** One entry of a goal's audit trail. */
export interface GoalHistoryEntry {
  readonly at: EventTimestamp;
  /** What happened, e.g. `worker_round_complete`, `verification_failed`. */
  readonly event: string;
  readonly detail?: string;
  /** Why it happened, when the reason is not implied by `event`. */
  readonly reason?: string;
}

/**
 * Progress on a long-running goal.
 *
 * Every field the worker emits is preserved. A projection that drops fields
 * looks harmless at the type level and is a silent data loss at runtime: the
 * UI reads `pauseMessage` to render the pause card and `totalWorkerRounds` for
 * the turn counter, and neither can be reconstructed from the rest.
 */
export interface AssistantGoalUpdatedPayload {
  readonly state: GoalState;
  readonly phase: string;
  readonly objective: string;
  readonly tokensUsed: number;
  readonly tokenBudget: number;
  readonly consecutiveNotAchieved: number;
  readonly gapsSummary?: string;
  readonly strategyProposal?: string;
  /** Human-readable explanation shown while the goal is parked. */
  readonly pauseMessage?: string;
  /** Machine-readable pause reason; closed catalog, distinct from the message. */
  readonly pauseReason?: string;
  /** Worker rounds completed toward the objective. */
  readonly totalWorkerRounds?: number;
  /** Independent verification rounds run so far. */
  readonly totalVerifyRounds?: number;
  /** Wall-clock ms since the goal started. */
  readonly elapsedMs?: Millis;
  /** Epoch ms the goal was started. */
  readonly createdAt?: EventTimestamp;
  /** Set while the goal is active but parked on a known wait. */
  readonly executionWait?: 'verification';
  readonly planFile?: string;
  readonly history?: readonly GoalHistoryEntry[];
}

export interface AssistantStatusPayload {
  readonly message: string;
}

// ── tool ──────────────────────────────────────────────────────────────────

/**
 * A tool call the model has announced but which is not yet final.
 *
 * VOLATILE, and the reason is the whole point of this event existing. While
 * arguments stream, the model can still change its mind about a path or a
 * command. The runtime emits this as soon as it knows a call is coming so a
 * host can render a row immediately, and it goes into no durable log because
 * the call it describes may never happen as stated.
 *
 * The legacy worker emits this as `chat:tool_use_started`, and separately emits
 * `chat:tool_use` once arguments settle. An earlier draft of this package
 * mapped BOTH onto `tool.call_started`, which produced a durable event emitted
 * twice per call with the same id and different arguments — a stream a host
 * could not interpret, because nothing said which copy superseded the other.
 * Splitting them is the fix: exactly one durable `tool.call_started` per call.
 *
 * @see ToolCallStartedPayload
 */
export interface ToolCallPreviewPayload {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  /**
   * Best-effort arguments. Explicitly NOT authoritative — this is a partial
   * view of a call that is still being generated.
   */
  readonly arguments: Readonly<Record<string, unknown>>;
  /** True while arguments are still streaming. Always true here. */
  readonly provisional: true;
}

/**
 * A tool invocation the runtime is about to dispatch.
 *
 * ## Exactly once, authoritative, before dispatch
 *
 * This event carries the side-effect INTENT, and it is the only durable record
 * of that intent. Two properties are load-bearing:
 *
 *  - **Exactly once per `toolCallId`.** A crash mid-tool leaves a durable
 *    `tool.call_started` with no `tool.call_completed`, and that asymmetry is
 *    the evidence a side-effect ledger reconciles against. Emitting it twice
 *    would make the ledger count one call twice; never emitting it would leave
 *    a crash with no trace that the call was attempted at all.
 *  - **Before executor dispatch.** If it fires after dispatch, a crash between
 *    dispatch and emit produces a side effect with no intent on record — the
 *    exact case durable intent exists to prevent.
 *
 * `ToolCallPreviewPayload` covers the "something is coming" case; this covers
 * "this is what will run".
 *
 * @see ToolCallPreviewPayload
 * @see ToolCallCompletedPayload
 */
export interface ToolCallStartedPayload {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  /** Final arguments. These are what will be dispatched. */
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
  /** 1 for a first call; higher only when the runtime deliberately retries. */
  readonly attempt: number;
  readonly groupId?: string;
  readonly progressTitle?: string;
  readonly progressSource?: string;
  readonly mcp?: { readonly server: string; readonly tool: string };
}

export interface ToolArgumentsDeltaPayload {
  readonly toolCallId: ToolCallId;
  readonly delta: string;
}

export interface ToolProgressPayload {
  readonly toolCallId: ToolCallId;
  readonly title?: string;
  readonly elapsedMs: Millis;
  readonly percent?: number;
  readonly stage?: string;
}

export interface ToolGroupProgressPayload {
  readonly groupId?: string;
  readonly title: string;
  readonly source: string;
}

export interface ToolTimedOutPayload {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly elapsedMs: Millis;
}

/**
 * The tool result AS AN EVENT.
 *
 * Deliberately NOT `extends ToolResult`. `ToolResult` carries a content-block
 * tag `type: 'tool_result'`, which is meaningful inside a transcript but would
 * SHADOW the event discriminant when the payload is spread into
 * `{ type: 'tool.call_completed', ...payload }`. drift test #3 caught that
 * collision: the two `type` fields are different vocabularies and the envelope
 * one must win.
 */
export interface ToolCallCompletedPayload {
  /** Same correlation id as `tool.call_started`. The legacy wire mixed `id`,
   *  `toolCallId` and `toolUseId` for this one concept; the protocol has one
   *  name, so a result can never fail to join its invocation. */
  readonly toolCallId: ToolCallId;
  readonly content: string;
  /**
   * Explicit outcome, never a defaulted boolean.
   *
   * An adapter that receives a legacy completion with no status field MUST
   * emit `{ outcome: 'indeterminate' }`. Emitting `success` would be a
   * fabricated fact, and there is no producer evidence for it.
   */
  readonly outcome: ToolCallOutcome;
  readonly durationMs: Millis;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly blocks?: readonly string[];
  readonly structured?: Readonly<Record<string, unknown>>;
  readonly images?: readonly { readonly mediaType: string; readonly data: string }[];
}

// ── checkpoint ─────────────────────────────────────────────────────────────

/**
 * A durable checkpoint boundary the runtime has stored.
 *
 * ## What is NOT here
 *
 * The worker's `checkpoint` event carries `{ messages, generation }`
 * (packages/agent/src/process/worker-protocol.ts:248-255). The full message
 * array does NOT cross the protocol boundary. It is unbounded, it is the
 * transcript itself rather than a reference to it, and it is exactly the shape
 * that makes a checkpoint payload a credential and size hazard. A host that
 * wants the messages asks the Control Plane for them by `checkpointRef`.
 *
 * `eventSeq` is the envelope `seq` of the event this checkpoint was taken at, so
 * a host can tell whether the boundary it holds is before or after what it has
 * already replayed without comparing timestamps.
 */
export interface CheckpointSavedPayload {
  /** Opaque handle the Control Plane resolves. Never the messages themselves. */
  readonly checkpointRef: string;
  /** Monotonic per run. A resume below the runtime's floor is refused. */
  readonly generation: number;
  /** Envelope `seq` of the event this checkpoint was taken at. */
  readonly eventSeq: number;
}

// ── permission (re-exported shapes live in permission.ts) ─────────────────

export type PermissionRequestPayload = import('../permission.js').PermissionRequest;
export type PermissionResolutionPayload = import('../permission.js').PermissionResolution;
export type PermissionExpiredPayload = import('../permission.js').PermissionExpired;

// ── compaction ────────────────────────────────────────────────────────────

export interface CompactionStartedPayload {
  readonly compactionId: CompactionId;
  readonly trigger: 'auto' | 'manual' | 'threshold';
}

export interface CompactionStepPayload {
  readonly compactionId: CompactionId;
  readonly step: number;
  readonly phase: string;
  readonly messageCount?: number;
  readonly tokensBefore?: number;
  readonly tokensEstimated?: number;
  readonly filesCached?: number;
}

export interface CompactionCompletedPayload {
  readonly compactionId: CompactionId;
  readonly strategy?: string;
  readonly tokensRemoved?: number;
  readonly tokensRetained?: number;
  readonly removedCount?: number;
  readonly boundaryId: string;
  readonly compactedMessageIds: readonly string[];
}

export interface CompactionFailedPayload {
  readonly compactionId: CompactionId;
  readonly error: { readonly code: string; readonly message: string };
}

export interface CompactionOverThresholdPayload {
  readonly tokensRetained: number;
  readonly available: number;
}

// ── subagent / hooks ──────────────────────────────────────────────────────

export interface SubagentStartedPayload {
  readonly subagentId: SubagentId;
  readonly parentToolCallId: ToolCallId;
  readonly sessionId?: SessionId;
  readonly agentType: string;
  readonly agentName: string;
  readonly agentDescription?: string;
}

export interface SubagentCompletedPayload {
  readonly subagentId: SubagentId;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly durationMs: Millis;
  readonly summary?: string;
}

/** From `AgentProgressEvent.hookEvent` (packages/ai/src/types.ts:332-347).
 *
 *  NOTE: the legacy payload carried its OWN `seq` field
 *  (packages/ai/src/types.ts:344) —
 *  a THIRD seq namespace. The protocol discards it; the envelope's `seq` is
 *  the only ordering authority. */
export interface HookInvokedPayload {
  /**
   * The worker's own `agentEventType`, verbatim.
   *
   * This is the field that decides which of the three subagent events an
   * `agent_progress` frame became, so it is carried rather than discarded —
   * without it a consumer cannot tell a hook from a subagent transition
   * without re-deriving the split the adapter already performed.
   */
  readonly agentEventType: string;
  readonly hookEventName: string;
  readonly hookType: string;
  readonly hookName: string;
  readonly matcher?: string;
  readonly additionalContext?: string;
  /** The worker's opaque `data` string, which is the payload for this frame. */
  readonly data?: string;
  readonly exitCode?: number;
  readonly async: boolean;
  readonly backgroundTaskId?: string;
  readonly durationMs: Millis;
  readonly status: 'ok' | 'error';
  readonly errorMessage?: string;
  readonly toolName?: string;
  readonly toolCallId?: ToolCallId;
  /** The worker's `toolInput`. Optional because a hook frame may not carry one. */
  readonly toolInput?: Readonly<Record<string, unknown>>;
}

// ── diagnostic ────────────────────────────────────────────────────────────

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

/** Its own channel so an evaluator can consume it while the product UI
 *  ignores it. */
export interface DiagnosticPayload {
  readonly level: DiagnosticLevel;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface DiagnosticTracePayload {
  readonly traceId: TraceId;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

// ── extension ─────────────────────────────────────────────────────────────

/** Forward-compatibility escape hatch. A host MUST ignore unknown namespaces
 *  and MUST NOT persist an unknown event. */
export interface ExtensionCustomPayload {
  readonly namespace: string;
  readonly name: string;
  readonly data: Readonly<Record<string, unknown>>;
}

// ── the registry source of truth ──────────────────────────────────────────

/** Every event the protocol can carry, keyed by wire type.
 *
 *  Adding a key here is the ONLY way to add an event. It widens `RunEvent`,
 *  it makes `EVENT_META` demand metadata for it, and it breaks the
 *  event-type snapshot so the change is reviewable. */
export interface RunEventPayloads {
  'run.started': RunStartedPayload;
  'run.paused': RunPausedPayload;
  'run.completed': RunCompletedPayload;
  'run.failed': RunFailedPayload;

  'turn.started': TurnStartedPayload;
  'turn.retry_scheduled': TurnRetryScheduledPayload;
  'turn.completed': TurnCompletedPayload;

  'assistant.text_block': AssistantTextBlockPayload;
  'assistant.text_delta': AssistantTextDeltaPayload;
  'assistant.thinking_block': AssistantThinkingBlockPayload;
  'assistant.thinking_delta': AssistantThinkingDeltaPayload;
  'assistant.message_finalized': AssistantMessageFinalizedPayload;
  'assistant.usage': AssistantUsagePayload;
  'assistant.mode_changed': AssistantModeChangedPayload;
  'assistant.goal_updated': AssistantGoalUpdatedPayload;
  'assistant.status': AssistantStatusPayload;

  'tool.call_preview': ToolCallPreviewPayload;
  'tool.call_started': ToolCallStartedPayload;
  'tool.arguments_delta': ToolArgumentsDeltaPayload;
  'tool.progress': ToolProgressPayload;
  'tool.group_progress': ToolGroupProgressPayload;
  'tool.timed_out': ToolTimedOutPayload;
  'tool.call_completed': ToolCallCompletedPayload;

  'checkpoint.saved': CheckpointSavedPayload;

  'permission.requested': PermissionRequestPayload;
  'permission.resolved': PermissionResolutionPayload;
  'permission.expired': PermissionExpiredPayload;

  'compaction.started': CompactionStartedPayload;
  'compaction.step': CompactionStepPayload;
  'compaction.completed': CompactionCompletedPayload;
  'compaction.failed': CompactionFailedPayload;
  'compaction.over_threshold': CompactionOverThresholdPayload;

  'subagent.started': SubagentStartedPayload;
  'subagent.completed': SubagentCompletedPayload;
  'hook.invoked': HookInvokedPayload;

  diagnostic: DiagnosticPayload;
  'diagnostic.trace': DiagnosticTracePayload;

  'extension.custom': ExtensionCustomPayload;
}

export type { ConnectorBinding, PermissionResponse, PermissionKind, PermissionRequestMode, PermissionScope, PermissionSource, ProjectId, RequestId, RunBudget, RunId, TaskId, WorkspaceId, AgentProfileId };
