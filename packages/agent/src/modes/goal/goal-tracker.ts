/**
 * GoalTracker — 10-state goal mode state machine (plan 411 Phase 1).
 *
 * A TypeScript port of grok's `GoalTracker` (`goal_tracker.rs`), adapted
 * to duya's ModeTracker contract (plan 413). It is the single
 * deterministic source of truth for goal-mode lifecycle state:
 *
 *   idle → active ⇄ verifying → complete | blocked
 *    ↕        ↘ budget_limited / backoff / no_progress / infra paused
 *
 *  - `idle`             : no goal (静止态).
 *  - `active`           : worker rounds are running toward the objective.
 *  - `verifying`        : the model self-reported completion; the harness
 *                         independently verifies it (Phase 2 evaluator).
 *  - `user_paused`      : explicit user pause.
 *  - `backoff_paused`   : cap/rate-limit hit — automatic pause.
 *  - `no_progress_paused`: gap fingerprint shows no progress — auto pause.
 *  - `infra_paused`     : turn-level infrastructure error — auto pause.
 *  - `blocked`          : verification verdict — cannot proceed without
 *                         user input.
 *  - `budget_limited`   : terminal — token budget exhausted.
 *  - `complete`         : terminal — verified achieved (or user-forced).
 *
 * Transitions are pure (no async I/O), idempotent, and return whether a
 * transition actually happened so the coordinator can decide whether to
 * persist. Snapshot restore folds the transient `verifying` and self-driving
 * `active` states to `user_paused` (grok safety model) so a restart never
 * resurrects an unsupervised goal.
 */

import type { ModeTracker } from '../engine/tracker.js';
import { logger } from '../../utils/logger.js';

/** Goal lifecycle state (10 states, aligned with grok `goal_tracker.rs`). */
export type GoalState =
  | 'idle'
  | 'active'
  | 'verifying'
  | 'user_paused'
  | 'backoff_paused'
  | 'no_progress_paused'
  | 'infra_paused'
  | 'blocked'
  | 'budget_limited'
  | 'complete';

/** Coarse-grained stage, orthogonal to state (Idle / Planning / Executing). */
export type GoalPhase = 'idle' | 'planning' | 'executing';

/** One lifecycle event entry in the goal history log (cap 64 entries). */
export interface GoalHistoryEntry {
  /** Epoch millis when the event happened. */
  at: number;
  /** Event label, e.g. `'start'`, `'report_completed'`, `'verdict:achieved'`. */
  event: string;
  /** Optional human-readable detail (pause message, objective, gaps…). */
  detail?: string;
}

/**
 * Persisted snapshot shape (plan 411 §4.4b, mirroring grok
 * `GoalOrchestration`). Carries the full goal payload so the goal can
 * resume across restarts via plan 413c `mode_state_snapshots`.
 */
export interface GoalSnapshot {
  state: GoalState;
  phase: GoalPhase;
  objective: string;
  tokenBudget: number;
  tokenBaseline: number;
  tokensUsedHighWater: number;
  /** Computed at snapshot time (`Date.now() - createdAt`). */
  elapsedMs: number;
  createdAt: number;
  totalWorkerRounds: number;
  totalVerifyRounds: number;
  /** Lifecycle log, capped at 64 entries. */
  history: GoalHistoryEntry[];
  pauseMessage?: string;
  gapsSummary?: string;
  gapFingerprint?: string;
  consecutiveNotAchieved: number;
  /** Total verification runs attempted (plan 411 §2.3). */
  classifierRunsAttempted: number;
  /** Consecutive verifier rounds whose gap fingerprint did not change (stall detection). */
  classifierStallCount: number;
  /** Epoch millis of the last strategist run (throttles strategy reconstruction). */
  lastStrategistFiredAt?: number;
  planFile?: string;
  changesBaselineCommit?: string;
}

/**
 * Events that drive goal transitions. `start`/`verdict` carry payloads;
 * the rest are plain signals. `transition` is idempotent — illegal or
 * no-op events return false without throwing.
 */
export type GoalEvent =
  | { type: 'start'; objective: string; budget?: number }
  | { type: 'report_completed' }
  | { type: 'verdict'; verdict: 'achieved' | 'not_achieved' | 'blocked' }
  | { type: 'budget_limit' }
  | { type: 'stall' }
  | { type: 'infra_error' }
  | { type: 'pause'; message?: string }
  | { type: 'resume'; budget?: number }
  | { type: 'complete' }
  | { type: 'clear' };

const GOAL_STATES = new Set<GoalState>([
  'idle',
  'active',
  'verifying',
  'user_paused',
  'backoff_paused',
  'no_progress_paused',
  'infra_paused',
  'blocked',
  'budget_limited',
  'complete',
]);

const GOAL_PHASES = new Set<GoalPhase>(['idle', 'planning', 'executing']);

/** History log cap (grok: `MAX_HISTORY_ENTRIES = 64`). */
export const GOAL_HISTORY_CAP = 64;

/** All pause-like states that can `resume` back to `active`. */
const PAUSED_STATES = new Set<GoalState>([
  'user_paused',
  'backoff_paused',
  'no_progress_paused',
  'infra_paused',
  'blocked',
]);

export class GoalTracker implements ModeTracker<GoalState, GoalEvent, GoalSnapshot> {
  readonly id = 'goal';

  // Named `currentState` (not `state`) so the field does not shadow the
  // public `state()` method — same convention as PlanModeTracker.
  private currentState: GoalState = 'idle';
  private currentPhase: GoalPhase = 'idle';
  private goalObjective = '';
  private goalTokenBudget = 0;
  private goalTokenBaseline = 0;
  private goalTokensHighWater = 0;
  private goalCreatedAt = 0;
  private workerRounds = 0;
  private verifyRounds = 0;
  private historyLog: GoalHistoryEntry[] = [];
  private goalPauseMessage?: string;
  private goalGapsSummary?: string;
  private goalGapFingerprint?: string;
  private notAchievedStreak = 0;
  private classifierRuns = 0;
  private stallCount = 0;
  private strategistFiredAt?: number;
  private goalPlanFile?: string;
  private goalBaselineCommit?: string;

  state(): GoalState {
    return this.currentState;
  }

  /** Phase — coarse stage orthogonal to state. */
  phase(): GoalPhase {
    return this.currentPhase;
  }

  /** Runtime tool gating is live while the goal is active or verifying (plan 411 §4.4b). */
  canGateTools(): boolean {
    return this.currentState === 'active' || this.currentState === 'verifying';
  }

  /** A per-round continuation reminder is due while active (or verifying, awaiting the next round). */
  shouldInjectReminder(): boolean {
    return this.currentState === 'active' || this.currentState === 'verifying';
  }

  /**
   * Transition table (plan 411 §2.4). Returns whether the state actually
   * changed; illegal/no-op events return false without throwing. Every
   * real migration is logged so the state machine is observable.
   */
  transition(event: GoalEvent): boolean {
    const before = this.currentState;
    const changed = this.applyTransition(event);
    if (changed) {
      logger.info(`[Goal] state ${before} -> ${this.currentState}`, {
        event: event.type,
        objective: this.goalObjective || undefined,
        phase: this.currentPhase,
      });
    }
    return changed;
  }

  private applyTransition(event: GoalEvent): boolean {
    switch (this.currentState) {
      case 'idle':
        if (event.type === 'start') {
          return this.start(event.objective, event.budget);
        }
        return false;

      case 'active':
        switch (event.type) {
          case 'report_completed':
            return this.move('verifying', 'report_completed');
          case 'budget_limit':
            return this.move('budget_limited', 'budget_limit');
          case 'stall':
            return this.move('no_progress_paused', 'stall');
          case 'infra_error':
            return this.move('infra_paused', 'infra_error');
          case 'pause':
            return this.pause(event.message);
          case 'complete':
            return this.move('complete', 'complete');
          case 'clear':
            return this.clear();
          default:
            // resume (already active), verdict (only from verifying)
            return false;
        }

      case 'verifying':
        switch (event.type) {
          case 'verdict':
            if (event.verdict === 'achieved') {
              this.recordVerifyRound();
              this.move('complete', 'verdict:achieved');
            } else if (event.verdict === 'not_achieved') {
              this.recordVerifyRound();
              this.notAchievedStreak++;
              this.move('active', 'verdict:not_achieved');
            } else {
              this.recordVerifyRound();
              this.move('blocked', 'verdict:blocked');
            }
            return true;
          case 'pause':
            return this.pause(event.message);
          case 'complete':
            return this.move('complete', 'complete');
          case 'clear':
            return this.clear();
          default:
            // report_completed while already verifying, resume, start, etc.
            return false;
        }

      case 'user_paused':
      case 'backoff_paused':
      case 'no_progress_paused':
      case 'infra_paused':
      case 'blocked':
        switch (event.type) {
          case 'resume':
            // Phase 4 polish: resuming from an automatic pause (stall / backoff /
            // infra) or a user pause restarts the stall detector — the user's
            // decision to continue is a fresh signal, so a resumed goal does not
            // immediately re-pause on the same fingerprint. Budget carried over
            // unchanged; `budget_limited` resume (below) can raise it.
            this.stallCount = 0;
            return this.move('active', 'resume');
          case 'pause':
            // Already user_paused: idempotent no-op (message is refreshed
            // for convenience but no transition occurs).
            if (this.currentState === 'user_paused') {
              if (event.message) this.goalPauseMessage = event.message;
              return false;
            }
            return this.pause(event.message);
          case 'complete':
            return this.move('complete', 'complete');
          case 'clear':
            return this.clear();
          default:
            return false;
        }

      case 'budget_limited':
        // Terminal by default — but the user may raise the budget and resume
        // (Phase 4 polish). `resume` with a new budget updates the cap first so
        // the goal does not immediately re-trip the same exhausted budget.
        if (event.type === 'resume') {
          if (typeof event.budget === 'number' && event.budget > 0) {
            this.goalTokenBudget = event.budget;
          }
          // If the budget was not raised, the coordinator will re-trip on the
          // next usage report — that is the correct defense; the user must
          // actually raise the budget to continue burning tokens.
          this.stallCount = 0;
          return this.move('active', 'resume');
        }
        if (event.type === 'clear') return this.clear();
        if (event.type === 'start') return this.start(event.objective, event.budget);
        return false;

      case 'complete':
        // Terminal — `clear` or a fresh `start`.
        if (event.type === 'clear') return this.clear();
        if (event.type === 'start') return this.start(event.objective, event.budget);
        return false;

      default:
        return false;
    }
  }

  snapshot(): GoalSnapshot {
    return {
      state: this.currentState,
      phase: this.currentPhase,
      objective: this.goalObjective,
      tokenBudget: this.goalTokenBudget,
      tokenBaseline: this.goalTokenBaseline,
      tokensUsedHighWater: this.goalTokensHighWater,
      elapsedMs: this.goalCreatedAt > 0 ? Math.max(0, Date.now() - this.goalCreatedAt) : 0,
      createdAt: this.goalCreatedAt,
      totalWorkerRounds: this.workerRounds,
      totalVerifyRounds: this.verifyRounds,
      history: [...this.historyLog],
      pauseMessage: this.goalPauseMessage,
      gapsSummary: this.goalGapsSummary,
      gapFingerprint: this.goalGapFingerprint,
      consecutiveNotAchieved: this.notAchievedStreak,
      classifierRunsAttempted: this.classifierRuns,
      classifierStallCount: this.stallCount,
      lastStrategistFiredAt: this.strategistFiredAt,
      planFile: this.goalPlanFile,
      changesBaselineCommit: this.goalBaselineCommit,
    };
  }

  /**
   * Restore from a snapshot with grok `from_snapshot` fold semantics.
   *
   * Safety model (grok goal_tracker.rs): a restart must NEVER resurrect a
   * self-driving goal. `Active` and the transient `verifying` both fold to
   * `user_paused` so the user explicitly resumes after a crash — the goal
   * never auto-continues burning tokens unsupervised. Other paused / blocked
   * / terminal states restore verbatim (they are durable decisions).
   *
   * Same-process guard: `coordinator.restore()` runs at the START of every
   * streamChat call, but this tracker is a process singleton whose in-memory
   * state is authoritative across messages within one process. Restoring
   * only applies on a cold start (current state still `idle`); otherwise the
   * existing in-memory state is kept untouched so a mid-process restart of
   * the coordinator cannot clobber a live goal.
   *
   * Invalid snapshots throw so the persistence layer reports failure.
   */
  restore(raw: GoalSnapshot): void {
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof (raw as { state?: unknown }).state !== 'string' ||
      !GOAL_STATES.has((raw as GoalSnapshot).state)
    ) {
      throw new Error(`invalid GoalSnapshot: ${JSON.stringify(raw)}`);
    }
    // Same-process guard: the singleton already holds live state (a
    // cross-message continuation), so a persisted snapshot is stale — do
    // not clobber it. Only a cold start (state still idle) applies folds.
    if (this.currentState !== 'idle') {
      return;
    }
    const state = raw.state as GoalState;
    const phase = raw.phase;
    if (typeof phase !== 'string' || !GOAL_PHASES.has(phase as GoalPhase)) {
      throw new Error(`invalid GoalSnapshot phase: ${JSON.stringify(raw.phase)}`);
    }
    // Fold self-driving / in-flight states to a resumable pause (grok
    // from_snapshot): a restart cannot resume an in-flight verification
    // panel or an unsupervised active goal. Everything else is a durable
    // user/terminal decision and restores verbatim.
    const folded =
      state === 'active' || state === 'verifying' ? 'user_paused' : state;
    this.currentState = folded;
    this.currentPhase = this.currentState === 'idle' ? 'idle' : phase;
    this.goalObjective = typeof raw.objective === 'string' ? raw.objective : '';
    this.goalTokenBudget = numberOr(raw.tokenBudget, 0);
    this.goalTokenBaseline = numberOr(raw.tokenBaseline, 0);
    this.goalTokensHighWater = numberOr(raw.tokensUsedHighWater, 0);
    this.goalCreatedAt = numberOr(raw.createdAt, 0);
    this.workerRounds = numberOr(raw.totalWorkerRounds, 0);
    this.verifyRounds = numberOr(raw.totalVerifyRounds, 0);
    this.notAchievedStreak = numberOr(raw.consecutiveNotAchieved, 0);
    this.classifierRuns = numberOr(raw.classifierRunsAttempted, 0);
    this.stallCount = numberOr(raw.classifierStallCount, 0);
    this.strategistFiredAt = numberOr(raw.lastStrategistFiredAt, 0) || undefined;
    this.historyLog = Array.isArray(raw.history)
      ? raw.history.slice(-GOAL_HISTORY_CAP)
      : [];
    this.goalPauseMessage = strOr(raw.pauseMessage);
    this.goalGapsSummary = strOr(raw.gapsSummary);
    this.goalGapFingerprint = strOr(raw.gapFingerprint);
    this.goalPlanFile = strOr(raw.planFile);
    this.goalBaselineCommit = strOr(raw.changesBaselineCommit);
  }

  // ─── Read accessors (for the coordinator / update_goal tool) ───

  objective(): string {
    return this.goalObjective;
  }

  tokenBudget(): number {
    return this.goalTokenBudget;
  }

  tokensUsedHighWater(): number {
    return this.goalTokensHighWater;
  }

  createdAt(): number {
    return this.goalCreatedAt;
  }

  totalWorkerRounds(): number {
    return this.workerRounds;
  }

  totalVerifyRounds(): number {
    return this.verifyRounds;
  }

  consecutiveNotAchieved(): number {
    return this.notAchievedStreak;
  }

  pauseMessage(): string | undefined {
    return this.goalPauseMessage;
  }

  gapsSummary(): string | undefined {
    return this.goalGapsSummary;
  }

  gapFingerprint(): string | undefined {
    return this.goalGapFingerprint;
  }

  classifierRunsAttempted(): number {
    return this.classifierRuns;
  }

  classifierStallCount(): number {
    return this.stallCount;
  }

  lastStrategistFiredAt(): number | undefined {
    return this.strategistFiredAt;
  }

  planFile(): string | undefined {
    return this.goalPlanFile;
  }

  history(): GoalHistoryEntry[] {
    return [...this.historyLog];
  }

  // ─── Coordinator helpers (pure state updates, called by Phase 2+ wiring) ───

  /** Record a worker round; advances planning → executing on the first round. */
  recordWorkerRound(): void {
    this.workerRounds++;
    if (this.currentPhase === 'planning') {
      this.currentPhase = 'executing';
    }
  }

  /** Record a verification round (Phase 2 evaluator calls this per verdict). */
  recordVerifyRound(): void {
    this.verifyRounds++;
  }

  /** Update the token high-water mark. Returns true when over budget. */
  updateTokenUsage(used: number): boolean {
    if (used > this.goalTokensHighWater) {
      this.goalTokensHighWater = used;
    }
    return this.goalTokenBudget > 0 && this.goalTokensHighWater >= this.goalTokenBudget;
  }

  /** Record verifier gaps (Phase 2: `not_achieved` verdict output).
   *
   * Phase 3 stall detection: when the new gap fingerprint equals the
   * previous one, increment the stall counter (the same gaps keep
   * coming back → likely whack-a-mole). A changed fingerprint resets
   * the stall counter. Returns the updated stall count.
   */
  setGaps(summary: string, fingerprint?: string): number {
    this.classifierRuns++;
    this.goalGapsSummary = summary;
    if (fingerprint !== undefined) {
      if (this.goalGapFingerprint === fingerprint) {
        this.stallCount++;
      } else {
        this.stallCount = 0;
      }
      this.goalGapFingerprint = fingerprint;
    }
    return this.stallCount;
  }

  /** Mark a strategist run (throttled by `strategistEvery` in the evaluator). */
  recordStrategistFired(): void {
    this.strategistFiredAt = Date.now();
  }

  /** Pin the plan file the goal is executing against. */
  setPlanFile(path: string): void {
    this.goalPlanFile = path;
  }

  /** Pin the git baseline commit captured at goal start (verification diff base). */
  setBaselineCommit(commit: string): void {
    this.goalBaselineCommit = commit;
  }

  // ─── Private transition helpers ───

  private start(objective: string, budget?: number): boolean {
    const trimmed = typeof objective === 'string' ? objective.trim() : '';
    if (!trimmed) return false;
    this.currentState = 'active';
    this.currentPhase = 'planning';
    this.goalObjective = trimmed;
    this.goalTokenBudget = typeof budget === 'number' && budget > 0 ? budget : 0;
    this.goalTokenBaseline = 0;
    this.goalTokensHighWater = 0;
    this.goalCreatedAt = Date.now();
    this.workerRounds = 0;
    this.verifyRounds = 0;
    this.notAchievedStreak = 0;
    this.classifierRuns = 0;
    this.stallCount = 0;
    this.strategistFiredAt = undefined;
    this.goalPauseMessage = undefined;
    this.goalGapsSummary = undefined;
    this.goalGapFingerprint = undefined;
    this.goalPlanFile = undefined;
    this.goalBaselineCommit = undefined;
    this.pushHistory('start', trimmed);
    return true;
  }

  /** Enter `user_paused`, recording the human-readable reason. */
  private pause(message?: string): boolean {
    if (this.currentState === 'user_paused') return false;
    this.currentState = 'user_paused';
    this.goalPauseMessage = typeof message === 'string' ? message : undefined;
    this.pushHistory('pause', message);
    return true;
  }

  private clear(): boolean {
    if (this.currentState === 'idle') return false;
    this.currentState = 'idle';
    this.currentPhase = 'idle';
    this.goalObjective = '';
    this.goalTokenBudget = 0;
    this.goalTokenBaseline = 0;
    this.goalTokensHighWater = 0;
    this.goalCreatedAt = 0;
    this.workerRounds = 0;
    this.verifyRounds = 0;
    this.notAchievedStreak = 0;
    this.classifierRuns = 0;
    this.stallCount = 0;
    this.strategistFiredAt = undefined;
    this.goalPauseMessage = undefined;
    this.goalGapsSummary = undefined;
    this.goalGapFingerprint = undefined;
    this.goalPlanFile = undefined;
    this.goalBaselineCommit = undefined;
    this.historyLog = [];
    return true;
  }

  /** Shared state-change bookkeeping: set state + append a history entry. */
  private move(next: GoalState, eventLabel: string): boolean {
    if (next === this.currentState) return false;
    this.currentState = next;
    this.pushHistory(eventLabel);
    return true;
  }

  private pushHistory(event: string, detail?: string): void {
    this.historyLog.push({ at: Date.now(), event, detail });
    if (this.historyLog.length > GOAL_HISTORY_CAP) {
      this.historyLog.splice(0, this.historyLog.length - GOAL_HISTORY_CAP);
    }
  }
}

/** Sentinel singleton — registered against the mode engine in `modes/index.ts`. */
export const goalModeTracker = new GoalTracker();

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function strOr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
