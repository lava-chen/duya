/**
 * ResearchTracker — 9-state deep research mode state machine (plan 423 Phase 1).
 *
 * A TypeScript port aligned to duya's ModeTracker contract (plan 413), mirroring
 * the GoalTracker (plan 411) / PlanModeTracker (plan 413b) patterns. It is the
 * single deterministic source of truth for deep-research lifecycle state:
 *
 *   idle ──start──> clarifying ──plan──> planning ──search──> gathering
 *     │              │                    │                    │
 *     │              │                    └── auto-fast-track ──┘
 *     │              └─────────────── ask_user ──> awaiting_input ──user_input──> 回原阶段
 *     │                                                               │
 *     │                                                        block ──> blocked
 *     │
 *     └── clearing 任意态 ──> idle
 *
 *   gathering ⇄ evaluating（迭代补坑）──synthesize──> synthesizing ──report_done──> complete
 *
 *  - `clarifying`      : disambiguate scope/depth/success criteria.
 *  - `planning`        : break the query into sub-questions + search strategy.
 *  - `gathering`       : search & fetch (the long loop).
 *  - `evaluating`      : source evaluation + coverage-gap check.
 *  - `synthesizing`    : writing the research report.
 *  - `awaiting_input`  : temporary pause waiting for a user answer.
 *  - `blocked`         : cannot proceed without a user decision.
 *  - `complete`        : terminal — report produced.
 *
 * Transitions are pure (no async I/O), idempotent, and return whether a
 * transition actually happened so the coordinator can decide whether to
 * persist. Snapshot restore folds transient workflow states
 * (clarifying/planning/gathering/evaluating/synthesizing) to `awaiting_input`
 * so a restart never resurrects an unsupervised half-open research run.
 */

import type { ModeTracker } from '../engine/tracker.js';
import { logger } from '../../utils/logger.js';

/** Research lifecycle state (9 states). */
export type ResearchState =
  | 'idle'
  | 'clarifying'
  | 'planning'
  | 'gathering'
  | 'evaluating'
  | 'synthesizing'
  | 'awaiting_input'
  | 'blocked'
  | 'complete';

/** Coarse-grained stage, orthogonal to state (Idle / Active / Reporting). */
export type ResearchPhase = 'idle' | 'active' | 'reporting';

/** One lifecycle event entry in the research history log (cap 64 entries). */
export interface ResearchHistoryEntry {
  /** Epoch millis when the event happened. */
  at: number;
  /** Event label, e.g. `'start'`, `'search'`, `'report_done'`. */
  event: string;
  /** Optional human-readable detail (query, source, gap…). */
  detail?: string;
}

/**
 * Persisted snapshot shape. Carries the full research payload so a run can
 * resume across restarts via plan 413c `mode_state_snapshots`.
 */
export interface ResearchSnapshot {
  state: ResearchState;
  phase: ResearchPhase;
  query: string;
  /** Sub-questions produced during planning. */
  subQuestions: string[];
  /** Sources gathered so far (titles / urls). */
  sourcesGathered: string[];
  /** Coverage gaps surfaced by evaluating. */
  coverageGaps: string[];
  /** Lifecycle log, capped at 64 entries. */
  history: ResearchHistoryEntry[];
  createdAt: number;
  /** Computed at snapshot time (`Date.now() - createdAt`). */
  elapsedMs: number;
  /** Iteration rounds gathered⇄evaluated. */
  rounds: number;
  /** Consecutive evaluate rounds without a coverage-gap change (stall counter). */
  stallRounds: number;
  /** Coverage-gap signature at the last evaluate round (for stall detection). */
  lastCoverageSignature: string;
  /** State to return to after `awaiting_input` / `blocked` is resolved. */
  returnToState?: ResearchState;
}

/** Events that drive research transitions. `transition` is idempotent. */
export type ResearchEvent =
  | { type: 'start'; query: string }
  | { type: 'clarify' }
  | { type: 'plan' }
  | { type: 'search' }
  | { type: 'evaluate' }
  | { type: 'continue' }
  | { type: 'synthesize' }
  | { type: 'report_done' }
  | { type: 'ask_user' }
  | { type: 'user_input' }
  | { type: 'block' }
  | { type: 'clear' };

const RESEARCH_STATES = new Set<ResearchState>([
  'idle',
  'clarifying',
  'planning',
  'gathering',
  'evaluating',
  'synthesizing',
  'awaiting_input',
  'blocked',
  'complete',
]);

const RESEARCH_PHASES = new Set<ResearchPhase>(['idle', 'active', 'reporting']);

/** History log cap. */
export const RESEARCH_HISTORY_CAP = 64;

/**
 * Default stall threshold: auto-converge after this many consecutive
 * evaluate rounds that did not change the coverage gaps. Configurable via
 * `[research] max_converge_rounds` (see research-config.ts).
 */
export const RESEARCH_DEFAULT_CONVERGE_ROUNDS = 3;

/** The five active workflow states that drive runtime tool gating. */
const WORKFLOW_STATES = new Set<ResearchState>([
  'clarifying',
  'planning',
  'gathering',
  'evaluating',
  'synthesizing',
]);

/**
 * Tool-gate category for the current state, consumed by the coordinator's
 * `filterTools` research branch (plan 423). Kept on the tracker so the pure
 * state machine owns the mapping and stays unit-testable.
 */
export type ResearchGate = 'idle' | 'readonly' | 'gathering' | 'waiting' | 'complete';

export class ResearchTracker
  implements ModeTracker<ResearchState, ResearchEvent, ResearchSnapshot>
{
  readonly id = 'research';

  // Named `currentState` (not `state`) so the field does not shadow the
  // public `state()` method — same convention as GoalTracker/PlanModeTracker.
  private currentState: ResearchState = 'idle';
  private currentPhase: ResearchPhase = 'idle';
  private researchQuery = '';
  private researchSubQuestions: string[] = [];
  private researchSources: string[] = [];
  private researchGaps: string[] = [];
  private researchHistory: ResearchHistoryEntry[] = [];
  private researchCreatedAt = 0;
  private researchRounds = 0;
  private researchStallRounds = 0;
  private lastCoverageSig = '';
  private returnTo: ResearchState | undefined;

  state(): ResearchState {
    return this.currentState;
  }

  /** Phase — coarse stage orthogonal to state. */
  phase(): ResearchPhase {
    return this.currentPhase;
  }

  /** Runtime tool gating is live while in an active workflow state. */
  canGateTools(): boolean {
    return WORKFLOW_STATES.has(this.currentState);
  }

  /** A per-round continuation reminder is due while in an active workflow state. */
  shouldInjectReminder(): boolean {
    return WORKFLOW_STATES.has(this.currentState);
  }

  /** Tool-gate category for the coordinator's filterTools research branch. */
  researchGate(): ResearchGate {
    switch (this.currentState) {
      case 'gathering':
        return 'gathering';
      case 'awaiting_input':
      case 'blocked':
        return 'waiting';
      case 'complete':
        return 'complete';
      case 'idle':
        return 'idle';
      default:
        // clarifying / planning / evaluating / synthesizing
        return 'readonly';
    }
  }

  /**
   * Transition table. Returns whether the state actually changed; illegal /
   * no-op events return false without throwing. Every real migration is
   * logged so the state machine is observable.
   */
  transition(event: ResearchEvent): boolean {
    const before = this.currentState;
    const changed = this.applyTransition(event);
    if (changed) {
      logger.info(`[Research] state ${before} -> ${this.currentState}`, {
        event: event.type,
        query: this.researchQuery || undefined,
        phase: this.currentPhase,
      });
    }
    return changed;
  }

  private applyTransition(event: ResearchEvent): boolean {
    switch (this.currentState) {
      case 'idle':
        if (event.type === 'start') {
          return this.start(event.query);
        }
        return false;

      case 'clarifying':
        return this.workflowOrPause(event, ['plan', 'search']);

      case 'planning':
        return this.workflowOrPause(event, ['search']);

      case 'gathering':
        switch (event.type) {
          case 'evaluate':
            return this.move('evaluating', 'evaluate');
          case 'synthesize':
            // Fast-track: a simple query may skip the evaluate loop.
            return this.toSynthesizing();
          case 'ask_user':
          case 'block':
          case 'clear':
            return this.pauseOrClear(event);
          default:
            return false;
        }

      case 'evaluating':
        switch (event.type) {
          case 'continue':
            // Gaps remain — back to gathering for another round.
            this.researchRounds++;
            return this.move('gathering', 'continue');
          case 'synthesize':
            return this.toSynthesizing();
          case 'ask_user':
          case 'block':
          case 'clear':
            return this.pauseOrClear(event);
          default:
            return false;
        }

      case 'synthesizing':
        switch (event.type) {
          case 'report_done':
            this.currentPhase = 'reporting';
            return this.move('complete', 'report_done');
          case 'ask_user':
          case 'block':
          case 'clear':
            return this.pauseOrClear(event);
          default:
            return false;
        }

      case 'awaiting_input':
      case 'blocked':
        if (event.type === 'user_input') {
          return this.resumeFromPause();
        }
        if (event.type === 'clear') {
          return this.clear();
        }
        return false;

      case 'complete':
        // Terminal — `clear` or a fresh `start`.
        if (event.type === 'clear') return this.clear();
        if (event.type === 'start') return this.start(event.query);
        return false;

      default:
        return false;
    }
  }

  /**
   * Shared handler for the forward-only workflow states (clarifying /
   * planning), which advance via a closed set of next events and may also
   * divert to a pause state.
   */
  private workflowOrPause(
    event: ResearchEvent,
    advanceOn: ResearchEvent['type'][],
  ): boolean {
    if (advanceOn.includes(event.type)) {
      const next: ResearchState =
        event.type === 'plan' ? 'planning' : event.type === 'search' ? 'gathering' : this.currentState;
      return this.move(next, event.type);
    }
    if (event.type === 'synthesize') {
      // Fast-track: skip remaining forward steps straight to reporting.
      return this.toSynthesizing();
    }
    if (event.type === 'ask_user' || event.type === 'block' || event.type === 'clear') {
      return this.pauseOrClear(event);
    }
    return false;
  }

  private toSynthesizing(): boolean {
    this.currentPhase = 'reporting';
    return this.move('synthesizing', 'synthesize');
  }

  private pauseOrClear(event: ResearchEvent): boolean {
    if (event.type === 'clear') return this.clear();
    if (event.type === 'ask_user' || event.type === 'block') {
      this.returnTo = this.currentState;
      const next: ResearchState = event.type === 'ask_user' ? 'awaiting_input' : 'blocked';
      return this.move(next, event.type);
    }
    return false;
  }

  private resumeFromPause(): boolean {
    const target = this.returnTo ?? 'gathering';
    this.returnTo = undefined;
    if (target === 'synthesizing' || target === 'complete') {
      this.currentPhase = 'reporting';
    } else if (target !== 'idle') {
      this.currentPhase = 'active';
    }
    return this.move(target, 'user_input');
  }

  snapshot(): ResearchSnapshot {
    return {
      state: this.currentState,
      phase: this.currentPhase,
      query: this.researchQuery,
      subQuestions: [...this.researchSubQuestions],
      sourcesGathered: [...this.researchSources],
      coverageGaps: [...this.researchGaps],
      history: [...this.researchHistory],
      createdAt: this.researchCreatedAt,
      elapsedMs: this.researchCreatedAt > 0 ? Math.max(0, Date.now() - this.researchCreatedAt) : 0,
      rounds: this.researchRounds,
      stallRounds: this.researchStallRounds,
      lastCoverageSignature: this.lastCoverageSig,
      returnToState: this.returnTo,
    };
  }

  /**
   * Restore from a snapshot with fold semantics (aligns with GoalTracker).
   *
   * Safety model: a restart must NEVER resurrect a self-driving research run.
   * Active workflow states (clarifying/planning/gathering/evaluating/
   * synthesizing) fold to `awaiting_input` so the user explicitly resumes after
   * a crash. Pause/terminal states (awaiting_input/blocked/complete) restore
   * verbatim (they are durable decisions).
   *
   * Same-process guard: only applies on a cold start (current state still
   * `idle`); otherwise the existing in-memory state is kept untouched so a
   * mid-process coordinator restart cannot clobber a live research run.
   *
   * Invalid snapshots throw so the persistence layer reports failure.
   */
  restore(raw: ResearchSnapshot): void {
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof (raw as { state?: unknown }).state !== 'string' ||
      !RESEARCH_STATES.has((raw as ResearchSnapshot).state)
    ) {
      throw new Error(`invalid ResearchSnapshot: ${JSON.stringify(raw)}`);
    }
    if (this.currentState !== 'idle') {
      return;
    }
    const state = raw.state as ResearchState;
    const phase = raw.phase;
    if (typeof phase !== 'string' || !RESEARCH_PHASES.has(phase as ResearchPhase)) {
      throw new Error(`invalid ResearchSnapshot phase: ${JSON.stringify(raw.phase)}`);
    }
    const folded = WORKFLOW_STATES.has(state) ? 'awaiting_input' : state;
    this.currentState = folded;
    this.currentPhase = this.currentState === 'idle' ? 'idle' : phase;
    this.researchQuery = typeof raw.query === 'string' ? raw.query : '';
    this.researchSubQuestions = Array.isArray(raw.subQuestions)
      ? raw.subQuestions.filter((x): x is string => typeof x === 'string')
      : [];
    this.researchSources = Array.isArray(raw.sourcesGathered)
      ? raw.sourcesGathered.filter((x): x is string => typeof x === 'string')
      : [];
    this.researchGaps = Array.isArray(raw.coverageGaps)
      ? raw.coverageGaps.filter((x): x is string => typeof x === 'string')
      : [];
    this.researchCreatedAt = numberOr(raw.createdAt, 0);
    this.researchRounds = numberOr(raw.rounds, 0);
    this.researchStallRounds = numberOr(raw.stallRounds, 0);
    this.lastCoverageSig =
      typeof raw.lastCoverageSignature === 'string' ? raw.lastCoverageSignature : '';
    this.returnTo =
      typeof raw.returnToState === 'string' &&
      RESEARCH_STATES.has(raw.returnToState as ResearchState)
        ? (raw.returnToState as ResearchState)
        : undefined;
    this.researchHistory = Array.isArray(raw.history)
      ? raw.history.slice(-RESEARCH_HISTORY_CAP)
      : [];
  }

  // ─── Read accessors (for the coordinator / frontend) ───

  query(): string {
    return this.researchQuery;
  }

  subQuestions(): string[] {
    return [...this.researchSubQuestions];
  }

  sourcesGathered(): string[] {
    return [...this.researchSources];
  }

  coverageGaps(): string[] {
    return [...this.researchGaps];
  }

  rounds(): number {
    return this.researchRounds;
  }

  /** Consecutive evaluate rounds without a coverage-gap change. */
  stallRounds(): number {
    return this.researchStallRounds;
  }

  /**
   * Stable signature of the current coverage gaps (sorted, deduped). Used by
   * {@link recordEvaluationRound} to detect whether an evaluate round actually
   * shrank/reshaped the gap set — the stall heuristic's raw signal.
   */
  coverageSignature(): string {
    return JSON.stringify([...this.researchGaps].sort());
  }

  /**
   * Record that an evaluate round completed and update the stall counter.
   * If the coverage-gap signature is unchanged since the previous evaluate
   * round, the run is stalling → bump the counter; otherwise reset it to 0.
   * Returns the new stall count.
   */
  recordEvaluationRound(): number {
    const sig = this.coverageSignature();
    if (sig === this.lastCoverageSig) {
      this.researchStallRounds++;
    } else {
      this.researchStallRounds = 0;
    }
    this.lastCoverageSig = sig;
    return this.researchStallRounds;
  }

  /**
   * Auto-converge check: true when the evaluate loop has stalled (coverage
   * gaps unchanged) for at least `threshold` consecutive rounds. The
   * coordinator calls this at round-end while `evaluating` and, on true,
   * transitions to `synthesizing` so a stuck gather loop reliably converges.
   */
  shouldAutoConverge(threshold: number = RESEARCH_DEFAULT_CONVERGE_ROUNDS): boolean {
    return this.researchStallRounds >= threshold;
  }

  history(): ResearchHistoryEntry[] {
    return [...this.researchHistory];
  }

  createdAt(): number {
    return this.researchCreatedAt;
  }

  // ─── Coordinator helpers (pure state updates, driven by research tools) ───

  /** Record a sub-question produced during planning. */
  addSubQuestion(q: string): void {
    const t = typeof q === 'string' ? q.trim() : '';
    if (t && !this.researchSubQuestions.includes(t)) {
      this.researchSubQuestions.push(t);
    }
  }

  /** Record a gathered source key (title or url). */
  addSource(source: string): void {
    const t = typeof source === 'string' ? source.trim() : '';
    if (t && !this.researchSources.includes(t)) {
      this.researchSources.push(t);
    }
  }

  /** Record a coverage gap surfaced during evaluating. */
  addGap(gap: string): void {
    const t = typeof gap === 'string' ? gap.trim() : '';
    if (t && !this.researchGaps.includes(t)) {
      this.researchGaps.push(t);
    }
  }

  /** Clear the coverage gaps (e.g. when a new gather round starts). */
  clearGaps(): void {
    this.researchGaps = [];
  }

  // ─── Private transition helpers ───

  private start(query: string): boolean {
    const trimmed = typeof query === 'string' ? query.trim() : '';
    if (!trimmed) return false;
    this.currentState = 'clarifying';
    this.currentPhase = 'active';
    this.researchQuery = trimmed;
    this.researchSubQuestions = [];
    this.researchSources = [];
    this.researchGaps = [];
    this.researchCreatedAt = Date.now();
    this.researchRounds = 0;
    this.researchStallRounds = 0;
    this.lastCoverageSig = '';
    this.returnTo = undefined;
    this.pushHistory('start', trimmed);
    return true;
  }

  private clear(): boolean {
    if (this.currentState === 'idle') return false;
    this.currentState = 'idle';
    this.currentPhase = 'idle';
    this.researchQuery = '';
    this.researchSubQuestions = [];
    this.researchSources = [];
    this.researchGaps = [];
    this.researchCreatedAt = 0;
    this.researchRounds = 0;
    this.researchStallRounds = 0;
    this.lastCoverageSig = '';
    this.returnTo = undefined;
    this.researchHistory = [];
    return true;
  }

  /** Shared state-change bookkeeping: set state + append a history entry. */
  private move(next: ResearchState, eventLabel: string): boolean {
    if (next === this.currentState) return false;
    this.currentState = next;
    this.pushHistory(eventLabel);
    return true;
  }

  private pushHistory(event: string, detail?: string): void {
    this.researchHistory.push({ at: Date.now(), event, detail });
    if (this.researchHistory.length > RESEARCH_HISTORY_CAP) {
      this.researchHistory.splice(0, this.researchHistory.length - RESEARCH_HISTORY_CAP);
    }
  }
}

/** Sentinel singleton — registered against the mode engine in `modes/index.ts`. */
export const researchModeTracker = new ResearchTracker();

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}