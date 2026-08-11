/**
 * ModeCoordinator — runtime orchestrator for mode trackers (plan 413).
 *
 * Plan 413a shipped the skeleton; plan 413d implements the bodies and wires
 * them into the `DuyaAgent.streamChat` turn loop. Responsibilities:
 *  - `injectTurnReminders` : per-turn `<system-reminder>` injection
 *  - `onRoundEnd`          : round-end transitions + persist
 *  - `refreshTurn`         : mid-turn buffered-reminder flush
 *  - `filterTools`         : state-based runtime tool gating
 *  - `resolveTurnMode`     : synthetic/user turn arbitration (MVP)
 *
 * MVP scope is plan-task only: `PlanModeTracker` (plan 413b) is the single
 * registered tracker. Future state machines (e.g. goal) hook in by exposing
 * the same reminder-tracker duck-type.
 */

import { randomUUID } from 'crypto';
import type { ModeTrackerEngine } from './engine.js';
import type { ModeTracker } from './tracker.js';
import {
  renderReminder,
  fullReminder,
  sparseReminder,
  reentryReminder,
  exitReminder,
} from './reminders.js';
import { persistSnapshot } from './persistence.js';

/**
 * Duck-typed view of a plan-mode tracker (`PlanModeTracker`, plan 413b).
 * The {@link ModeTracker} contract only pins the base state machine; the
 * reminder/gating surface below is plan-specific and detected at runtime.
 */
interface PlanReminderTracker extends ModeTracker<string, string, unknown> {
  isReentry(): boolean;
  shouldUseFullReminder(): boolean;
  hasPendingExitReminder(): boolean;
  hasPendingActivation(): boolean;
  takePendingActivation(): string | null;
  recordReminderInjected(): void;
  clearPendingExitReminder(): void;
  completeDeferredExit(): boolean;
}

function isPlanReminderTracker(
  t: ModeTracker<string, string, unknown>,
): t is PlanReminderTracker {
  return typeof (t as PlanReminderTracker).shouldUseFullReminder === 'function';
}

/** Write/execute tools gated out while a tracker is `canGateTools()`-active. */
const GATED_WRITE_TOOLS = new Set(['edit', 'write', 'bash', 'powershell', 'module']);

export class ModeCoordinator {
  constructor(
    private readonly engine: ModeTrackerEngine,
    private readonly sessionId: string,
  ) {}

  /**
   * Append a transient `<system-reminder>` message to the working message
   * array. Same shape as mailbox guidance: `role: 'user'`, `seq_index` set,
   * filtered out of persistence by the `persistableMessages` path.
   */
  private pushReminder(messages: unknown[], seqIndex: number, content: string): void {
    messages.push({
      id: randomUUID(),
      role: 'user',
      content,
      timestamp: Date.now(),
      seq_index: seqIndex,
    });
  }

  /**
   * Per-turn LLM-call preamble: render and inject reminders for every
   * tracker, mirroring grok's `inject_plan_mode_reminders` three cases:
   *  1. `pending` → activate + full/reentry reminder, persist the transition
   *  2. `active`  → full/sparse by `shouldUseFullReminder()` alternation
   *  3. armed exit notice → one-shot exit reminder
   * Only runs for trackers currently due a reminder — each case is gated by
   * tracker state, so no reminder is injected on an idle tracker.
   */
  injectTurnReminders(messages: unknown[], seqIndex: number): void {
    for (const tracker of this.engine.list()) {
      if (!isPlanReminderTracker(tracker)) continue;
      const state = tracker.state();
      if (state === 'pending' && !tracker.hasPendingActivation()) {
        const reentry = tracker.isReentry();
        if (tracker.transition('activate')) {
          // Transition happened → persist so a restart resumes as active.
          void persistSnapshot(tracker, this.sessionId);
          this.pushReminder(
            messages,
            seqIndex,
            renderReminder(reentry ? reentryReminder() : fullReminder()),
          );
          tracker.recordReminderInjected();
        }
      } else if (state === 'active') {
        this.pushReminder(
          messages,
          seqIndex,
          renderReminder(tracker.shouldUseFullReminder() ? fullReminder() : sparseReminder()),
        );
        tracker.recordReminderInjected();
      }
      if (tracker.hasPendingExitReminder()) {
        this.pushReminder(messages, seqIndex, renderReminder(exitReminder()));
        tracker.clearPendingExitReminder();
      }
    }
  }

  /**
   * Round end: state transitions + snapshot persistence. MVP covers plan's
   * `exit_pending → inactive` (the deferred exit completes now that the
   * in-flight turn has ended). Persists only when a transition happened.
   */
  async onRoundEnd(): Promise<void> {
    for (const tracker of this.engine.list()) {
      if (!isPlanReminderTracker(tracker)) continue;
      const before = tracker.state();
      if (before === 'exit_pending') {
        tracker.completeDeferredExit();
      }
      if (tracker.state() !== before) {
        await persistSnapshot(tracker, this.sessionId);
      }
    }
  }

  /**
   * Turn-loop safe point: flush a buffered mid-turn activation reminder
   * exactly once. `takePendingActivation` consumes the buffer, so a restart
   * never replays it. Real UI triggering arrives with plan 413e; the flush
   * path is covered here by unit tests.
   */
  refreshTurn(messages: unknown[], seqIndex: number): void {
    for (const tracker of this.engine.list()) {
      if (!isPlanReminderTracker(tracker)) continue;
      const buffered = tracker.takePendingActivation();
      if (buffered) {
        this.pushReminder(messages, seqIndex, buffered);
        tracker.recordReminderInjected();
      }
    }
  }

  /**
   * State-based runtime tool gating: narrow the tool set when any active
   * tracker has `canGateTools() === true`. Composes ON TOP of the static
   * `tools.block` from `applyModes` — it only reduces the set further based
   * on runtime state (e.g. releasing write tools when plan exits). MVP is
   * implemented + unit-tested; wiring it into the LLM tool chain lands with
   * the frontend session toggle (plan 413e).
   */
  filterTools<T extends { name: string }>(tools: T[]): T[] {
    const gated = this.engine.list().some((t) => t.canGateTools());
    if (!gated) return tools;
    return tools.filter((t) => !GATED_WRITE_TOOLS.has(t.name));
  }

  /**
   * Synthetic/user turn arbitration (MVP simplified). Synthetic turns (goal
   * continuation, background wake) inherit the session's active modes without
   * reconciling tracker state; real user turns are driven by the frontend's
   * `options.mode`, resolved by `DuyaAgent` before this coordinator is built.
   * Full `_meta.mode` reconciliation is deferred. Returns the ids of trackers
   * currently due a reminder — callers treat those as the active modes.
   */
  resolveTurnMode(_origin: 'user' | 'synthetic'): string[] {
    return this.engine
      .list()
      .filter((t) => t.shouldInjectReminder())
      .map((t) => t.id);
  }

  /** The engine backing this coordinator (exposed for tests / wiring). */
  getEngine(): ModeTrackerEngine {
    return this.engine;
  }
}
