/**
 * Plan 624 F1 — codex-style turn-time reminder.
 *
 * The C′ design in `turn-time-reminder.ts` treats the clock as a property of
 * history: every user message is re-rendered from its persisted timestamp so
 * replay bytes stay identical. That is a different philosophy from this file
 * and the two must not be mixed — mixing them loses both replay determinism
 * and change explainability.
 *
 * Here the clock is a live observation emitted on a cadence:
 *
 *   - a reminder is due when `intervalSeconds` have passed since the last one,
 *   - `after-user-or-tool-output` suppresses it on a pure assistant turn,
 *   - a new window (compaction changes the window id) forces one immediately,
 *   - an unreadable clock still emits, with an explicit unavailable text,
 *     rather than silently pretending the time is known.
 *
 * The decision is a pure function so it can be tested without a session; the
 * caller owns the state and the emission. It lives in the host composition
 * layer rather than `agent-core` because the host owns emission policy, and a
 * new cross-package subpath cannot be typechecked from a worktree until the
 * junction's `dist` is rebuilt (plan 624 finding 7).
 */
/** How often a reminder may interrupt a turn. */
export type TimeReminderDeliveryMode = 'any-inference' | 'after-user-or-tool-output';

/** What kind of turn is about to be sent. */
export type TimeReminderTurnKind = 'user' | 'tool' | 'assistant';

/** What the caller remembers between emissions. */
export interface TimeReminderEmissionState {
  /** Epoch ms of the last emitted reminder, if any. */
  readonly lastEmittedAtMs?: number;
  /** Window the last emission belonged to (compaction changes it). */
  readonly emittedWindowId?: string;
  /**
   * Text of the last emission. The host's context rail is rebuilt from the
   * timeline on every request, so a turn with no new emission must keep
   * re-sending this text instead of dropping the block.
   */
  readonly lastContent?: string;
}

export interface TimeReminderRequest {
  readonly nowMs: number;
  /** Current conversation window; a different id means history was compacted. */
  readonly windowId: string;
  readonly intervalSeconds: number;
  readonly deliveryMode: TimeReminderDeliveryMode;
  readonly turnKind: TimeReminderTurnKind;
  readonly state: TimeReminderEmissionState;
  /** False when the clock could not be read at all. */
  readonly clockAvailable: boolean;
}

export type TimeReminderReason =
  | 'clock-unavailable'
  | 'window-changed'
  | 'first-emission'
  | 'not-due'
  | 'delivery-mode'
  | 'interval-elapsed';

export interface TimeReminderDecision {
  readonly emit: boolean;
  readonly reason: TimeReminderReason;
}

export function decideTimeReminder(request: TimeReminderRequest): TimeReminderDecision {
  if (!request.clockAvailable) {
    // An unreadable clock is a fact the model should know, not something to
    // paper over with a stale timestamp.
    return { emit: true, reason: 'clock-unavailable' };
  }
  if (request.state.emittedWindowId !== request.windowId) {
    // First emission and post-compaction both land here; the distinction does
    // not change what is sent.
    return {
      emit: true,
      reason: request.state.emittedWindowId === undefined ? 'first-emission' : 'window-changed',
    };
  }
  if (request.state.lastEmittedAtMs === undefined) {
    return { emit: true, reason: 'first-emission' };
  }

  const intervalMs = Math.max(0, request.intervalSeconds) * 1000;
  if (request.nowMs - request.state.lastEmittedAtMs < intervalMs) {
    return { emit: false, reason: 'not-due' };
  }
  if (request.deliveryMode === 'after-user-or-tool-output' && request.turnKind === 'assistant') {
    return { emit: false, reason: 'delivery-mode' };
  }
  return { emit: true, reason: 'interval-elapsed' };
}

/** UTC ISO rendering. Deliberately locale-free so bytes are reproducible. */
export function renderTimeReminder(nowMs: number): string {
  return `Current time: ${new Date(nowMs).toISOString()} (UTC)`;
}

export function renderTimeUnavailable(): string {
  return 'Current time: unavailable (the clock could not be read).';
}
