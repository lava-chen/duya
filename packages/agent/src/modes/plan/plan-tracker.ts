/**
 * PlanModeTracker — 4-state plan mode state machine (plan 413b).
 *
 * A TypeScript port of grok's `PlanModeTracker` (`plan_mode.rs`), adapted
 * to duya's plan-task mode. It is the single deterministic source of
 * truth for plan-mode lifecycle state:
 *
 *   inactive → pending → active → exit_pending → inactive
 *
 *  - `pending`      : the user entered plan mode but the model has not
 *                     received the full activation reminder yet.
 *  - `active`       : plan mode is live; write tools are gated
 *                     (`canGateTools()`).
 *  - `exit_pending` : the user exited mid-turn; the in-flight turn must
 *                     finish before the exit reminder fires
 *                     (`completeDeferredExit()`).
 *
 * Transitions are pure (no async I/O), idempotent, and return whether a
 * transition actually happened so the coordinator can decide whether to
 * persist. Snapshot restore folds transient states (pending/exit_pending)
 * back to inactive so a restart never resurrects a half-open plan turn.
 */

import type { ModeTracker } from './tracker.js';

/** Plan mode lifecycle state. */
export type PlanModeState = 'inactive' | 'pending' | 'active' | 'exit_pending';

/** Persisted snapshot shape (mirrors grok `PlanModeSnapshot`). */
export interface PlanModeSnapshot {
  state: PlanModeState;
  wasPreviouslyActive: boolean;
  reminderCount: number;
  pendingExitReminder: boolean;
  awaitingPlanApproval: boolean;
}

/** User/tool/coordinator events that drive transitions. */
export type PlanModeEvent =
  | 'enter'
  | 'activate'
  | 'activate_mid_turn'
  | 'activate_from_tool'
  | 'exit_approved'
  | 'user_exit';

/** Per-call options for {@link PlanModeTracker.transition}.
 *
 *  - `inFlight`     : whether an agent turn is currently in flight —
 *                     `user_exit` defers to `exit_pending` when true.
 *  - `reminderText` : the reminder text to buffer for a mid-turn
 *                     activation (consumed by `takePendingActivation`).
 */
export interface PlanModeTransitionOptions {
  inFlight?: boolean;
  reminderText?: string;
}

const PLAN_MODE_STATES = new Set<PlanModeState>([
  'inactive',
  'pending',
  'active',
  'exit_pending',
]);

/**
 * Buffered mid-turn activation payload. `priorWasPreviouslyActive`
 * captures the value before this activation so `user_exit` can roll the
 * tracker back instead of deferring the exit.
 */
interface PendingActivation {
  text: string;
  priorWasPreviouslyActive: boolean;
}

export class PlanModeTracker
  implements ModeTracker<PlanModeState, PlanModeEvent, PlanModeSnapshot>
{
  readonly id = 'plan-task';

  // Named `currentState` (not `state`) so the field does not shadow the
  // public `state()` method — under native class-field semantics an
  // instance field named `state` would override the prototype method.
  private currentState: PlanModeState = 'inactive';
  private wasPreviouslyActive = false;
  private reminderCount = 0;
  private pendingExitReminder = false;
  private awaitingPlanApproval = false;
  private pendingActivation: PendingActivation | null = null;

  state(): PlanModeState {
    return this.currentState;
  }

  /** Runtime tool gating is live only while plan mode is active (plan 413d). */
  canGateTools(): boolean {
    return this.currentState === 'active';
  }

  /** A reminder is due while pending, active, or with an exit notice outstanding. */
  shouldInjectReminder(): boolean {
    return this.currentState === 'pending' || this.currentState === 'active' || this.pendingExitReminder;
  }

  snapshot(): PlanModeSnapshot {
    return {
      state: this.currentState,
      wasPreviouslyActive: this.wasPreviouslyActive,
      reminderCount: this.reminderCount,
      pendingExitReminder: this.pendingExitReminder,
      awaitingPlanApproval: this.awaitingPlanApproval,
    };
  }

  /**
   * Restore from a snapshot with fold semantics (grok `from_snapshot`):
   *  - `pending`      → `inactive` (wait for a fresh user `enter`)
   *  - `exit_pending` → `inactive` + `pendingExitReminder` (replay exit notice)
   *  - everything else restores verbatim
   * `pendingActivation` is deliberately not persisted — a restart drops a
   * half-open mid-turn activation; the next `active` reminder covers it.
   * Invalid snapshots throw so the persistence layer reports failure.
   */
  restore(raw: PlanModeSnapshot): void {
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof (raw as { state?: unknown }).state !== 'string' ||
      !PLAN_MODE_STATES.has((raw as PlanModeSnapshot).state)
    ) {
      throw new Error(`invalid PlanModeSnapshot: ${JSON.stringify(raw)}`);
    }
    const state = raw.state as PlanModeState;
    this.currentState = state === 'pending' || state === 'exit_pending' ? 'inactive' : state;
    this.wasPreviouslyActive =
      typeof raw.wasPreviouslyActive === 'boolean' ? raw.wasPreviouslyActive : false;
    this.reminderCount = typeof raw.reminderCount === 'number' ? raw.reminderCount : 0;
    this.pendingExitReminder =
      state === 'exit_pending'
        ? true
        : typeof raw.pendingExitReminder === 'boolean'
          ? raw.pendingExitReminder
          : false;
    this.awaitingPlanApproval =
      typeof raw.awaitingPlanApproval === 'boolean' ? raw.awaitingPlanApproval : false;
    this.pendingActivation = null;
  }

  /**
   * Transition table (plan 413b §2.3). Returns whether the state changed;
   * illegal/no-op events return false without throwing.
   */
  transition(event: PlanModeEvent, opts: PlanModeTransitionOptions = {}): boolean {
    switch (this.currentState) {
      case 'inactive':
        if (event === 'enter') {
          this.currentState = 'pending';
          return true;
        }
        if (event === 'activate_from_tool') {
          this.activate();
          return true;
        }
        return false;

      case 'pending':
        if (event === 'activate') {
          this.activate();
          return true;
        }
        if (event === 'activate_mid_turn') {
          const prior = this.wasPreviouslyActive;
          this.activate();
          this.pendingActivation = {
            text: opts.reminderText ?? '',
            priorWasPreviouslyActive: prior,
          };
          return true;
        }
        if (event === 'user_exit') {
          // Clean cancel before any activation — no exit reminder needed.
          this.currentState = 'inactive';
          this.pendingActivation = null;
          return true;
        }
        return false;

      case 'active':
        if (event === 'exit_approved') {
          this.currentState = 'inactive';
          this.awaitingPlanApproval = false;
          this.pendingActivation = null;
          this.reminderCount = 0;
          return true;
        }
        if (event === 'user_exit') {
          // Undelivered mid-turn activation: roll the activation back
          // instead of deferring the exit (grok's rollback semantics).
          if (this.pendingActivation) {
            const prior = this.pendingActivation.priorWasPreviouslyActive;
            this.pendingActivation = null;
            this.currentState = 'inactive';
            this.wasPreviouslyActive = prior;
            return true;
          }
          if (opts.inFlight) {
            this.currentState = 'exit_pending';
            return true;
          }
          this.currentState = 'inactive';
          this.pendingExitReminder = true;
          return true;
        }
        return false;

      case 'exit_pending':
        // Re-entry while a deferred exit is outstanding: the model still
        // has plan context, so cancel the exit without an activation reminder.
        if (event === 'enter') {
          this.currentState = 'active';
          return true;
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Deferred-exit completion (plan 413d round-end): the in-flight turn
   * has ended, so land the tracker back in `inactive` and arm the
   * one-shot exit reminder. No-op unless currently `exit_pending`.
   */
  completeDeferredExit(): boolean {
    if (this.currentState !== 'exit_pending') return false;
    this.currentState = 'inactive';
    this.pendingExitReminder = true;
    return true;
  }

  /** True when this is a re-entry into plan mode (previously active). */
  isReentry(): boolean {
    return this.wasPreviouslyActive && this.currentState === 'pending';
  }

  /** Full reminders fire on even counts; sparse on odd (token saving). */
  shouldUseFullReminder(): boolean {
    return this.reminderCount % 2 === 0;
  }

  hasPendingExitReminder(): boolean {
    return this.pendingExitReminder;
  }

  hasPendingActivation(): boolean {
    return this.pendingActivation !== null;
  }

  /** Consume the buffered mid-turn activation text (exactly once). */
  takePendingActivation(): string | null {
    if (!this.pendingActivation) return null;
    const text = this.pendingActivation.text;
    this.pendingActivation = null;
    return text;
  }

  /** Record that a reminder was injected this turn (flips full/sparse). */
  recordReminderInjected(): void {
    this.reminderCount++;
  }

  clearPendingExitReminder(): void {
    this.pendingExitReminder = false;
  }

  /** After compaction, reset the alternation so the next reminder is full. */
  resetAfterCompaction(): void {
    this.reminderCount = 0;
  }

  /** Shared activation bookkeeping for every enter-active path. */
  private activate(): void {
    this.currentState = 'active';
    this.wasPreviouslyActive = true;
    this.reminderCount = 0;
    this.pendingExitReminder = false;
    this.awaitingPlanApproval = false;
  }
}

/**
 * Singleton plan-mode tracker. Registered against the mode engine in
 * `modes/index.ts` and shared across `streamChat` calls so plan-mode
 * state survives across messages (plan 413b/413d).
 */
export const planModeTracker = new PlanModeTracker();
