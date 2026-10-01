/**
 * Payload shapes for every event on the wire.
 *
 * Design source: 07-agent-protocol-spec.md §4.1, §3.1, §14.
 *
 * ## `RunEventPayloads` is the single source of truth
 *
 * It is an INTERFACE keyed by event type, which buys two things 07 §4 was
 * reaching for with a mapped type over a const array:
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
 * instead of the interface. See `docs/architecture/10-reference-comparison.md`
 * §1 for why grok-build can use a macro here and TypeScript cannot.
 *
 * ## 07 §14 exclusions enforced by construction
 *
 *  - No `Map` / `Set` anywhere: `ToolPermissionRulesBySource` holds three
 *    `ReadonlyMap`s and cannot cross JSON (07 §3.1). `PermissionRulesWire`
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
  PermissionDecision,
  PermissionKind,
  PermissionMode,
  PermissionScope,
  PermissionSource,
} from '../permission.js';

// ── content blocks ────────────────────────────────────────────────────────

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'refusal'
  | 'aborted'
  | 'pause'
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

export interface ToolResult {
  readonly type: 'tool_result';
  readonly toolUseId: ToolCallId;
  readonly content: string;
  /** The protocol FORCES this field. Today 1666 stored tool_results have
   *  zero `is_error: true`, because the legacy `tool_use` event merged
   *  start and finish and dropped the distinction on the floor. */
  readonly isError: boolean;
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

export interface RunFailedPayload {
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
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

export interface TurnRetryScheduledPayload {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly reason: string;
  readonly errorClass: string;
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

/** `mode` was a bare `string` in the legacy SSE union (ai/src/types.ts:379).
 *  Here it is a closed set, so a rename cannot silently change meaning. */
export type AssistantMode = 'default' | 'plan' | 'research' | 'conductor' | 'goal';

export interface AssistantModeChangedPayload {
  readonly mode: AssistantMode;
  readonly source: 'agent' | 'user';
  readonly reason?: string;
}

export type GoalState = 'idle' | 'active' | 'achieved' | 'exhausted' | 'paused';

export interface AssistantGoalUpdatedPayload {
  readonly state: GoalState;
  readonly phase: string;
  readonly objective: string;
  readonly tokensUsed: number;
  readonly tokenBudget: number;
  readonly consecutiveNotAchieved: number;
  readonly gapsSummary?: string;
  readonly strategyProposal?: string;
  readonly pauseReason?: string;
  readonly planFile?: string;
  readonly history?: readonly { readonly at: EventTimestamp; readonly note: string }[];
}

export interface AssistantStatusPayload {
  readonly message: string;
}

// ── tool ──────────────────────────────────────────────────────────────────

export interface ToolCallStartedPayload {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
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
  readonly toolUseId: ToolCallId;
  readonly content: string;
  /** Mandatory here, unlike the legacy event, which dropped it. */
  readonly isError: boolean;
  readonly durationMs: Millis;
  readonly errorClass?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly blocks?: readonly string[];
  readonly structured?: Readonly<Record<string, unknown>>;
  readonly images?: readonly { readonly mediaType: string; readonly data: string }[];
}

// ── permission (re-exported shapes live in permission.ts) ─────────────────

export type PermissionRequestedPayload = import('../permission.js').PermissionRequested;
export type PermissionResolvedPayload = import('../permission.js').PermissionResolved;
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

/** From `AgentProgressEvent.hookEvent` (ai/src/types.ts:332-347).
 *
 *  NOTE: the legacy payload carried its OWN `seq` field (ai/types.ts:344) —
 *  a THIRD seq namespace. The protocol discards it; the envelope's `seq` is
 *  the only ordering authority. */
export interface HookInvokedPayload {
  readonly hookEventName: string;
  readonly hookType: string;
  readonly hookName: string;
  readonly matcher?: string;
  readonly additionalContext?: string;
  readonly exitCode?: number;
  readonly async: boolean;
  readonly backgroundTaskId?: string;
  readonly durationMs: Millis;
  readonly status: 'ok' | 'error';
  readonly errorMessage?: string;
  readonly toolName?: string;
  readonly toolUseId?: ToolCallId;
}

// ── diagnostic ────────────────────────────────────────────────────────────

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

/** Its own channel so an evaluator can consume it while the product UI
 *  ignores it (07 §4.1). */
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
 *  and MUST NOT persist an unknown event (07 §13). */
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

  'tool.call_started': ToolCallStartedPayload;
  'tool.arguments_delta': ToolArgumentsDeltaPayload;
  'tool.progress': ToolProgressPayload;
  'tool.group_progress': ToolGroupProgressPayload;
  'tool.timed_out': ToolTimedOutPayload;
  'tool.call_completed': ToolCallCompletedPayload;

  'permission.requested': PermissionRequestedPayload;
  'permission.resolved': PermissionResolvedPayload;
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

export type { ConnectorBinding, PermissionDecision, PermissionKind, PermissionMode, PermissionScope, PermissionSource, ProjectId, RequestId, RunBudget, RunId, TaskId, WorkspaceId, AgentProfileId };
