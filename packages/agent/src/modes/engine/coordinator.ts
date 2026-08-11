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
} from '../plan/reminders.js';
import { renderGoalContinuation } from '../goal/goal-reminders.js';
import type { GoalTracker } from '../goal/goal-tracker.js';
import { persistSnapshot, restoreTracker } from './persistence.js';
import { expandPath } from '../../utils/path.js';
import {
  resolvePlanFilePath,
  isPlanFileWrite,
} from '../plan/plan-file-path.js';

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

/**
 * Duck-typed view of the goal tracker (`GoalTracker`, plan 411). The goal
 * branch is orthogonal to the plan branch: goal injects a continuation
 * reminder each round while active, and persists on round-end so a restart
 * resumes the objective.
 */
interface GoalReminderTracker extends ModeTracker<string, string, unknown> {
  recordWorkerRound(): void;
  updateTokenUsage(used: number): boolean;
}

function isGoalReminderTracker(
  t: ModeTracker<string, string, unknown>,
): t is GoalReminderTracker {
  return typeof (t as GoalReminderTracker).recordWorkerRound === 'function';
}

/** Cast a goal duck-type to the concrete tracker for payload events / renderers. */
function asGoalTracker(t: GoalReminderTracker): GoalTracker {
  return t as unknown as GoalTracker;
}

/** Write/execute tools gated out while a tracker is `canGateTools()`-active. */
const GATED_WRITE_TOOLS = new Set(['edit', 'write', 'bash', 'powershell', 'module']);

export class ModeCoordinator {
  /**
   * @param engine      the ModeTrackerEngine holding all registered trackers
   * @param sessionId   the session these turns belong to
   * @param activeTrackerIds trackers active THIS turn (mode ids with a
   *   tracker in `resolvedModes`). When omitted, every registered tracker is
   *   considered active (single-tracker compatibility for tests). Scoping to
   *   the active set prevents a dormant tracker (e.g. planModeTracker while
   *   only goal mode is on) from being auto-activated or injected by the
   *   coordinator (plan 411 follow-up: goal mode must not wake plan mode).
   */
  constructor(
    private readonly engine: ModeTrackerEngine,
    private readonly sessionId: string,
    private readonly activeTrackerIds?: ReadonlySet<string>,
  ) {}

  /** Whether this tracker belongs to the current turn's active mode set. */
  private isActive(tracker: ModeTracker<string, string, unknown>): boolean {
    return !this.activeTrackerIds || this.activeTrackerIds.has(tracker.id);
  }

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
      if (!this.isActive(tracker)) continue;
      // Goal branch: while the goal is active/verifying, inject the per-round
      // continuation (goal-state + sentinel + verifier gaps). The goal tracker
      // self-activates via `start` (triggered by the /goal command or tool), so
      // no enter-path nudge is needed here. Persists on round-end, not here.
      if (isGoalReminderTracker(tracker)) {
        if (tracker.shouldInjectReminder()) {
          this.pushReminder(
            messages,
            seqIndex,
            renderReminder(renderGoalContinuation(asGoalTracker(tracker))),
          );
        }
        continue;
      }
      if (!isPlanReminderTracker(tracker)) continue;
      // MVP enter path: the coordinator is built only when a tracker-bearing
      // session mode is active this turn, so a tracker still `inactive` here
      // means the mode just became active — advance it to `pending` so the
      // pending case below activates it and injects the full/reentry reminder.
      // A tracker that just completed a deferred exit (armed exit notice) stays
      // out of plan mode until a fresh activation, so skip entering it.
      // (Single registered tracker today, so this is exactly the active one;
      // a multi-mode engine must scope this by the turn's active mode ids.)
      if (tracker.state() === 'inactive' && !tracker.hasPendingExitReminder()) {
        tracker.transition('enter');
      }
      const state = tracker.state();
      if (state === 'pending' && !tracker.hasPendingActivation()) {
        const reentry = tracker.isReentry();
        if (tracker.transition('activate')) {
          // Transition happened → persist so a restart resumes as active.
          void persistSnapshot(tracker, this.sessionId);
          this.pushReminder(
            messages,
            seqIndex,
            renderReminder(
              reentry
                ? reentryReminder(resolvePlanFilePath(this.sessionId))
                : fullReminder(resolvePlanFilePath(this.sessionId)),
            ),
          );
          tracker.recordReminderInjected();
        }
      } else if (state === 'active') {
        this.pushReminder(
          messages,
          seqIndex,
          renderReminder(
            tracker.shouldUseFullReminder()
              ? fullReminder(resolvePlanFilePath(this.sessionId))
              : sparseReminder(),
          ),
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
   * Feed token usage into the goal tracker's budget (plan 411 Phase 2).
   * When the goal has a budget and usage reaches it, transition to
   * `budget_limited` and persist. Called by DuyaAgent on each LLM
   * `result` event while a goal is active. No-op when no goal tracker
   * is registered or the goal has no budget.
   */
  async reportGoalTokenUsage(used: number): Promise<void> {
    for (const tracker of this.engine.list()) {
      if (!this.isActive(tracker)) continue;
      if (!isGoalReminderTracker(tracker)) continue;
      const goal = asGoalTracker(tracker);
      const over = goal.updateTokenUsage(used);
      if (over && goal.state() === 'active') {
        goal.transition({ type: 'budget_limit' });
        await persistSnapshot(tracker, this.sessionId);
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
      if (!this.isActive(tracker)) continue;
      if (isGoalReminderTracker(tracker)) {
        // Goal round-end: record the worker round while active and persist the
        // snapshot so a restart resumes the objective. Verification rounds are
        // counted by the tracker itself on verdicts; budget cut-off and
        // verifier-driven transitions land via the evaluator / tool wiring
        // (plan 411 Phase 2). This checkpoint keeps the snapshot durable.
        // Idle goals are skipped (no need to write a fresh idle snapshot).
        if (tracker.state() === 'active') {
          tracker.recordWorkerRound();
        }
        if (tracker.state() !== 'idle') {
          await persistSnapshot(tracker, this.sessionId);
        }
        continue;
      }
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
      if (!this.isActive(tracker)) continue;
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
    // Plan-only gating (goal's canGateTools is also true while active — must
    // not strip write tools from goal execution). Scoped to active plan tracker.
    const gated = this.engine
      .list()
      .some(
        (t) => this.isActive(t) && isPlanReminderTracker(t) && t.canGateTools(),
      );
    if (!gated) return tools;
    return tools.filter((t) => !GATED_WRITE_TOOLS.has(t.name));
  }

  /**
   * Plan-mode exact-path gating (grok `is_plan_file_write`). Invoked from the
   * per-tool permission checkpoint (`canUseTool`) so a write tool stays
   * callable while plan mode is active — but only when it targets the session
   * plan file. This is the runtime enforcement half of the plan-file contract;
   * the model reminder points at the same path (see `plan/reminders.ts`).
   *
   * Returns:
   *   - `'allow'` : the tool targets the plan file — skip the generic
   *                 permission flow (grok `should_auto_approve_edit`).
   *   - `'deny'`  : a gated write/execute tool not targeting the plan file.
   *   - `null`    : not gated by plan mode (let the normal permission flow
   *                 decide). Covers non-write tools and any turn where no
   *                 tracker is `canGateTools()`-active.
   */
  gateWriteTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    workingDirectory: string,
  ): 'allow' | 'deny' | null {
    // Plan-mode gating applies ONLY when the plan tracker (not a goal or any
    // other tracker) is active this turn. Goal mode's `canGateTools()` is also
    // true while active/verifying — gating on it would lock goal execution's
    // write tools to the plan file (grok `plan_mode_edit_gate` is plan-only).
    const planActive = this.engine
      .list()
      .some(
        (t) =>
          this.isActive(t) &&
          isPlanReminderTracker(t) &&
          t.canGateTools(),
      );
    if (!planActive) return null;

    const name = toolName.toLowerCase();
    if (!GATED_WRITE_TOOLS.has(name)) return null;

    // edit/write carry a file path; gate them by exact path match.
    if (name === 'edit' || name === 'write') {
      const filePath = toolInput?.file_path;
      if (typeof filePath !== 'string' || filePath.length === 0) return 'deny';
      const target = expandPath(filePath, workingDirectory);
      const planFile = resolvePlanFilePath(this.sessionId);
      return isPlanFileWrite(target, planFile) ? 'allow' : 'deny';
    }

    // bash/powershell/module cannot be path-gated — reject outright so plan
    // mode stays read-only outside the plan file.
    return 'deny';
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
      .filter((t) => this.isActive(t) && t.shouldInjectReminder())
      .map((t) => t.id);
  }

  /**
   * Restore each registered tracker from its persisted snapshot for this
   * session (plan 413c read path). Called once per streamChat, after the
   * coordinator is built and before any per-turn reminder injection, so a
   * restart resumes plan mode where it left off. Best-effort: restoreTracker
   * swallows DB/IPC failures and folds unstable states (`pending` /
   * `exit_pending`) to `inactive`, leaving the tracker initial on any miss.
   */
  async restore(): Promise<void> {
    for (const tracker of this.engine.list()) {
      if (!this.isActive(tracker)) continue;
      await restoreTracker(tracker, this.sessionId);
    }
  }

  /** The engine backing this coordinator (exposed for tests / wiring). */
  getEngine(): ModeTrackerEngine {
    return this.engine;
  }
}
