/**
 * PlanModeTracker — the plan-task lifecycle state machine (plan 413b).
 *
 * A TypeScript port of grok's `plan_mode.rs` PlanModeTracker, backing the
 * `plan-task` mode modifier as its runtime state machine. Pure — no async I/O
 * and no plan-file concept: duya's plan-task is a read-only analysis mode that
 * produces a plan, so the templates and gating follow the existing read-only
 * contract (see plan 413b §2.5 for why `plan.md` is intentionally omitted).
 *
 * The 413d coordinator drives it per turn via `transition`; the 413c
 * persistence layer round-trips it through `snapshot`/`restore`.
 */

import type { ModeTracker } from './tracker.js';

/** Lifecycle state of plan mode. Mirrors grok's `PlanModeState`. */
export type PlanModeState = 'inactive' | 'pending' | 'active' | 'exit_pending';

/** Events that drive {@link PlanModeTracker.transition}. */
export type PlanModeEvent =
  | 'enter'
  | 'activate'
  | 'activate_mid_turn'
  | 'activate_from_tool'
  | 'exit_approved'
  | 'user_exit';

/** Serializable snapshot of the tracker's lifecycle (plan 413c persists this). */
export interface PlanModeSnapshot {
  state: PlanModeState;
  wasPreviouslyActive: boolean;
  reminderCount: number;
  pendingExitReminder: boolean;
  /** Client was shown an exit approval but has not answered yet. */
  awaitingPlanApproval: boolean;
}

/** Optional per-event payload carried by `transition` (see method docs). */
export interface PlanModeTransitionPayload {
  /** `user_exit` — whether a model turn is currently in flight. */
  turnInFlight?: boolean;
  /** `activate_mid_turn` — the pre-rendered activation reminder text. */
  renderedReminder?: string;
}

/** Buffered mid-turn activation reminder plus rollback metadata. */
interface PendingActivation {
  text: string;
  /** `wasPreviouslyActive` before this activation; restored on withdrawal. */
  priorWasPreviouslyActive: boolean;
}

const VALID_STATES: readonly PlanModeState[] = [
  'inactive',
  'pending',
  'active',
  'exit_pending',
];

function isValidState(value: unknown): value is PlanModeState {
  return VALID_STATES.includes(value as PlanModeState);
}

function isValidSnapshot(raw: unknown): raw is PlanModeSnapshot {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    isValidState(r.state) &&
    typeof r.wasPreviouslyActive === 'boolean' &&
    typeof r.reminderCount === 'number' &&
    typeof r.pendingExitReminder === 'boolean' &&
    typeof r.awaitingPlanApproval === 'boolean'
  );
}

/**
 * 4-state plan mode tracker. Implements {@link ModeTracker} so it plugs into
 * the {@link ModeTrackerEngine} / coordinator, plus plan-specific helpers used
 * by the 413d reminder injection.
 */
export class PlanModeTracker
  implements ModeTracker<PlanModeState, PlanModeEvent, PlanModeSnapshot>
{
  readonly id = 'plan-task';

  private stateValue: PlanModeState = 'inactive';
  private wasPreviouslyActive = false;
  private reminderCount = 0;
  private pendingExitReminder = false;
  private awaitingPlanApproval = false;
  private pendingActivation: PendingActivation | null = null;

  state(): PlanModeState {
    return this.stateValue;
  }

  /**
   * Idempotent transition. Returns whether the state actually changed; illegal
   * or repeated events are a no-op returning `false`.
   *
   * `payload.turnInFlight` (for `user_exit`) and `payload.renderedReminder`
   * (for `activate_mid_turn`) carry per-event arguments — they are optional so
   * `transition(event)` stays valid for events that need none.
   */
  transition(
    event: PlanModeEvent,
    payload?: PlanModeTransitionPayload,
  ): boolean {
    switch (event) {
      case 'enter':
        return this.enterPending();
      case 'activate':
        return this.activate();
      case 'activate_mid_turn':
        return this.activateMidTurn(payload?.renderedReminder);
      case 'activate_from_tool':
        return this.activateFromTool();
      case 'exit_approved':
        return this.deactivateApproved();
      case 'user_exit':
        return this.userExit(payload?.turnInFlight ?? false);
    }
  }

  /** Tool gating: write/execute tools are blocked only while fully active. */
  canGateTools(): boolean {
    return this.stateValue === 'active';
  }

  /** Per-turn reminder injection is due while pending/active or an exit is queued. */
  shouldInjectReminder(): boolean {
    return (
      this.stateValue === 'pending' ||
      this.stateValue === 'active' ||
      this.pendingExitReminder
    );
  }

  snapshot(): PlanModeSnapshot {
    return {
      state: this.stateValue,
      wasPreviouslyActive: this.wasPreviouslyActive,
      reminderCount: this.reminderCount,
      pendingExitReminder: this.pendingExitReminder,
      awaitingPlanApproval: this.awaitingPlanApproval,
    };
  }

  /**
   * Restore from a snapshot (crash recovery). Applies the folding semantics of
   * plan 413b §2.4: `pending` collapses to `inactive` (the client must re-enter)
   * and `exit_pending` collapses to `inactive` with an exit reminder queued
   * (the in-flight turn that deferred the exit is gone). `pendingActivation` is
   * never persisted — the next Active-state injection covers it.
   *
   * Throws `TypeError` on a malformed payload so the persistence layer's
   * `applySnapshot` catch can report `false` (plan 413a).
   */
  restore(raw: PlanModeSnapshot): void {
    if (!isValidSnapshot(raw)) {
      throw new TypeError('invalid PlanModeSnapshot');
    }
    let state = raw.state;
    let pendingExitReminder = raw.pendingExitReminder;
    if (state === 'pending') {
      state = 'inactive';
    } else if (state === 'exit_pending') {
      state = 'inactive';
      pendingExitReminder = true;
    }
    this.stateValue = state;
    this.wasPreviouslyActive = raw.wasPreviouslyActive;
    this.reminderCount = raw.reminderCount;
    this.pendingExitReminder = pendingExitReminder;
    this.awaitingPlanApproval = raw.awaitingPlanApproval;
    this.pendingActivation = null;
  }

  // ─── plan-specific helpers (413d reminder injection / 413c persistence) ───

  /** Second+ entry into plan mode this session. */
  isReentry(): boolean {
    return this.wasPreviouslyActive && this.stateValue === 'pending';
  }

  /** Even reminder counts render the full variant, odd the sparse one. */
  shouldUseFullReminder(): boolean {
    return this.reminderCount % 2 === 0;
  }

  hasPendingExitReminder(): boolean {
    return this.pendingExitReminder;
  }

  /** A mid-turn activation reminder is buffered but not yet delivered. */
  hasPendingActivation(): boolean {
    return this.pendingActivation !== null;
  }

  /** Take the buffered activation reminder for delivery (exactly once). */
  takePendingActivation(): string | null {
    const pending = this.pendingActivation;
    this.pendingActivation = null;
    return pending ? pending.text : null;
  }

  /** Advance the full/sparse alternation counter after a reminder is injected. */
  recordReminderInjected(): void {
    this.reminderCount += 1;
  }

  clearPendingExitReminder(): void {
    this.pendingExitReminder = false;
  }

  /** After context compaction the next reminder should be the full variant. */
  resetAfterCompaction(): void {
    if (this.stateValue === 'active') {
      this.reminderCount = 0;
      this.pendingActivation = null;
    }
  }

  isAwaitingPlanApproval(): boolean {
    return this.awaitingPlanApproval;
  }

  /** Park the exit approval UI state (413d wires the `exit_plan_mode` flow). */
  setAwaitingPlanApproval(awaiting: boolean): void {
    this.awaitingPlanApproval = awaiting;
  }

  // ─── event handlers (one per PlanModeEvent; see plan 413b §2.3 table) ───

  /** `enter` — client toggled plan mode ON. */
  private enterPending(): boolean {
    switch (this.stateValue) {
      case 'inactive':
        this.stateValue = 'pending';
        this.pendingExitReminder = false;
        return true;
      case 'exit_pending':
        // Re-entry while a deferred exit is pending: cancel it and return
        // straight to Active — the model already has plan context, so no
        // activation reminder is injected.
        this.stateValue = 'active';
        this.pendingExitReminder = false;
        return true;
      default:
        return false;
    }
  }

  /** `activate` — first user prompt while Pending. */
  private activate(): boolean {
    if (this.stateValue !== 'pending') return false;
    this.stateValue = 'active';
    this.wasPreviouslyActive = true;
    this.reminderCount = 0;
    this.pendingExitReminder = false;
    return true;
  }

  /** `activate_mid_turn` — activate and buffer the reminder for the running turn. */
  private activateMidTurn(renderedReminder: string | undefined): boolean {
    if (this.stateValue !== 'pending') return false;
    const priorWasPreviouslyActive = this.wasPreviouslyActive;
    this.stateValue = 'active';
    this.wasPreviouslyActive = true;
    this.reminderCount = 0;
    this.pendingExitReminder = false;
    // 413d always passes the rendered reminder; a missing payload buffers
    // empty text so the buffer itself still drives the rollback semantics.
    this.pendingActivation = {
      text: renderedReminder ?? '',
      priorWasPreviouslyActive,
    };
    return true;
  }

  /** `activate_from_tool` — agent called EnterPlanMode; skip Pending. */
  private activateFromTool(): boolean {
    if (this.stateValue !== 'inactive') return false;
    this.stateValue = 'active';
    this.wasPreviouslyActive = true;
    this.reminderCount = 0;
    this.pendingExitReminder = false;
    return true;
  }

  /** `exit_approved` — ExitPlanMode approved (agent-initiated exit). */
  private deactivateApproved(): boolean {
    if (this.stateValue !== 'active') return false;
    this.stateValue = 'inactive';
    this.reminderCount = 0;
    this.awaitingPlanApproval = false;
    this.pendingActivation = null;
    return true;
  }

  /** `user_exit` — client toggled plan mode OFF. */
  private userExit(turnInFlight: boolean): boolean {
    this.awaitingPlanApproval = false;
    const pending = this.pendingActivation;
    if (pending && this.stateValue === 'active') {
      // Withdraw an undelivered mid-turn activation: roll the activation back
      // (restore the pre-buffer wasPreviouslyActive) instead of deferring an
      // exit the model never saw.
      this.stateValue = 'inactive';
      this.wasPreviouslyActive = pending.priorWasPreviouslyActive;
      this.pendingActivation = null;
      return true;
    }
    switch (this.stateValue) {
      case 'pending':
        this.stateValue = 'inactive';
        return true;
      case 'active':
        if (turnInFlight) {
          this.stateValue = 'exit_pending';
        } else {
          this.stateValue = 'inactive';
          this.pendingExitReminder = true;
        }
        return true;
      default:
        return false;
    }
  }
}

/**
 * Singleton tracker for the plan-task mode. Registered with the
 * {@link ModeTrackerEngine} in `modes/index.ts` and referenced by
 * {@link planTaskMode.tracker} (plan 413b). Session-scoped state lives in the
 * 413d coordinator / 413c snapshots — the singleton is the per-mode tracker
 * definition, restored per session through `restore`.
 */
export const planModeTracker = new PlanModeTracker();
