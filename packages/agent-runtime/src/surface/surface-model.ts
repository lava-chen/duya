/**
 * The surface model: a renderer-independent view of a run, keyed on
 * `RunEventEnvelope`.
 *
 * ## Why this is not built on `LegacySseFrame`
 *
 * The blessed CLI's first pass (`packages/agent/src/cli/ui/blocks.ts`) keyed its
 * block model on the legacy `{ type, data }` frame. That vocabulary is the
 * OUTPUT of `projectToLegacyFrame`, and the projection is deliberately lossy —
 * eleven protocol events reach `null` and never reach a client at all:
 *
 *   run.started, run.paused, turn.completed, assistant.message_finalized,
 *   permission.resolved, permission.expired, checkpoint.saved, tool.timed_out,
 *   diagnostic, diagnostic.trace, extension.custom
 *
 * A model keyed on that union is therefore structurally incapable of expressing
 * turn lifecycle (there is `turn_start` and no terminal event, so a turn that
 * never finished is indistinguishable from one that never began), pause versus
 * stall, permission expiry, or checkpoints. Those are not features to be added
 * on that layer; the events do not survive the projection.
 *
 * So this model consumes the PROTOCOL envelope and projects down. `LEGACY_*`
 * exports below are the down-projection, kept total so today's desktop renderer
 * is unaffected.
 *
 * ## What "renderer-independent" means here
 *
 * Nothing in this file knows about blessed, React, ANSI, or rows. It produces
 * plain data. A renderer subscribes with `apply()` and decides what to draw.
 * That is what lets a second renderer be added later without the two drifting:
 * the conformance suite runs against this model with no renderer present.
 *
 * ## Exhaustive by construction
 *
 * `apply()` switches on `envelope.payload.type` over the full `EventType`
 * union. Adding a protocol event without teaching this model about it is a
 * COMPILE error, not a silently dropped row — the same property the protocol
 * registry uses to keep its own tables honest.
 */

import type {
  AssistantGoalUpdatedPayload,
  AssistantMode,
  CompactionId,
  ErrorCode,
  HookInvokedPayload,
  MessageContent,
  PausePoint,
  PermissionAction,
  PermissionResolution,
  PermissionRequest,
  ProtocolErrorInfo,
  RunEventEnvelope,
  RunId,
  SessionId,
  StopReason,
  SubagentId,
  TokenUsage,
  ToolCallId,
  ToolCallOutcome,
  TurnId,
} from '@duya/agent-protocol';

// ── run ───────────────────────────────────────────────────────────────────

/**
 * Run lifecycle.
 *
 * `paused` is a distinct member, not an inference from "no events lately".
 * `run.paused` is what makes the difference: without it a paused run and a
 * stalled one produce the same silence, and the protocol's own comment says
 * exactly that. `describeRun` is where that distinction becomes testable.
 */
export type RunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';

export interface RunSurface {
  readonly runId: RunId | null;
  readonly sessionId: SessionId | null;
  readonly status: RunStatus;
  /** Protocol version from `run.started`, as `major.minor`. */
  readonly protocolVersion: string | null;
  readonly runtimeName: string | null;
  /** The manifest hash — the fact a resume is verified against. */
  readonly manifestHash: string | null;
  /** Set when this run is a resume or a fork. */
  readonly resumedFrom: string | null;
  /** Where the run halted, when `status === 'paused'`. */
  readonly pausedAt: PausePoint | null;
  readonly stopReason: StopReason | null;
  readonly usage: TokenUsage | null;
  readonly error: ProtocolErrorInfo | null;
  /** Envelope timestamp of the newest event applied. Drives the stall check. */
  readonly lastProgressAt: number;
}

// ── turn ──────────────────────────────────────────────────────────────────

/**
 * Turn lifecycle.
 *
 * `failed` is not carried by a `turn.failed` event — the protocol has no such
 * event. A turn fails when the RUN fails underneath it, so `run.failed`
 * transitions every still-open turn to `failed` (see `apply`). Asserting a turn
 * is dead on its own evidence would be a fabrication; inheriting the run's
 * terminal failure is the fact.
 */
export type TurnPhase = 'running' | 'retrying' | 'completed' | 'failed';

export interface TurnRetrySurface {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly reason: string;
}

export interface TurnSurface {
  readonly turnId: TurnId;
  readonly index: number;
  readonly model: string;
  readonly providerId: string;
  readonly apiFormat: 'anthropic' | 'openai';
  readonly phase: TurnPhase;
  readonly retry: TurnRetrySurface | null;
  readonly stopReason: StopReason | null;
  readonly usage: TokenUsage | null;
  readonly durationMs: number | null;
}

// ── tool ──────────────────────────────────────────────────────────────────

/**
 * Tool call phases, one per protocol event that advances a call.
 *
 * Ordered as the protocol sequences them. `timed_out` is separate from
 * `completed` because `tool.timed_out` and `tool.call_completed` are DIFFERENT
 * events: the first is volatile and the second is the durable record. A call
 * that times out is normally followed by a completion carrying
 * `outcome: 'timeout'`, and the surface keeps both facts rather than folding
 * one into the other.
 */
export type ToolPhase =
  | 'preview'
  | 'streaming_arguments'
  | 'started'
  | 'progress'
  | 'completed'
  | 'timed_out';

export interface ToolProgressSurface {
  readonly title: string | null;
  readonly elapsedMs: number;
  readonly percent: number | null;
  readonly stage: string | null;
}

export interface ToolCallSurface {
  readonly toolCallId: ToolCallId;
  readonly name: string;
  readonly phase: ToolPhase;
  /**
   * How many times the phase changed. A renderer redraws one row per unit of
   * this, which is how the blessed transcript-view avoids a full re-walk on
   * every progress tick.
   */
  readonly phaseRevision: number;
  /** Provisional arguments from `tool.call_preview`. */
  readonly provisionalArguments: Readonly<Record<string, unknown>> | null;
  /** Final arguments from `tool.call_started` — the ones dispatched. */
  readonly arguments: Readonly<Record<string, unknown>> | null;
  /** Concatenated `tool.arguments_delta` text, for a streaming row. */
  readonly argumentText: string;
  readonly attempt: number;
  readonly groupId: string | null;
  readonly progress: ToolProgressSurface | null;
  readonly outcome: ToolCallOutcome | null;
  readonly result: string | null;
  readonly durationMs: number | null;
  /** True once the call can no longer change: completed or timed out. */
  readonly settled: boolean;
}

export interface ToolGroupSurface {
  readonly groupId: string | null;
  readonly title: string;
  readonly source: string;
}

// ── permission ────────────────────────────────────────────────────────────

/**
 * Permission lifecycle.
 *
 * `expired` and `resolved` are separate members because the protocol emits
 * `permission.expired` BEFORE `permission.resolved{deny, source: 'timeout'}`.
 * A request that timed out therefore ends in the `resolved` phase — and the
 * only thing that distinguishes it from a user who typed "deny" is
 * `expiredAfterMs`. That field is the reason this surface records expiry
 * instead of inferring it from the denial.
 */
export type PermissionPhase = 'requested' | 'expired' | 'resolved';

export interface PermissionSurface {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly kind: string;
  readonly mode: string;
  readonly reason: string | null;
  readonly blockedPath: string | null;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly phase: PermissionPhase;
  /** Non-null once `permission.expired` was seen. */
  readonly expiredAfterMs: number | null;
  readonly resolution: PermissionResolution | null;
  /** True while the host still owes an answer. */
  readonly awaitingAnswer: boolean;
}

// ── subagent ──────────────────────────────────────────────────────────────

export type SubagentPhase = 'started' | 'completed';

export interface SubagentSurface {
  readonly subagentId: SubagentId;
  readonly parentToolCallId: ToolCallId;
  readonly agentType: string;
  readonly agentName: string;
  readonly agentDescription: string | null;
  readonly phase: SubagentPhase;
  readonly status: 'completed' | 'failed' | 'cancelled' | null;
  readonly durationMs: number | null;
  readonly summary: string | null;
}

// ── checkpoint ────────────────────────────────────────────────────────────

export interface CheckpointSurface {
  readonly checkpointRef: string;
  readonly generation: number;
  /** Envelope seq this boundary was taken at. */
  readonly eventSeq: number;
  readonly runId: RunId;
}

// ── assistant content ─────────────────────────────────────────────────────

/**
 * A streamed assistant message.
 *
 * `text` is authoritative on `assistant.message_finalized` and accumulates
 * from `assistant.text_delta`. The two overlap by design — the engine publishes
 * deltas inside the stream loop and republishes whole blocks after it — so a
 * renderer that APPENDS the finalized text prints every answer twice. The
 * model exposes `finalized` so the renderer knows which it is looking at.
 */
export interface MessageSurface {
  readonly messageId: string;
  readonly text: string;
  readonly thinking: string;
  readonly finalized: boolean;
  readonly stopReason: StopReason | null;
  readonly usage: TokenUsage | null;
}

// ── compaction ────────────────────────────────────────────────────────────

export type CompactionPhase = 'running' | 'completed' | 'failed';

export interface CompactionSurface {
  readonly compactionId: CompactionId;
  readonly phase: CompactionPhase;
  readonly trigger: string | null;
  readonly strategy: string | null;
  readonly tokensRemoved: number | null;
  readonly tokensRetained: number | null;
  readonly removedCount: number | null;
  readonly boundaryId: string | null;
  readonly lastStep: string | null;
  readonly error: string | null;
}

// ── hook / diagnostic / extension ─────────────────────────────────────────

export interface HookSurface {
  readonly hookName: string;
  readonly hookType: string;
  readonly hookEventName: string;
  readonly agentEventType: string;
  readonly async: boolean;
  readonly status: 'ok' | 'error';
  readonly durationMs: number;
  readonly errorMessage: string | null;
  readonly backgroundTaskId: string | null;
}

export interface DiagnosticSurface {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
}

export interface ExtensionSurface {
  readonly namespace: string;
  readonly name: string;
}

// ── effects ───────────────────────────────────────────────────────────────

/**
 * What applying one envelope changed.
 *
 * A renderer schedules a redraw on anything that is not `none`, which is what
 * keeps a firehose of ephemeral deltas from costing a render each.
 */
export type SurfaceEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'run'; readonly run: RunSurface }
  /**
   * `run.failed` ends the run AND retires every turn still open on it.
   *
   * One effect rather than two because they are one fact: a turn does not fail
   * on its own evidence, it fails because the run it belongs to did. A renderer
   * that saw only the run change would leave the turn row claiming to be live.
   */
  | { readonly kind: 'run_failed'; readonly run: RunSurface; readonly turns: readonly TurnSurface[] }
  | { readonly kind: 'turn'; readonly turn: TurnSurface }
  | { readonly kind: 'tool'; readonly tool: ToolCallSurface }
  | { readonly kind: 'tool_group'; readonly group: ToolGroupSurface }
  | { readonly kind: 'permission'; readonly permission: PermissionSurface }
  | { readonly kind: 'subagent'; readonly subagent: SubagentSurface }
  | { readonly kind: 'checkpoint'; readonly checkpoint: CheckpointSurface }
  | { readonly kind: 'message'; readonly message: MessageSurface }
  | { readonly kind: 'usage'; readonly usage: TokenUsage }
  | { readonly kind: 'mode'; readonly mode: AssistantMode; readonly source: 'agent' | 'user' }
  | { readonly kind: 'goal'; readonly goal: AssistantGoalUpdatedPayload }
  | { readonly kind: 'status'; readonly message: string }
  | { readonly kind: 'compaction'; readonly compaction: CompactionSurface }
  | { readonly kind: 'hook'; readonly hook: HookSurface }
  | { readonly kind: 'diagnostic'; readonly diagnostic: DiagnosticSurface }
  | { readonly kind: 'trace'; readonly traceId: string; readonly name: string }
  | { readonly kind: 'extension'; readonly extension: ExtensionSurface }
  | { readonly kind: 'over_threshold'; readonly tokensRetained: number; readonly available: number };

const NO_EFFECT: SurfaceEffect = { kind: 'none' };

/**
 * The same shape, writable.
 *
 * The published surface types are `readonly` so a renderer cannot corrupt
 * another renderer's view by reaching in and mutating a row. The model still
 * needs to mutate in place — a tool line is the SAME object across preview,
 * progress and completion, so a renderer can address the row it needs instead of
 * rebuilding it per update. So the model keeps private drafts and hands out the
 * readonly view of the very same object. The guarantee is a compile-time one,
 * which is where `readonly` belongs anyway.
 */
type Draft<T> = { -readonly [K in keyof T]: T[K] };

/** Run state before any event has been applied. */
function emptyRun(): RunSurface {
  return {
    runId: null,
    sessionId: null,
    status: 'pending',
    protocolVersion: null,
    runtimeName: null,
    manifestHash: null,
    resumedFrom: null,
    pausedAt: null,
    stopReason: null,
    usage: null,
    error: null,
    lastProgressAt: 0,
  };
}

function emptyTool(toolCallId: ToolCallId, name: string): Draft<ToolCallSurface> {
  return {
    toolCallId,
    name,
    phase: 'preview',
    phaseRevision: 0,
    provisionalArguments: null,
    arguments: null,
    argumentText: '',
    attempt: 1,
    groupId: null,
    progress: null,
    outcome: null,
    result: null,
    durationMs: null,
    settled: false,
  };
}

function emptySubagent(event: {
  readonly subagentId: SubagentId;
  readonly parentToolCallId: ToolCallId;
  readonly agentType: string;
  readonly agentName: string;
  readonly agentDescription?: string;
}): SubagentSurface {
  return {
    subagentId: event.subagentId,
    parentToolCallId: event.parentToolCallId,
    agentType: event.agentType,
    agentName: event.agentName,
    agentDescription: event.agentDescription ?? null,
    phase: 'started',
    status: null,
    durationMs: null,
    summary: null,
  };
}

function emptyCompaction(compactionId: CompactionId): Draft<CompactionSurface> {
  return {
    compactionId,
    phase: 'running',
    trigger: null,
    strategy: null,
    tokensRemoved: null,
    tokensRetained: null,
    removedCount: null,
    boundaryId: null,
    lastStep: null,
    error: null,
  };
}

function emptyMessage(messageId: string): Draft<MessageSurface> {
  return {
    messageId,
    text: '',
    thinking: '',
    finalized: false,
    stopReason: null,
    usage: null,
  };
}

/**
 * The renderer-independent view of one run.
 *
 * Mutating in place is deliberate: a tool line or a turn row is the SAME
 * object across its whole lifecycle, so a renderer can address the row it needs
 * and the tests can assert identity rather than re-deriving equality.
 */
export class SurfaceModel {
  private run: RunSurface = emptyRun();

  private readonly turnsById = new Map<TurnId, TurnSurface>();
  private readonly turnsByOrder: TurnSurface[] = [];
  private readonly toolsByCallId = new Map<ToolCallId, Draft<ToolCallSurface>>();
  private readonly toolGroups = new Map<string, ToolGroupSurface>();
  private readonly permissionsById = new Map<string, PermissionSurface>();
  private readonly subagentsById = new Map<SubagentId, SubagentSurface>();
  private readonly messagesById = new Map<string, Draft<MessageSurface>>();
  private readonly compactionsById = new Map<CompactionId, Draft<CompactionSurface>>();
  private readonly checkpoints: CheckpointSurface[] = [];
  private readonly hooks: HookSurface[] = [];
  private readonly diagnostics: DiagnosticSurface[] = [];
  private readonly extensions: ExtensionSurface[] = [];

  private usage: TokenUsage | null = null;
  private mode: AssistantMode | null = null;
  private modeSource: 'agent' | 'user' | null = null;
  private goal: AssistantGoalUpdatedPayload | null = null;
  private status: string | null = null;
  /**
   * The last `compaction.over_threshold` reading.
   *
   * Retained rather than passed through only, because a host that only sees the
   * effect has to keep its own copy and the model then holds two. The event is
   * volatile, so this is the LAST reading and not a history.
   */
  private thresholdWarning: { readonly tokensRetained: number; readonly available: number } | null = null;

  /** Highest checkpoint generation seen — the one a resume should use. */
  private latestCheckpoint: CheckpointSurface | null = null;

  // ── read side ───────────────────────────────────────────────────────────

  get runState(): RunSurface {
    return this.run;
  }

  /** Turns in the order they started. */
  get turns(): readonly TurnSurface[] {
    return this.turnsByOrder;
  }

  /** The turn currently in flight, or `null` when none is open. */
  get currentTurn(): TurnSurface | null {
    for (let i = this.turnsByOrder.length - 1; i >= 0; i -= 1) {
      const turn = this.turnsByOrder[i];
      if (turn === undefined) continue;
      if (turn.phase === 'running' || turn.phase === 'retrying') return turn;
    }
    return null;
  }

  get toolCalls(): readonly ToolCallSurface[] {
    return [...this.toolsByCallId.values()];
  }

  /**
   * Aggregate progress for tool groups.
   *
   * Keyed by `groupId`, which is OPTIONAL on the payload, so the unnamed group
   * lives under the empty string rather than being dropped.
   */
  get toolGroupSurfaces(): readonly ToolGroupSurface[] {
    return [...this.toolGroups.values()];
  }

  get lastThresholdWarning(): { readonly tokensRetained: number; readonly available: number } | null {
    return this.thresholdWarning;
  }

  /**
   * Span records seen so far.
   *
   * Always empty by design: `diagnostic.trace` is EPHEMERAL, and retaining a
   * span would make a long run's memory grow with its trace volume. Exposed as
   * a getter so "we do not keep these" is an ASSERTED property rather than a
   * comment nobody checks.
   */
  get retainedTraces(): readonly never[] {
    return [];
  }

  get toolCallCount(): number {
    return this.toolsByCallId.size;
  }

  get permissions(): readonly PermissionSurface[] {
    return [...this.permissionsById.values()];
  }

  get subagents(): readonly SubagentSurface[] {
    return [...this.subagentsById.values()];
  }

  get messages(): readonly MessageSurface[] {
    return [...this.messagesById.values()];
  }

  get compactions(): readonly CompactionSurface[] {
    return [...this.compactionsById.values()];
  }

  get checkpointLog(): readonly CheckpointSurface[] {
    return this.checkpoints;
  }

  get latestCheckpointState(): CheckpointSurface | null {
    return this.latestCheckpoint;
  }

  get usageState(): TokenUsage | null {
    return this.usage;
  }

  get modeState(): AssistantMode | null {
    return this.mode;
  }

  get modeSourceState(): 'agent' | 'user' | null {
    return this.modeSource;
  }

  get goalState(): AssistantGoalUpdatedPayload | null {
    return this.goal;
  }

  get statusState(): string | null {
    return this.status;
  }

  get hooksState(): readonly HookSurface[] {
    return this.hooks;
  }

  get diagnosticsState(): readonly DiagnosticSurface[] {
    return this.diagnostics;
  }

  get extensionsState(): readonly ExtensionSurface[] {
    return this.extensions;
  }

  toolByCallId(toolCallId: ToolCallId): ToolCallSurface | null {
    return this.toolsByCallId.get(toolCallId) ?? null;
  }

  turnById(turnId: TurnId): TurnSurface | null {
    return this.turnsById.get(turnId) ?? null;
  }

  permissionById(requestId: string): PermissionSurface | null {
    return this.permissionsById.get(requestId) ?? null;
  }

  subagentById(subagentId: SubagentId): SubagentSurface | null {
    return this.subagentsById.get(subagentId) ?? null;
  }

  messageById(messageId: string): MessageSurface | null {
    return this.messagesById.get(messageId) ?? null;
  }

  /** Requests the host still owes an answer to. */
  get openPermissions(): readonly PermissionSurface[] {
    return this.permissions.filter((p) => p.awaitingAnswer);
  }

  // ── the paused-vs-stalled question ──────────────────────────────────────

  /**
   * Is the run actually stalled, as opposed to paused or finished?
   *
   * This is the distinction the protocol exists to carry, so it is worth being
   * explicit about which facts produce it:
   *
   *  - `status === 'paused'`  — the runtime SAID so (`run.paused`). Never
   *    reported as stalled, however long the silence lasts, because the run is
   *    not stuck; it is waiting on a host.
   *  - `status === 'running'` and `nowMs - lastProgressAt >= stallAfterMs` —
   *    nothing has arrived for that long and nothing explained why.
   *  - `completed` / `failed` — terminal, so never stalled.
   *
   * A model without `run.paused` can only ever answer the second case, which is
   * why that event is critical rather than informational.
   *
   * @param nowMs - Host clock, epoch ms. Passed in rather than read so the
   *   surface model carries no clock of its own and stays deterministic.
   */
  describeRun(
    nowMs: number,
    stallAfterMs: number,
  ): { readonly status: RunStatus; readonly stalled: boolean; readonly silentMs: number } {
    const silentMs = Math.max(0, nowMs - this.run.lastProgressAt);
    const stalled = this.run.status === 'running' && silentMs >= stallAfterMs;
    return { status: this.run.status, stalled, silentMs };
  }

  // ── write side ──────────────────────────────────────────────────────────

  /**
   * Apply one protocol envelope.
   *
   * The switch is exhaustive over `EventType`: adding a protocol event without
   * a case here is a compile error rather than a dropped row.
   */
  apply(envelope: RunEventEnvelope): SurfaceEffect {
    const event = envelope.payload;
    if (envelope.timestamp > this.run.lastProgressAt) {
      this.run = { ...this.run, lastProgressAt: envelope.timestamp };
    }

    switch (event.type) {
      // ── run ─────────────────────────────────────────────────────────────
      case 'run.started': {
        const resumedFrom = event.resumedFrom;
        this.run = {
          ...this.run,
          runId: envelope.runId,
          sessionId: envelope.sessionId,
          status: 'running',
          protocolVersion: `${event.protocol.major}.${event.protocol.minor}`,
          runtimeName: event.runtime.name,
          manifestHash: event.manifestHash,
          resumedFrom: resumedFrom === undefined ? null : `${resumedFrom.kind}:${resumedFrom.value}`,
        };
        return { kind: 'run', run: this.run };
      }

      case 'run.paused': {
        this.run = { ...this.run, status: 'paused', pausedAt: event.at };
        return { kind: 'run', run: this.run };
      }

      case 'run.completed': {
        this.run = {
          ...this.run,
          status: 'completed',
          stopReason: event.stopReason ?? null,
          usage: event.usage ?? this.run.usage,
        };
        // A run that ends leaves no turn running. `turn.completed` normally
        // got here first; this is the arm that makes a run whose turn never
        // completed still close out cleanly.
        this.closeOpenTurns('completed');
        return { kind: 'run', run: this.run };
      }

      case 'run.failed': {
        this.run = { ...this.run, status: 'failed', error: event.error };
        // There is no `turn.failed` event, so an open turn inherits the run's
        // terminal failure. Retiring them is the difference between "this turn
        // finished" and "this turn never finished", which the legacy surface
        // could not tell apart.
        const turns = this.closeOpenTurns('failed');
        return { kind: 'run_failed', run: this.run, turns };
      }

      // ── turn ────────────────────────────────────────────────────────────
      case 'turn.started': {
        const existing = this.turnsById.get(event.turnId);
        const turn: TurnSurface = {
          turnId: event.turnId,
          index: event.index,
          model: event.model,
          providerId: event.providerId,
          apiFormat: event.apiFormat,
          phase: 'running',
          retry: existing?.retry ?? null,
          stopReason: null,
          usage: null,
          durationMs: null,
        };
        this.turnsById.set(event.turnId, turn);
        this.turnsByOrder.push(turn);
        return { kind: 'turn', turn };
      }

      case 'turn.retry_scheduled': {
        const current = this.currentTurn;
        if (current === null) return NO_EFFECT;
        const turn: TurnSurface = {
          ...current,
          phase: 'retrying',
          retry: {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            reason: event.reason,
          },
        };
        this.turnsById.set(turn.turnId, turn);
        this.replaceInOrder(turn);
        return { kind: 'turn', turn };
      }

      case 'turn.completed': {
        const existing = this.turnsById.get(event.turnId);
        // A completion for a turn that never announced itself still gets a
        // surface, so the event is never silently dropped.
        const turn: TurnSurface = {
          turnId: event.turnId,
          index: event.index,
          model: existing?.model ?? '',
          providerId: existing?.providerId ?? '',
          apiFormat: existing?.apiFormat ?? 'anthropic',
          phase: 'completed',
          retry: existing?.retry ?? null,
          stopReason: event.stopReason,
          usage: event.usage,
          durationMs: event.durationMs,
        };
        if (existing === undefined) this.turnsByOrder.push(turn);
        else this.replaceInOrder(turn);
        this.turnsById.set(turn.turnId, turn);
        this.usage = event.usage;
        return { kind: 'turn', turn };
      }

      // ── assistant ───────────────────────────────────────────────────────
      case 'assistant.text_block':
      case 'assistant.text_delta': {
        const message = this.ensureMessage(event.messageId);
        // A delta APPENDS; a block REPLACES. The engine republishes whole
        // blocks after streaming deltas, so appending both double-prints.
        message.text =
          event.type === 'assistant.text_delta' ? message.text + event.delta : event.text;
        return { kind: 'message', message };
      }

      case 'assistant.thinking_block':
      case 'assistant.thinking_delta': {
        const message = this.ensureMessage(event.messageId);
        message.thinking =
          event.type === 'assistant.thinking_delta' ? message.thinking + event.delta : event.thinking;
        return { kind: 'message', message };
      }

      case 'assistant.message_finalized': {
        const message = this.ensureMessage(event.messageId);
        message.finalized = true;
        message.stopReason = event.stopReason;
        message.usage = event.usage ?? null;
        for (const block of event.content) {
          if (block.type === 'text') message.text = block.text;
          if (block.type === 'thinking') message.thinking = block.thinking;
        }
        return { kind: 'message', message };
      }

      case 'assistant.usage': {
        this.usage = event.usage;
        return { kind: 'usage', usage: event.usage };
      }

      case 'assistant.mode_changed': {
        this.mode = event.mode;
        this.modeSource = event.source;
        return { kind: 'mode', mode: event.mode, source: event.source };
      }

      case 'assistant.goal_updated': {
        this.goal = event;
        return { kind: 'goal', goal: event };
      }

      case 'assistant.status': {
        this.status = event.message;
        return { kind: 'status', message: event.message };
      }

      // ── tool ────────────────────────────────────────────────────────────
      case 'tool.call_preview': {
        const tool = this.ensureTool(event.toolCallId, event.toolName);
        // A preview is provisional by definition — the call it describes may
        // never happen as stated — so it never overwrites final arguments.
        tool.provisionalArguments = event.arguments;
        if (tool.phase === 'preview') tool.phaseRevision += 1;
        return { kind: 'tool', tool };
      }

      case 'tool.arguments_delta': {
        const tool = this.ensureTool(event.toolCallId, '');
        tool.argumentText += event.delta;
        tool.phase = 'streaming_arguments';
        tool.phaseRevision += 1;
        return { kind: 'tool', tool };
      }

      case 'tool.call_started': {
        const tool = this.ensureTool(event.toolCallId, event.toolName);
        tool.name = event.toolName;
        tool.arguments = event.arguments;
        tool.attempt = event.attempt;
        tool.groupId = event.groupId ?? null;
        tool.phase = 'started';
        tool.phaseRevision += 1;
        return { kind: 'tool', tool };
      }

      case 'tool.progress': {
        const tool = this.ensureTool(event.toolCallId, '');
        tool.progress = {
          title: event.title ?? null,
          elapsedMs: event.elapsedMs,
          percent: event.percent ?? null,
          stage: event.stage ?? null,
        };
        // Progress after a terminal phase must not reopen the row: a late
        // progress tick is not evidence the call is live again.
        if (!tool.settled) {
          tool.phase = 'progress';
          tool.phaseRevision += 1;
        }
        return { kind: 'tool', tool };
      }

      case 'tool.group_progress': {
        const group: ToolGroupSurface = {
          groupId: event.groupId ?? null,
          title: event.title,
          source: event.source,
        };
        this.toolGroups.set(event.groupId ?? '', group);
        return { kind: 'tool_group', group };
      }

      case 'tool.timed_out': {
        const tool = this.ensureTool(event.toolCallId, event.toolName);
        tool.name = event.toolName || tool.name;
        tool.phase = 'timed_out';
        tool.phaseRevision += 1;
        // A timeout is not a completion: `tool.call_completed` may still
        // arrive and carries the durable record. Marking it settled here would
        // hide that record from a renderer.
        return { kind: 'tool', tool };
      }

      case 'tool.call_completed': {
        const tool = this.ensureTool(event.toolCallId, '');
        tool.result = event.content;
        tool.outcome = event.outcome;
        tool.durationMs = event.durationMs;
        tool.phase = 'completed';
        tool.phaseRevision += 1;
        tool.settled = true;
        return { kind: 'tool', tool };
      }

      // ── checkpoint ──────────────────────────────────────────────────────
      case 'checkpoint.saved': {
        const checkpoint: CheckpointSurface = {
          checkpointRef: event.checkpointRef,
          generation: event.generation,
          eventSeq: event.eventSeq,
          runId: envelope.runId,
        };
        this.checkpoints.push(checkpoint);
        this.latestCheckpoint = checkpoint;
        return { kind: 'checkpoint', checkpoint };
      }

      // ── permission ──────────────────────────────────────────────────────
      case 'permission.requested': {
        const permission: PermissionSurface = {
          requestId: event.requestId,
          toolName: event.toolName,
          toolInput: event.toolInput,
          kind: event.kind,
          mode: event.mode,
          reason: event.reason ?? null,
          blockedPath: event.blockedPath ?? null,
          startedAt: event.startedAt,
          expiresAt: event.expiresAt,
          phase: 'requested',
          expiredAfterMs: null,
          resolution: null,
          awaitingAnswer: true,
        };
        this.permissionsById.set(event.requestId, permission);
        return { kind: 'permission', permission };
      }

      case 'permission.resolved': {
        const existing = this.permissionsById.get(event.requestId);
        const permission: PermissionSurface = {
          requestId: event.requestId,
          toolName: existing?.toolName ?? '',
          toolInput: existing?.toolInput ?? {},
          kind: existing?.kind ?? '',
          mode: existing?.mode ?? '',
          reason: existing?.reason ?? null,
          blockedPath: existing?.blockedPath ?? null,
          startedAt: existing?.startedAt ?? 0,
          expiresAt: existing?.expiresAt ?? 0,
          phase: 'resolved',
          // Carried over, not recomputed: a timeout is recorded as a deny, and
          // only this field says a deadline passed rather than a human answering.
          expiredAfterMs: existing?.expiredAfterMs ?? null,
          resolution: event,
          awaitingAnswer: false,
        };
        this.permissionsById.set(event.requestId, permission);
        return { kind: 'permission', permission };
      }

      case 'permission.expired': {
        const existing = this.permissionsById.get(event.requestId);
        const permission: PermissionSurface = {
          requestId: event.requestId,
          toolName: existing?.toolName ?? '',
          toolInput: existing?.toolInput ?? {},
          kind: existing?.kind ?? '',
          mode: existing?.mode ?? '',
          reason: existing?.reason ?? null,
          blockedPath: existing?.blockedPath ?? null,
          startedAt: existing?.startedAt ?? 0,
          expiresAt: existing?.expiresAt ?? 0,
          phase: 'expired',
          expiredAfterMs: event.afterMs,
          resolution: existing?.resolution ?? null,
          awaitingAnswer: false,
        };
        this.permissionsById.set(event.requestId, permission);
        return { kind: 'permission', permission };
      }

      // ── compaction ──────────────────────────────────────────────────────
      case 'compaction.started': {
        const compaction: CompactionSurface = {
          ...emptyCompaction(event.compactionId),
          trigger: event.trigger,
        };
        this.compactionsById.set(event.compactionId, compaction);
        return { kind: 'compaction', compaction };
      }

      case 'compaction.step': {
        const compaction = this.compactionsById.get(event.compactionId) ?? emptyCompaction(event.compactionId);
        compaction.lastStep = event.phase;
        this.compactionsById.set(event.compactionId, compaction);
        return { kind: 'compaction', compaction };
      }

      case 'compaction.completed': {
        const existing = this.compactionsById.get(event.compactionId);
        const compaction: CompactionSurface = {
          ...(existing ?? emptyCompaction(event.compactionId)),
          phase: 'completed',
          strategy: event.strategy ?? null,
          tokensRemoved: event.tokensRemoved ?? null,
          tokensRetained: event.tokensRetained ?? null,
          removedCount: event.removedCount ?? null,
          boundaryId: event.boundaryId,
        };
        this.compactionsById.set(event.compactionId, compaction);
        return { kind: 'compaction', compaction };
      }

      case 'compaction.failed': {
        const existing = this.compactionsById.get(event.compactionId);
        const compaction: CompactionSurface = {
          ...(existing ?? emptyCompaction(event.compactionId)),
          phase: 'failed',
          error: event.error.message,
        };
        this.compactionsById.set(event.compactionId, compaction);
        return { kind: 'compaction', compaction };
      }

      case 'compaction.over_threshold': {
        this.thresholdWarning = {
          tokensRetained: event.tokensRetained,
          available: event.available,
        };
        return {
          kind: 'over_threshold',
          tokensRetained: event.tokensRetained,
          available: event.available,
        };
      }

      // ── subagent / hook ─────────────────────────────────────────────────
      case 'subagent.started': {
        const subagent = emptySubagent(event);
        this.subagentsById.set(event.subagentId, subagent);
        return { kind: 'subagent', subagent };
      }

      case 'subagent.completed': {
        const existing = this.subagentsById.get(event.subagentId);
        const subagent: SubagentSurface = {
          subagentId: event.subagentId,
          parentToolCallId: existing?.parentToolCallId ?? '',
          agentType: existing?.agentType ?? '',
          agentName: existing?.agentName ?? '',
          agentDescription: existing?.agentDescription ?? null,
          phase: 'completed',
          status: event.status,
          durationMs: event.durationMs,
          summary: event.summary ?? null,
        };
        this.subagentsById.set(event.subagentId, subagent);
        return { kind: 'subagent', subagent };
      }

      case 'hook.invoked': {
        const hook = toHookSurface(event);
        this.hooks.push(hook);
        return { kind: 'hook', hook };
      }

      // ── diagnostic / extension ──────────────────────────────────────────
      case 'diagnostic': {
        const diagnostic: DiagnosticSurface = { level: event.level, message: event.message };
        this.diagnostics.push(diagnostic);
        return { kind: 'diagnostic', diagnostic };
      }

      case 'diagnostic.trace': {
        return { kind: 'trace', traceId: event.traceId, name: event.name };
      }

      case 'extension.custom': {
        const extension: ExtensionSurface = { namespace: event.namespace, name: event.name };
        this.extensions.push(extension);
        return { kind: 'extension', extension };
      }

      default: {
        // Unreachable: the switch above is exhaustive over `EventType`. Kept so
        // a future non-exhaustive build fails loudly instead of dropping a row.
        return NO_EFFECT;
      }
    }
  }

  /** Drop everything, for a `/clear` or a fresh run. */
  reset(): void {
    this.run = emptyRun();
    this.turnsById.clear();
    this.turnsByOrder.length = 0;
    this.toolsByCallId.clear();
    this.toolGroups.clear();
    this.permissionsById.clear();
    this.subagentsById.clear();
    this.messagesById.clear();
    this.compactionsById.clear();
    this.checkpoints.length = 0;
    this.hooks.length = 0;
    this.diagnostics.length = 0;
    this.extensions.length = 0;
    this.latestCheckpoint = null;
    this.usage = null;
    this.mode = null;
    this.modeSource = null;
    this.goal = null;
    this.status = null;
    this.thresholdWarning = null;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private ensureMessage(messageId: string): Draft<MessageSurface> {
    const existing = this.messagesById.get(messageId);
    if (existing !== undefined) return existing;
    const created = emptyMessage(messageId);
    this.messagesById.set(messageId, created);
    return created;
  }

  private ensureTool(toolCallId: ToolCallId, name: string): Draft<ToolCallSurface> {
    const existing = this.toolsByCallId.get(toolCallId);
    if (existing !== undefined) {
      if (name !== '' && existing.name === '') existing.name = name;
      return existing;
    }
    const created = emptyTool(toolCallId, name === '' ? 'tool' : name);
    this.toolsByCallId.set(toolCallId, created);
    return created;
  }

  private replaceInOrder(turn: TurnSurface): void {
    const index = this.turnsByOrder.findIndex((t) => t.turnId === turn.turnId);
    if (index >= 0) this.turnsByOrder[index] = turn;
    else this.turnsByOrder.push(turn);
  }

  /**
   * Retire every turn still open, and report the ones that were.
   *
   * A turn left in `running` after its run has ended is exactly the "this turn
   * finished" / "this turn never finished" ambiguity the protocol added
   * `turn.completed` to remove, so this closes the gap on the failure path too.
   */
  private closeOpenTurns(phase: 'completed' | 'failed'): readonly TurnSurface[] {
    const retired: TurnSurface[] = [];
    for (let i = 0; i < this.turnsByOrder.length; i += 1) {
      const turn = this.turnsByOrder[i];
      if (turn === undefined) continue;
      if (turn.phase !== 'running' && turn.phase !== 'retrying') continue;
      const closed: TurnSurface = { ...turn, phase };
      this.turnsByOrder[i] = closed;
      this.turnsById.set(closed.turnId, closed);
      retired.push(closed);
    }
    return retired;
  }
}

function toHookSurface(event: HookInvokedPayload): HookSurface {
  return {
    hookName: event.hookName,
    hookType: event.hookType,
    hookEventName: event.hookEventName,
    agentEventType: event.agentEventType,
    async: event.async,
    status: event.status,
    durationMs: event.durationMs,
    errorMessage: event.errorMessage ?? null,
    backgroundTaskId: event.backgroundTaskId ?? null,
  };
}

/** Re-exported so a host does not need a second import to branch on one. */
export type { ErrorCode, PermissionAction, PermissionRequest, MessageContent };
