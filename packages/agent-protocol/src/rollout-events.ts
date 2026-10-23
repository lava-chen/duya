/**
 * Rollout process events (plan 333) + rebase events.
 *
 * Plan 333 introduced four typed process events (`reasoning`, `tool_call`,
 * `turn_started`, `system_context`) so the rollout JSONL can describe the
 * non-message side of a session (thinking, tool round edges, turn envelopes,
 * injected system context). Plan 441 extends this with `rebase` events that
 * replace the historical `rewriteSession` mutation: compaction and
 * edit-resend become append-only operations that supersede prior seqs in
 * the projection layer instead of rewriting the rollout file.
 *
 * Rollout events are NOT projected back into the LLM-visible timeline
 * (`MessageLog.project` skips them). They live in `timeline()` for audit and
 * recovery. `rebase` events are the only exception — `applyRebases()` uses
 * them to filter/supersede messages in `project()`.
 */

import type { CompactionEntry, MessageEntry } from './message-timeline.js';

/**
 * Model reasoning trace (the `assistant.content[].thinking` block promoted
 * to a standalone rollout row for audit/replay).
 */
export interface ReasoningEvent {
  type: 'reasoning';
  /** Deterministic id. INSERT OR IGNORE relies on this being stable. */
  id: string;
  turnId: string;
  /** `provider:model` label for which model emitted the trace. */
  model: string;
  /** Complete thinking text (post-stream, not the streaming delta). */
  text: string;
  createdAt: number;
}

/**
 * Tool call boundary (call started, before the result is known).
 * Pairs with the existing `role:'tool'` MessageEntry — the message row
 * carries the result; the tool_call event captures the input edge that
 * the message row does not.
 */
export interface ToolCallEvent {
  type: 'tool_call';
  id: string;
  turnId: string;
  /** = tool_use_id in the assistant tool_use block. */
  callId: string;
  toolName: string;
  /**
   * Bounded serialized input (truncate to ~2KB before persist to keep
   * rollout files from bloating on large arguments).
   */
  inputSummary: string;
  createdAt: number;
}

/**
 * Turn envelope (turn start). Mirrors codex `task_started` / `turn_context`:
 * captures cwd, approval policy, and the turn id so the rollout file is
 * self-contained — the `message_index.turn_id` column is a query convenience,
 * not the source of truth.
 */
export interface TurnStartedEvent {
  type: 'turn_started';
  id: string;
  turnId: string;
  cwd?: string;
  approvalPolicy?: string;
  /** Started timestamp; uses `startedAt` (not `createdAt`) for plan 333 parity. */
  startedAt: number;
}

/**
 * System / developer context injected into the turn (AGENTS.md body,
 * app-context, etc.). Deduplicated by turnId — at most one per turn.
 */
export interface SystemContextEvent {
  type: 'system_context';
  id: string;
  turnId: string;
  kind: 'agents_md' | 'app_context';
  content: string;
  createdAt: number;
}

/**
 * Rebase event — supersedes every MessageEntry with `seq <= supersededUpToSeq`
 * in the projection (`project()`), replacing them with `newMessages`. This is
 * how compaction and edit-resend become append-only: the rollout file is
 * never mutated, only the projection changes.
 *
 * `supersededUpToSeq` may be `null`/omitted, which means "supersede ALL raw
 * messages that appear before this rebase in the trace". Compaction always
 * wants this form: the agent subprocess has no reliable view of the DB-assigned
 * per-session seq, so any locally-computed numeric bound is wrong for resumed
 * sessions. Kept messages survive via id matching in `newMessages`.
 *
 * `newMessages` are themselves MessageEntry objects with `seq = NaN`-free
 * (rebase-time seq is irrelevant because the projection re-derives effective
 * seq from scratch after applying all rebases in order).
 */
export interface RebaseEvent {
  type: 'rebase';
  id: string;
  turnId: string | null;
  /** Highest seq whose line should be replaced by newMessages; null = all prior rows. */
  supersededUpToSeq?: number | null;
  /**
   * Why this rebase was emitted. Drives rotation in `appendBatch`:
   * - `compaction` — auto/manual compaction; rotates the rollout file so the
   *   compacted summary lands as the first data row of a new generation
   *   (Plan 506 C1 + Plan 493 Phase B).
   * - `edit_resend` — user edit / message truncate; inline mutation that
   *   must NOT rotate (it is not an epoch boundary).
   *
   * Optional for backwards compatibility — historical events from before
   * this field existed are all compaction form (Plan 441), so the rotation
   * trigger treats a missing reason as `compaction`.
   */
  reason?: 'compaction' | 'edit_resend';
  newMessages: MessageEntry[];
  createdAt: number;
}

export type RolloutProcessEvent =
  | ReasoningEvent
  | ToolCallEvent
  | TurnStartedEvent
  | SystemContextEvent;

/**
 * Rotation event (Plan 493, Phase B). Written by `MessageLog.rotateArchive`
 * when compaction or a manual operator command rotates a bot session's
 * `active.jsonl` into `archive-<generation>.jsonl` and starts a fresh
 * `active.jsonl` for the next segment. The event is the audit marker that
 * bridges two adjacent archive segments; consumers that read the rollout
 * file linearly can detect the boundary by scanning for `type: 'rotation'`
 * without consulting the message_index table.
 *
 * `archiveFile` is the relative path of the rotated-out file
 * (`archive-<prevGeneration>.jsonl`, resolved against the bot's
 * `<agentDir>/sessions/` directory). `newGeneration` is the value stamped
 * on every message_index row written into the new `active.jsonl`. The
 * previous generation is implicit: the rotation event is always the LAST
 * entry in the archive it closes (and the FIRST in the next active file
 * because rotateArchive writes it as a tail entry on the new active file).
 *
 * `reason` is one of `compaction` (auto, triggered by the compact tool
 * path) or `manual` (operator-driven; reserved for future use — currently
 * no UI exposes a manual rotate).
 *
 * `seqBeforeRotation` is the highest seq number that was written before
 * the rotation (i.e. the count of rows in the archive that just closed).
 * It is informational — the projection layer never consults it — but it
 * makes the audit log self-describing and lets a reader compute the
 * segment length without scanning the file.
 */
export interface RotationEvent {
  type: 'rotation';
  id: string;
  /** Relative path of the file that was rotated OUT (the archive segment). */
  archiveFile: string;
  /** Generation stamped on rows written INTO the new active file. */
  newGeneration: number;
  /** Why the rotation happened. */
  reason: 'compaction' | 'manual';
  /** Highest seq written before the rotation. Informational only. */
  seqBeforeRotation: number;
  /** Match rebase id shape (`<event-type>:<sessionId>:<key>:<ts>`) for parser parity. */
  createdAt: number;
}

/**
 * A hook fired during a turn. The payload is caller-defined.
 *
 * This type used to live ONLY in the worker-side journal mirror, which
 * meant the protocol did not recognise it: `deriveKind` fell through to
 * `payload.message.role`, threw inside the write transaction, and left
 * an orphan line in the rollout file with no index row. The type is
 * registered here so the taxonomy has one authority (plan 620 Phase A).
 */
export interface HookInvokedEvent {
  type: 'hook_invoked';
  id: string;
  turnId: string;
  /** HookInvokedEvent-shaped payload (caller-defined). */
  payload: unknown;
  createdAt: number;
}

/**
 * The assembled prompt of one turn: the system prompt as it was handed
 * to the provider, plus the volatile blocks that travelled on the
 * message channel instead (plan 619 Phase 4).
 *
 * The content is recorded, not just a digest: the question this answers
 * is "what did the model actually see", and a hash cannot answer it.
 */
export interface PromptSnapshotEvent {
  type: 'prompt_snapshot';
  id: string;
  turnId: string;
  createdAt: number;
  /** The system prompt, as assembled. */
  systemPrompt: PromptSnapshotPart;
  /** The volatile context blocks delivered on the message channel. */
  contextBlocks: PromptSnapshotBlock[];
  /**
   * True when the caller supplied its own system prompt, so the recorded
   * text is the caller's, not the one this session assembled.
   */
  overridden?: boolean;
}

/** One recorded piece of a prompt. */
export interface PromptSnapshotPart {
  /** SHA-256 of the content, hex encoded. */
  hash: string;
  /** Character length of the content. */
  length: number;
  /**
   * The content itself, when it is recorded. Absent when it was not
   * written — see the ledger's reason field.
   */
  content?: string;
  /** Why the content is missing, when it is. */
  omitted?: 'unchanged' | 'quota' | 'disabled';
}

/** One recorded volatile-context block. */
export interface PromptSnapshotBlock extends PromptSnapshotPart {
  /** The slot the block filled (the prompt section name). */
  id: string;
  /** The taxonomy entry the block was rendered under. */
  source: string;
  /** Which channel the block was delivered on. */
  role: 'system' | 'user';
}

/** Full set of non-message rollout events. */
export type RolloutEvent =
  | RolloutProcessEvent
  | RebaseEvent
  | RotationEvent
  | HookInvokedEvent
  | PromptSnapshotEvent;

export type RolloutEventType = RolloutEvent['type'];

/** Append-only, durable entries stored in a session rollout. */
export type DurableTimelineEntry = MessageEntry | CompactionEntry | RolloutEvent;

/**
 * THE authoritative list of rollout event discriminators.
 *
 * Every consumer derives from this one table: the type union above, the
 * runtime guard, the storage layer's `kind` column, the HTTP validator
 * and the worker-side journal mirror. Adding a rollout event type used
 * to mean editing seven places in lockstep, and forgetting one of them
 * did not fail loudly — an unknown `type` fell through `deriveKind` to
 * `payload.message.role`, threw a TypeError inside the write
 * transaction, and left an orphan line in the rollout file with no
 * index row (that is exactly how `hook_invoked` behaved).
 *
 * The value says WHO produces the event: the worker journal emits
 * `'worker'` events, the storage layer produces `'storage'` ones (the
 * rotation marker), and `'reserved'` marks a type whose schema is kept
 * although nothing writes it today. The reserved ones are not deleted:
 * they have schema and read-side consumers, and "nobody writes it" is
 * not a reason to remove it (plan 620 Phase A7).
 *
 * The table lives in THIS file on purpose. The esbuild pipeline this
 * repo runs under has historically dropped CROSS-MODULE const references
 * at runtime; a same-module constant survives that, and the runtime
 * guard is derived from it instead of from a second hand-written list.
 */
const ROLLOUT_EVENT_DISCRIMINATORS = {
  reasoning: 'reserved',
  tool_call: 'reserved',
  turn_started: 'reserved',
  system_context: 'reserved',
  hook_invoked: 'worker',
  rebase: 'worker',
  rotation: 'storage',
  prompt_snapshot: 'worker',
} as const;

/** Every rollout event discriminator, derived from the authority above. */
export const ROLLOUT_EVENT_TYPES: readonly RolloutEventType[] = Object.keys(
  ROLLOUT_EVENT_DISCRIMINATORS,
) as RolloutEventType[];

/** The event types the worker-side journal can emit, derived the same way. */
export const WORKER_EMITTABLE_EVENT_TYPES: readonly RolloutEventType[] =
  ROLLOUT_EVENT_TYPES.filter(
    (type) =>
      (ROLLOUT_EVENT_DISCRIMINATORS as Record<string, string>)[type] === 'worker',
  );

/**
 * The event types the worker-side journal can emit.
 *
 * The storage layer produces the rotation marker, and the reserved types
 * have no producer today — neither is the worker's to emit.
 */
export type WorkerEmittableEventType = {
  [K in RolloutEventType]: (typeof ROLLOUT_EVENT_DISCRIMINATORS)[K] extends 'worker'
    ? K
    : never;
}[RolloutEventType];

/**
 * True when the string names a rollout event.
 *
 * Exported so the consumers that cannot import the table itself (the
 * storage layer, the HTTP validator) still share one authority: they
 * call a function, and a function reference survives the bundler in a
 * way a cross-module const reference does not.
 */
export function isRolloutEventType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROLLOUT_EVENT_DISCRIMINATORS, type);
}

/** Type guard: returns true for any rollout-event payload (vs. message/compaction). */
export function isRolloutEvent(
  payload: unknown,
): payload is RolloutEvent {
  if (typeof payload !== 'object' || payload === null) return false;
  const t = (payload as { type?: unknown }).type;
  return typeof t === 'string' && isRolloutEventType(t);
}

/**
 * Best-effort timestamp for any rollout line, normalized to ms epoch for the
 * `message_index.created_at` column. Most payload kinds expose `createdAt`
 * directly; `TurnStartedEvent` uses `startedAt` per plan 333.
 *
 * Falls back to `0` when neither field exists (defensive — every line in
 * practice has at least one timestamp; the fallback only triggers if a new
 * payload kind is added without updating this helper).
 *
 * Structural input type so this helper does not import from message-log.ts,
 * keeping the module graph acyclic.
 */
export function rolloutLineTimestamp(
  payload: { createdAt?: number; startedAt?: number } | unknown,
): number {
  if (typeof payload !== 'object' || payload === null) return 0;
  const p = payload as { createdAt?: number; startedAt?: number };
  if (typeof p.createdAt === 'number') return p.createdAt;
  if (typeof p.startedAt === 'number') return p.startedAt;
  return 0;
}
