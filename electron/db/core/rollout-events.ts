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

import type { MessageEntry } from '@duya/agent/message';

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
  turnId: string;
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

/** Full set of non-message rollout events. */
export type RolloutEvent = RolloutProcessEvent | RebaseEvent | RotationEvent;

export type RolloutEventType = RolloutEvent['type'];

/**
 * Discriminator: which event `type` strings are valid for rollout events.
 * Used by `MessageLog.deriveKind` to map an event payload to its `kind` column.
 *
 * Plain string array (no `as const satisfies`) because vitest's esbuild
 * version in this repo does not preserve the `satisfies` operator at
 * runtime, which surfaced as a ReferenceError. Type-safety for the union
 * is maintained by `RolloutEventType` above; new event types added here
 * must be added to `RolloutEventType` too.
 */
export const ROLLOUT_EVENT_TYPES: readonly RolloutEventType[] = [
  'reasoning',
  'tool_call',
  'turn_started',
  'system_context',
  'rebase',
  'rotation',
];

/** Type guard: returns true for any rollout-event payload (vs. message/compaction). */
export function isRolloutEvent(
  payload: unknown,
): payload is RolloutEvent {
  if (typeof payload !== 'object' || payload === null) return false;
  const t = (payload as { type?: unknown }).type;
  // Inline the discriminator strings rather than referencing ROLLOUT_EVENT_TYPES —
  // vitest's esbuild pipeline in this repo (0.27.7 with the project's tsconfig)
  // has historically dropped cross-module const references at runtime even when
  // the direct esbuild CLI output preserves them. The string literal here is
  // the canonical list; ROLLOUT_EVENT_TYPES exists for documentation and
  // exported for callers that want a runtime list.
  return (
    typeof t === 'string' &&
    (t === 'reasoning' ||
      t === 'tool_call' ||
      t === 'turn_started' ||
      t === 'system_context' ||
      t === 'rebase' ||
      t === 'rotation')
  );
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