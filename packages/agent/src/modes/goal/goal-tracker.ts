/**
 * GoalTracker — 10-state goal mode state machine (plan 411 Phase 1,
 * session-aware + pause reasons + reply breaker per plan 552).
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
 *  - `no_progress_paused`: breaker fired — auto pause.
 *  - `infra_paused`     : turn-level infrastructure error — auto pause.
 *  - `blocked`          : verification verdict — cannot proceed without
 *                         user input.
 *  - `budget_limited`   : terminal — token budget exhausted.
 *  - `complete`         : terminal — verified achieved (or user-forced).
 *
 * Transitions are pure (no async I/O), idempotent, and return whether a
 * transition actually happened so the coordinator can decide whether to
 * persist. Snapshot restore folds the transient `verifying` and self-driving
 * `active` states to `user_paused` (grok safety model, tagged with the
 * `restart` pause reason) so a restart never silently resurrects an
 * unsupervised goal; the coordinator re-resumes it when `[goal]
 * auto_resume` is on (plan 552).
 *
 * Plan 552 additions:
 *  - `pauseReason` — closed `GOAL_PAUSE_REASONS` catalog carried by pause /
 *    stall / infra events, surfaced through snapshots and `goal_updated`
 *    events so the UI can show WHY a goal stopped (minimax statusReason).
 *  - `boundSession` — the tracker is a process singleton shared by every
 *    session in the worker; starting a goal records the owning session and
 *    every session-aware accessor/mutator treats a mismatched session as
 *    `idle` (no cross-session contamination).
 *  - reply fingerprint breaker — `recordReply` tracks consecutive
 *    identical final replies (normalized); the builtin PreFinalize hook
 *    maps the decision to a nudge veto or an automatic no-progress pause
 *    without ever running the verifier.
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

/**
 * Closed catalog of pause reasons (plan 552 — minimax `statusReason`
 * parity). Orthogonal to the coarse state: the state says the goal is not
 * running, the reason says WHY, and the UI renders it verbatim. `budget`
 * needs no reason (the `budget_limited` state already says it).
 */
export const GOAL_PAUSE_REASONS = [
  'user_requested',
  'blocked_worker',
  'no_progress',
  'no_progress_gaps',
  'verifier_timeout',
  'verifier_unavailable',
  'backoff',
  'infra',
  'restart',
] as const;

export type GoalPauseReason = (typeof GOAL_PAUSE_REASONS)[number];

const GOAL_PAUSE_REASON_SET = new Set<string>(GOAL_PAUSE_REASONS);

/** One lifecycle event entry in the goal history log (cap 64 entries). */
export interface GoalHistoryEntry {
  /** Epoch millis when the event happened. */
  at: number;
  /** Event label, e.g. `'start'`, `'report_completed'`, `'verdict:achieved'`. */
  event: string;
  /** Optional human-readable detail (pause message, objective, gaps…). */
  detail?: string;
  /** Structured pause reason, when the event is a pause-like transition. */
  reason?: string;
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
  /** Why the goal is currently paused (closed catalog). */
  pauseReason?: string;
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
  /** Owning session (plan 552). Undefined for legacy snapshots / CLI runs. */
  boundSession?: string;
  /** Normalized final-reply fingerprint of the last breaker observation. */
  replyFingerprint?: string | null;
  /** Consecutive identical-reply repeats AFTER the first (minimax semantics). */
  noProgressStreak: number;
}

/**
 * Events that drive goal transitions. `start`/`verdict` carry payloads;
 * pause-like events carry an optional structured `reason` from the
 * {@link GOAL_PAUSE_REASONS} catalog. `transition` is idempotent — illegal
 * or no-op events return false without throwing.
 */
export type GoalEvent =
  | { type: 'start'; objective: string; budget?: number }
  | { type: 'report_completed' }
  | { type: 'verdict'; verdict: 'achieved' | 'not_achieved' | 'blocked'; reason?: string }
  | { type: 'budget_limit' }
  | { type: 'stall'; reason?: string }
  | { type: 'infra_error'; reason?: string }
  | { type: 'pause'; message?: string; reason?: string }
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
  private goalPauseReason?: string;
  private goalGapsSummary?: string;
  private goalGapFingerprint?: string;
  private notAchievedStreak = 0;
  private classifierRuns = 0;
  private stallCount = 0;
  private strategistFiredAt?: number;
  private goalPlanFile?: string;
  private goalBaselineCommit?: string;
  private goalBoundSession?: string;
  private goalReplyFingerprint?: string | null;
  private goalNoProgressStreak = 0;

  /**
   * Session view guard (plan 552): `sessionId` callers only see the goal
   * when they own it. An unbound tracker (legacy snapshot / CLI run) is
   * visible to everyone; a caller WITHOUT a session id is allowed through
   * (tests, engine-internal calls) — every production call site passes the
   * session id explicitly.
   */
  private sees(sessionId?: string): boolean {
    if (!this.goalBoundSession) return true;
    if (sessionId === undefined) return true;
    return sessionId === this.goalBoundSession;
  }

  state(sessionId?: string): GoalState {
    return this.sees(sessionId) ? this.currentState : 'idle';
  }

  /** Phase — coarse stage orthogonal to state. */
  phase(sessionId?: string): GoalPhase {
    return this.sees(sessionId) ? this.currentPhase : 'idle';
  }

  /** The session that started the active goal, when known. */
  boundSession(): string | undefined {
    return this.goalBoundSession;
  }

  /** Runtime tool gating is live while the goal is active or verifying (plan 411 §4.4b). */
  canGateTools(sessionId?: string): boolean {
    const s = this.state(sessionId);
    return s === 'active' || s === 'verifying';
  }

  /** A per-round continuation reminder is due while active (or verifying, awaiting the next round). */
  shouldInjectReminder(sessionId?: string): boolean {
    const s = this.state(sessionId);
    return s === 'active' || s === 'verifying';
  }

  /**
   * Transition table (plan 411 §2.4). Returns whether the state actually
   * changed; illegal/no-op events return false without throwing. Every
   * real migration is logged so the state machine is observable.
   * Session-aware (plan 552): a session that does not own the goal is a
   * no-op.
   */
  transition(event: GoalEvent, sessionId?: string): boolean {
    if (!this.sees(sessionId)) return false;
    const before = this.currentState;
    const changed = this.applyTransition(event, sessionId);
    if (changed) {
      logger.info(`[Goal] state ${before} -> ${this.currentState}`, {
        event: event.type,
        objective: this.goalObjective || undefined,
        phase: this.currentPhase,
        reason: this.goalPauseReason,
        session: this.goalBoundSession,
      });
    }
    return changed;
  }

  private applyTransition(event: GoalEvent, sessionId?: string): boolean {
    switch (this.currentState) {
      case 'idle':
        if (event.type === 'start') {
          return this.start(event.objective, event.budget, sessionId);
        }
        return false;

      case 'active':
        switch (event.type) {
          case 'report_completed':
            return this.move('verifying', 'report_completed');
          case 'budget_limit':
            return this.move('budget_limited', 'budget_limit');
          case 'stall':
            return this.stallPause(event.reason);
          case 'infra_error':
            this.goalPauseReason = normalizeReason(event.reason) ?? 'infra';
            return this.move('infra_paused', 'infra_error');
          case 'pause':
            return this.pause(event.message, event.reason);
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
              this.goalPauseReason = normalizeReason(event.reason);
              this.move('blocked', 'verdict:blocked');
            }
            return true;
          case 'pause':
            return this.pause(event.message, event.reason);
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
            this.resetBreakersInternal();
            this.goalPauseReason = undefined;
            this.goalPauseMessage = undefined;
            return this.move('active', 'resume');
          case 'pause':
            // Already user_paused: idempotent no-op (message is refreshed
            // for convenience but no transition occurs).
            if (this.currentState === 'user_paused') {
              if (event.message) this.goalPauseMessage = event.message;
              if (event.reason) this.goalPauseReason = normalizeReason(event.reason);
              return false;
            }
            return this.pause(event.message, event.reason);
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
          this.resetBreakersInternal();
          this.goalPauseReason = undefined;
          this.goalPauseMessage = undefined;
          return this.move('active', 'resume');
        }
        if (event.type === 'clear') return this.clear();
        if (event.type === 'start') return this.start(event.objective, event.budget, sessionId);
        return false;

      case 'complete':
        // Terminal — `clear` or a fresh `start`.
        if (event.type === 'clear') return this.clear();
        if (event.type === 'start') return this.start(event.objective, event.budget, sessionId);
        return false;

      default:
        return false;
    }
  }

  snapshot(sessionId?: string): GoalSnapshot {
    if (!this.sees(sessionId)) {
      // A non-owning session snapshots the idle state — persisting it would
      // clobber the owner's row under that session's key, which is exactly
      // the isolation the binding exists for.
      return {
        state: 'idle',
        phase: 'idle',
        objective: '',
        tokenBudget: 0,
        tokenBaseline: 0,
        tokensUsedHighWater: 0,
        elapsedMs: 0,
        createdAt: 0,
        totalWorkerRounds: 0,
        totalVerifyRounds: 0,
        history: [],
        consecutiveNotAchieved: 0,
        classifierRunsAttempted: 0,
        classifierStallCount: 0,
        noProgressStreak: 0,
      };
    }
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
      pauseReason: this.goalPauseReason,
      gapsSummary: this.goalGapsSummary,
      gapFingerprint: this.goalGapFingerprint,
      consecutiveNotAchieved: this.notAchievedStreak,
      classifierRunsAttempted: this.classifierRuns,
      classifierStallCount: this.stallCount,
      lastStrategistFiredAt: this.strategistFiredAt,
      planFile: this.goalPlanFile,
      changesBaselineCommit: this.goalBaselineCommit,
      boundSession: this.goalBoundSession,
      replyFingerprint: this.goalReplyFingerprint ?? null,
      noProgressStreak: this.goalNoProgressStreak,
    };
  }

  /**
   * Restore from a snapshot with grok `from_snapshot` fold semantics.
   *
   * Safety model (grok goal_tracker.rs): a restart must NEVER silently
   * resurrect a self-driving goal. `Active` and the transient `verifying`
   * both fold to `user_paused` with the `restart` pause reason so the user
   * (or the coordinator, when `[goal] auto_resume` is on) explicitly
   * resumes after a crash. Other paused / blocked / terminal states restore
   * verbatim (they are durable decisions).
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
    // user/terminal decision and restores verbatim. The fold carries the
    // `restart` reason so the coordinator can auto-resume it (plan 552)
    // and the UI can say "paused after restart".
    const folded = state === 'active' || state === 'verifying' ? 'user_paused' : state;
    this.currentState = folded;
    this.currentPhase = this.currentState === 'idle' ? 'idle' : phase;
    if (folded !== state) {
      this.goalPauseReason = 'restart';
    }
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
    if (folded === state) this.goalPauseReason = strOr(raw.pauseReason);
    this.goalGapsSummary = strOr(raw.gapsSummary);
    this.goalGapFingerprint = strOr(raw.gapFingerprint);
    this.goalPlanFile = strOr(raw.planFile);
    this.goalBaselineCommit = strOr(raw.changesBaselineCommit);
    this.goalBoundSession = strOr(raw.boundSession);
    this.goalReplyFingerprint =
      raw.replyFingerprint === null || raw.replyFingerprint === undefined
        ? undefined
        : String(raw.replyFingerprint);
    this.goalNoProgressStreak = numberOr(raw.noProgressStreak, 0);
  }

  // ─── Read accessors (for the coordinator / update_goal tool) ───
  // All session-aware: a non-owning session reads the idle defaults.

  objective(sessionId?: string): string {
    return this.sees(sessionId) ? this.goalObjective : '';
  }

  tokenBudget(sessionId?: string): number {
    return this.sees(sessionId) ? this.goalTokenBudget : 0;
  }

  tokensUsedHighWater(sessionId?: string): number {
    return this.sees(sessionId) ? this.goalTokensHighWater : 0;
  }

  createdAt(sessionId?: string): number {
    return this.sees(sessionId) ? this.goalCreatedAt : 0;
  }

  totalWorkerRounds(sessionId?: string): number {
    return this.sees(sessionId) ? this.workerRounds : 0;
  }

  totalVerifyRounds(sessionId?: string): number {
    return this.sees(sessionId) ? this.verifyRounds : 0;
  }

  consecutiveNotAchieved(sessionId?: string): number {
    return this.sees(sessionId) ? this.notAchievedStreak : 0;
  }

  pauseMessage(sessionId?: string): string | undefined {
    return this.sees(sessionId) ? this.goalPauseMessage : undefined;
  }

  pauseReason(sessionId?: string): string | undefined {
    return this.sees(sessionId) ? this.goalPauseReason : undefined;
  }

  gapsSummary(sessionId?: string): string | undefined {
    return this.sees(sessionId) ? this.goalGapsSummary : undefined;
  }

  gapFingerprint(sessionId?: string): string | undefined {
    return this.sees(sessionId) ? this.goalGapFingerprint : undefined;
  }

  classifierRunsAttempted(sessionId?: string): number {
    return this.sees(sessionId) ? this.classifierRuns : 0;
  }

  classifierStallCount(sessionId?: string): number {
    return this.sees(sessionId) ? this.stallCount : 0;
  }

  lastStrategistFiredAt(sessionId?: string): number | undefined {
    return this.sees(sessionId) ? this.strategistFiredAt : undefined;
  }

  planFile(sessionId?: string): string | undefined {
    return this.sees(sessionId) ? this.goalPlanFile : undefined;
  }

  history(sessionId?: string): GoalHistoryEntry[] {
    return this.sees(sessionId) ? [...this.historyLog] : [];
  }

  // ─── Coordinator helpers (pure state updates, called by Phase 2+ wiring) ───

  /** Record a worker round; advances planning → executing on the first round. */
  recordWorkerRound(sessionId?: string): void {
    if (!this.sees(sessionId)) return;
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
  updateTokenUsage(used: number, sessionId?: string): boolean {
    if (!this.sees(sessionId)) return false;
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
  setGaps(summary: string, fingerprint?: string, sessionId?: string): number {
    if (!this.sees(sessionId)) return this.stallCount;
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

  /**
   * Reply fingerprint breaker (plan 552 — minimax `replyFingerprint`
   * parity). Feeds the turn-final assistant text; consecutive identical
   * normalized replies raise `noProgressStreak` (streak counts repeats
   * AFTER the first, so occurrences = streak + 1). Decision:
   *  - streak ≥ 2 (3rd identical reply) → `'pause'`
   *  - streak === 1 (2nd identical reply) → `'nudge'`
   *  - otherwise → `'none'`
   *
   * An empty reply never writes a fingerprint and never clears the streak
   * (an observation gap must not reset the breaker), mirroring minimax
   * `store-breaker.ts`.
   */
  recordReply(text: string, sessionId?: string): 'none' | 'nudge' | 'pause' {
    if (!this.sees(sessionId)) return 'none';
    const normalized = (text ?? '').trim().replace(/\s+/g, ' ').slice(0, 4000);
    if (!normalized) return 'none';
    if (this.goalReplyFingerprint && normalized === this.goalReplyFingerprint) {
      this.goalNoProgressStreak++;
    } else {
      this.goalNoProgressStreak = 0;
      this.goalReplyFingerprint = normalized;
    }
    if (this.goalNoProgressStreak >= 2) return 'pause';
    if (this.goalNoProgressStreak === 1) return 'nudge';
    return 'none';
  }

  /** Clear the reply breaker (fresh signal after a user decision / restart). */
  resetBreakers(sessionId?: string): void {
    if (!this.sees(sessionId)) return;
    this.resetBreakersInternal();
  }

  private resetBreakersInternal(): void {
    this.goalReplyFingerprint = undefined;
    this.goalNoProgressStreak = 0;
  }

  /** Mark a strategist run (throttled by `strategistEvery` in the evaluator). */
  recordStrategistFired(sessionId?: string): void {
    if (!this.sees(sessionId)) return;
    this.strategistFiredAt = Date.now();
  }

  /** Pin the plan file the goal is executing against. */
  setPlanFile(path: string, sessionId?: string): void {
    if (!this.sees(sessionId)) return;
    this.goalPlanFile = path;
  }

  /** Pin the git baseline commit captured at goal start (verification diff base). */
  setBaselineCommit(commit: string, sessionId?: string): void {
    if (!this.sees(sessionId)) return;
    this.goalBaselineCommit = commit;
  }

  // ─── Private transition helpers ───

  private start(objective: string, budget?: number, sessionId?: string): boolean {
    const trimmed = typeof objective === 'string' ? objective.trim() : '';
    if (!trimmed) return false;
    this.currentState = 'active';
    this.currentPhase = 'planning';
    // The starting session becomes the owner (plan 552). A sessionless
    // caller (CLI scratch / tests) leaves any previous binding untouched.
    if (sessionId) this.goalBoundSession = sessionId;
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
    this.goalPauseReason = undefined;
    this.goalGapsSummary = undefined;
    this.goalGapFingerprint = undefined;
    this.goalPlanFile = undefined;
    this.goalBaselineCommit = undefined;
    this.resetBreakersInternal();
    this.pushHistory('start', trimmed);
    return true;
  }

  /** Enter `user_paused`, recording the human-readable reason. */
  private pause(message?: string, reason?: string): boolean {
    if (this.currentState === 'user_paused') return false;
    this.currentState = 'user_paused';
    this.goalPauseMessage = typeof message === 'string' ? message : undefined;
    this.goalPauseReason = normalizeReason(reason) ?? 'user_requested';
    this.pushHistory('pause', this.goalPauseMessage, this.goalPauseReason);
    return true;
  }

  /** Enter `no_progress_paused` (breaker / stall), tagging the reason. */
  private stallPause(reason?: string): boolean {
    this.goalPauseReason = normalizeReason(reason) ?? 'no_progress_gaps';
    return this.move('no_progress_paused', 'stall');
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
    this.goalPauseReason = undefined;
    this.goalGapsSummary = undefined;
    this.goalGapFingerprint = undefined;
    this.goalPlanFile = undefined;
    this.goalBaselineCommit = undefined;
    this.goalBoundSession = undefined;
    this.resetBreakersInternal();
    this.historyLog = [];
    return true;
  }

  /** Shared state-change bookkeeping: set state + append a history entry. */
  private move(next: GoalState, eventLabel: string): boolean {
    if (next === this.currentState) return false;
    this.currentState = next;
    this.pushHistory(eventLabel, undefined, this.goalPauseReason);
    return true;
  }

  private pushHistory(event: string, detail?: string, reason?: string): void {
    this.historyLog.push({ at: Date.now(), event, detail, ...(reason ? { reason } : {}) });
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

/** Keep only reasons from the closed catalog; anything else degrades to undefined. */
function normalizeReason(reason?: string): GoalPauseReason | undefined {
  if (typeof reason === 'string' && GOAL_PAUSE_REASON_SET.has(reason)) {
    return reason as GoalPauseReason;
  }
  return undefined;
}
