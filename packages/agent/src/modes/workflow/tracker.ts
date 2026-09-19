/**
 * tracker.ts — WorkflowRunTracker, the run-level state machine for one
 * workflow run (plan 415 §6.3 as amended by 552 ruling #4).
 *
 * Composes the SMALL KERNEL (`engine/run-lifecycle-tracker.ts` — shared
 * vocabulary, pure matrix, history cap, fold semantics) with workflow-
 * specific fields: phase bookkeeping, agent-call budget consumption,
 * execution epoch (stale-callback guard), journal reference. It is a
 * parallel implementation in the grok sense — no base class, shared
 * vocabulary only — and satisfies the plan 413 ModeTracker contract
 * (pure transition, no async I/O, snapshot/restore side-effect-free).
 *
 *   inactive → planning → [high_risk] awaiting_confirm → active ⇄ verifying
 *     → complete | budget_limited | cancelled | interrupted | failed
 *     → paused family | blocked
 *
 * Human-node suspension (plan 552 §6.3) lands on `blocked` — a resumable
 * pause — with `waitTill` recorded on the run row by the store, not here.
 */

import type { ModeTracker } from '../engine/tracker.js';
import {
  foldRestoredRunState,
  parseRunHistory,
  parseRunLifecycleState,
  pushRunHistory,
  transitionRunLifecycle,
  isPausedRunState,
  isResumableRunState,
  isTerminalRunState,
  runNeedsTopUp,
  runStateCanGateTools,
  runStateShouldInjectReminder,
  RUN_HISTORY_CAP,
  type RunLifecycleEvent,
  type RunLifecycleHistoryEntry,
  type RunLifecycleState,
} from '../engine/run-lifecycle-tracker.js';

/** Persisted snapshot (mode_state_snapshots `mode='workflow-run'`). */
export interface WorkflowRunSnapshot {
  state: RunLifecycleState;
  /** Workflow name (the `objective` of the generic lifecycle). */
  workflowName: string;
  /** Agent-call budget (plan 552 §6.5: default 128, hard cap 1024). */
  budget: number;
  agentsUsed: number;
  elapsedMs: number;
  createdAt: number;
  history: RunLifecycleHistoryEntry[];
  pauseMessage?: string;
  /** Workflow-specific extensions. */
  currentPhaseId?: string;
  currentPhaseIndex: number;
  executionEpoch: number;
  journalRef?: string;
  workflowVersionId?: string;
  /** Epoch ms until which the run is parked (human / timeout suspension). */
  waitTill?: number;
}

export class WorkflowRunTracker implements ModeTracker<RunLifecycleState, RunLifecycleEvent, WorkflowRunSnapshot> {
  readonly id = 'workflow-run';

  private currentState: RunLifecycleState = 'inactive';
  private runName = '';
  private runBudget = 0;
  private usedAgents = 0;
  private runCreatedAt = 0;
  private historyLog: RunLifecycleHistoryEntry[] = [];
  private runPauseMessage?: string;
  private phaseId?: string;
  private phaseIndex = -1;
  private epoch = 0;
  private journalPath?: string;
  private versionId?: string;
  private parkedUntil?: number;

  state(): RunLifecycleState {
    return this.currentState;
  }

  isPaused(): boolean {
    return isPausedRunState(this.currentState);
  }

  isTerminal(): boolean {
    return isTerminalRunState(this.currentState);
  }

  isResumable(): boolean {
    return isResumableRunState(this.currentState);
  }

  needsTopUp(): boolean {
    return runNeedsTopUp(this.currentState);
  }

  canGateTools(): boolean {
    return runStateCanGateTools(this.currentState);
  }

  shouldInjectReminder(): boolean {
    return runStateShouldInjectReminder(this.currentState);
  }

  pauseMessage(): string | undefined {
    return this.runPauseMessage;
  }

  workflowName(): string {
    return this.runName;
  }

  budgetLimit(): number {
    return this.runBudget;
  }

  agentsUsed(): number {
    return this.usedAgents;
  }

  currentPhase(): { index: number; id?: string } {
    return { index: this.phaseIndex, id: this.phaseId };
  }

  executionEpoch(): number {
    return this.epoch;
  }

  journalRef(): string | undefined {
    return this.journalPath;
  }

  history(): RunLifecycleHistoryEntry[] {
    return [...this.historyLog];
  }

  /**
   * Consume one agent call from the budget (plan 552 §6.5 reserve→release
   * bookkeeping lives in the host; this is the counter of record). Returns
   * false when the call would exceed the budget — the host then sends
   * `budget_limit` instead of executing.
   */
  consumeAgentCall(): boolean {
    if (this.runBudget > 0 && this.usedAgents >= this.runBudget) return false;
    this.usedAgents++;
    return true;
  }

  /** Release a reserved call (failed spawn — the reservation is refunded). */
  releaseAgentCall(): void {
    this.usedAgents = Math.max(0, this.usedAgents - 1);
  }

  /** Engine bookkeeping: the run advanced to a phase (not a transition). */
  enterPhase(index: number, phaseId: string | undefined): void {
    this.phaseIndex = index;
    this.phaseId = phaseId;
  }

  /** Bump the execution epoch — stale async callbacks compare and bail. */
  bumpEpoch(): number {
    return ++this.epoch;
  }

  /** Pin the journal file backing this run (breakpoint-resume source). */
  setJournalRef(path: string): void {
    this.journalPath = path;
  }

  setVersionId(versionId: string): void {
    this.versionId = versionId;
  }

  /** Park the run until an epoch ms instant (human approval / timeout). */
  parkUntil(atMs: number): void {
    this.parkedUntil = atMs;
  }

  waitTill(): number | undefined {
    return this.parkedUntil;
  }

  transition(event: RunLifecycleEvent): boolean {
    const result = transitionRunLifecycle(this.currentState, event);
    if (!result.handled || !result.next) return false;
    this.currentState = result.next;

    if (event.type === 'start') {
      this.runName = typeof event.objective === 'string' ? event.objective : this.runName;
      this.runBudget = typeof event.budget === 'number' && event.budget > 0 ? event.budget : this.runBudget;
      this.runCreatedAt = Date.now();
      this.usedAgents = 0;
      this.phaseIndex = -1;
      this.phaseId = undefined;
      this.runPauseMessage = undefined;
      this.parkedUntil = undefined;
      this.epoch++;
    }
    if (event.type === 'resume' && event.budget !== undefined && event.budget > 0) {
      this.runBudget = event.budget;
      this.usedAgents = 0;
    }
    if (event.type === 'pause') {
      this.runPauseMessage = event.message;
    }
    if (event.type === 'fail' && event.message) {
      this.runPauseMessage = event.message;
    }
    if (result.next === 'complete' || result.next === 'cancelled') {
      this.parkedUntil = undefined;
    }
    if (event.type === 'clear') {
      this.runName = '';
      this.runBudget = 0;
      this.usedAgents = 0;
      this.runCreatedAt = 0;
      this.historyLog = [];
      this.runPauseMessage = undefined;
      this.phaseIndex = -1;
      this.phaseId = undefined;
      this.parkedUntil = undefined;
      return true;
    }
    pushRunHistory(this.historyLog, result.label ?? event.type, this.runPauseMessage);
    return true;
  }

  snapshot(): WorkflowRunSnapshot {
    return {
      state: this.currentState,
      workflowName: this.runName,
      budget: this.runBudget,
      agentsUsed: this.usedAgents,
      elapsedMs: this.runCreatedAt > 0 ? Math.max(0, Date.now() - this.runCreatedAt) : 0,
      createdAt: this.runCreatedAt,
      history: [...this.historyLog],
      pauseMessage: this.runPauseMessage,
      currentPhaseId: this.phaseId,
      currentPhaseIndex: this.phaseIndex,
      executionEpoch: this.epoch,
      journalRef: this.journalPath,
      workflowVersionId: this.versionId,
      ...(this.parkedUntil !== undefined ? { waitTill: this.parkedUntil } : {}),
    };
  }

  /**
   * Restore with grok `from_snapshot` fold semantics (verifying → active,
   * planning/awaiting_confirm → inactive; everything else verbatim).
   * Same-process guard: only a cold tracker (inactive) applies a snapshot —
   * a live in-memory run is authoritative. Throws on malformed input.
   */
  restore(raw: WorkflowRunSnapshot): void {
    const state = parseRunLifecycleState(raw?.state);
    const history = parseRunHistory(raw?.history);
    if (this.currentState !== 'inactive') return;
    this.currentState = foldRestoredRunState(state);
    this.runName = typeof raw.workflowName === 'string' ? raw.workflowName : '';
    this.runBudget = typeof raw.budget === 'number' && raw.budget > 0 ? raw.budget : 0;
    this.usedAgents = typeof raw.agentsUsed === 'number' && raw.agentsUsed >= 0 ? raw.agentsUsed : 0;
    this.runCreatedAt = typeof raw.createdAt === 'number' ? raw.createdAt : 0;
    this.historyLog = history.slice(-RUN_HISTORY_CAP);
    this.runPauseMessage = typeof raw.pauseMessage === 'string' ? raw.pauseMessage : undefined;
    this.phaseId = typeof raw.currentPhaseId === 'string' ? raw.currentPhaseId : undefined;
    this.phaseIndex = typeof raw.currentPhaseIndex === 'number' ? raw.currentPhaseIndex : -1;
    this.epoch = typeof raw.executionEpoch === 'number' ? raw.executionEpoch : 0;
    this.journalPath = typeof raw.journalRef === 'string' ? raw.journalRef : undefined;
    this.versionId = typeof raw.workflowVersionId === 'string' ? raw.workflowVersionId : undefined;
    this.parkedUntil = typeof raw.waitTill === 'number' ? raw.waitTill : undefined;
  }
}

/** Sentinel singleton for the (single-flight per process) run tracker. */
export const workflowRunTracker = new WorkflowRunTracker();
