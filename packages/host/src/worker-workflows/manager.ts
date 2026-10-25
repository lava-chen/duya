/**
 * manager.ts — WorkflowManager: the run-management layer over the
 * engine (plan 415 §2 run layer + 552 §6).
 *
 * Responsibilities:
 *   - launch: dedup-key idempotency (§7), run row + snapshot blob
 *     creation, engine execution with in-flight tracking,
 *   - persistence: every journal record dual-writes (snapshot blob +
 *     the host's live progress channel — one write, three uses),
 *   - suspension: waiting outcomes park the run (`blocked` + wait_till,
 *     zero memory), resume verifies the signed token,
 *   - wait tracking: `tickWaitTracker()` (60s-grade, cron-tick host)
 *     applies each parked node's on_timeout policy,
 *   - crash reconciliation (§6.2): runs the engine does NOT report
 *     in-flight become `stopped`; the frozen definition + journal support
 *     an explicit recovery replay.
 *
 * Storage is a port (`WorkflowRunStoreLike`) so the manager is unit
 * testable with an in-memory fake; production binds the core-db
 * store over IPC (`workflowRunDb`).
 */

import {
  WorkflowEngine,
  computeDefinitionHash,
  validateWorkflow,
  type EngineOutcome,
  type WorkflowDef,
} from '@duya/workflow';
import { Journal, type JournalRecord, type JournalSink } from './journal.js';
import { verifyResumeToken, createResumeToken } from './resume-token.js';
import type { WorkflowHost } from '@duya/workflow';
import { WorkflowDecisionAdapter } from './decision-adapter.js';
import { createWorkflowRuntimePorts } from './runtime-ports.js';
import { defaultConcurrency } from './host.js';
import type { DecisionService } from '../decisions/index.js';
import type { WorkflowObservationEvent } from '@duya/workflow';
import { runVerifyStage, type VerifyVerdict } from './verify.js';
import type { PlannerResult } from './planner.js';

// ─── store port ───

/** Structural run row (mirrors the core-db WorkflowRun). */
export interface ManagedRun {
  id: string;
  workflowName: string;
  workflowVersionId: string | null;
  status: string;
  triggerKind: string | null;
  dedupKey: string | null;
  params: Record<string, unknown>;
  waitTill: number | null;
  retryOf: string | null;
  pauseMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRunStoreLike {
  createRun(input: {
    id?: string;
    workflowName: string;
    workflowVersionId?: string | null;
    status?: string;
    triggerKind?: string | null;
    dedupKey?: string | null;
    params?: Record<string, unknown>;
    retryOf?: string | null;
  }): Promise<ManagedRun>;
  getRun(id: string): Promise<ManagedRun | null>;
  getRunByDedupKey(dedupKey: string): Promise<ManagedRun | null>;
  listRuns(filter?: { status?: string; workflowName?: string; limit?: number; offset?: number }): Promise<ManagedRun[]>;
  updateStatus(id: string, status: string, pauseMessage?: string | null): Promise<boolean>;
  setWaitTill(id: string, waitTill: number | null): Promise<boolean>;
  saveSnapshot(input: {
    runId: string;
    definition: unknown;
    definitionHash?: string;
    definitionHashSource?: 'dag' | 'dwf-script';
    nodeStack: Array<{ nodeId: string; status: string; output?: unknown }>;
    journal: unknown[];
  }): Promise<void>;
  loadSnapshot(runId: string): Promise<{
    runId: string;
    definition: unknown;
    definitionHash?: string;
    definitionHashSource?: 'dag' | 'dwf-script';
    nodeStack: Array<{ nodeId: string; status: string; output?: unknown }>;
    journal: unknown[];
  } | null>;
  appendJournal(runId: string, record: unknown): Promise<void>;
  loadJournal(runId: string): Promise<JournalRecord[]>;
  replaceJournal(runId: string, records: JournalRecord[]): Promise<void>;
  listWaitingPast(now: number): Promise<ManagedRun[]>;
}

export type RunStatus = ManagedRun['status'];

export interface LaunchInput {
  def: WorkflowDef;
  params?: Record<string, unknown>;
  triggerKind?: 'manual' | 'cron' | 'bot' | 'http';
  /** Idempotency key (§7): a hit returns the existing run untouched. */
  dedupKey?: string;
  retryOf?: string;
  signal?: AbortSignal;
}

export type LaunchResult =
  | { status: 'complete'; runId: string; outputs: Record<string, unknown>; verification?: VerifyVerdict | undefined }
  | { status: 'failed'; runId: string; errorClass: string; error: string }
  | { status: 'waiting'; runId: string; nodeId: string; resumeToken: string; waitTill: number }
  | { status: 'cancelled'; runId: string }
  | { status: 'deduped'; runId: string }
  | { status: 'invalid'; errors: Array<{ path: string; message: string }> }
  | { status: 'awaiting_confirm'; runId: string; highRiskNodes: string[] };

// ─── manager ───

export interface WorkflowManagerOptions {
  host: WorkflowHost;
  store: WorkflowRunStoreLike;
  decisionService?: DecisionService;
  /** Resume-token HMAC secret (production: host-provided, persistent). */
  secret?: string;
  approvalMode?: 'await' | 'suspend';
  agentBudget?: number;
  maxConcurrency?: number;
  /** @deprecated Use maxConcurrency. */
  concurrency?: number;
  onObservation?: (event: WorkflowObservationEvent) => void;
  /** Live progress tap (SSE) — receives every journal record. */
  onProgress?: (record: JournalRecord, runId: string) => void;
  /** Fresh-eyes verify stage after a complete outcome (plan 552 Phase 5). */
  verify?: { acceptanceCriteria?: string };
  /**
   * Completion auto-wake (552 ruling 3): inject a continuation prompt
   * into the host session via the existing mailbox/wake machinery.
   * The production wiring (Phase 6) binds the wake bus here.
   */
  onRunFinished?: (runId: string, outcome: EngineOutcome, verification?: VerifyVerdict) => void;
}

export class WorkflowManager {
  /** runId → abort controller for in-flight runs (cancel + reconciliation). */
  private readonly inFlight = new Map<string, AbortController>();
  /** Live engine handle for run-scoped concurrency retuning. */
  private readonly liveEngines = new Map<string, WorkflowEngine>();

  constructor(private readonly options: WorkflowManagerOptions) {}

  /** Run ids the engine is currently executing (crash reconciliation input). */
  activeRunIds(): string[] {
    return [...this.inFlight.keys()];
  }

  /** Change the run gate in place; returns false if this run is not executing. */
  setRunConcurrency(runId: string, maxConcurrency: number): boolean {
    const engine = this.liveEngines.get(runId);
    if (!engine) return false;
    engine.setMaxConcurrency(maxConcurrency, runId);
    return true;
  }

  async launch(input: LaunchInput): Promise<LaunchResult> {
    // Static validation gates every launch (§10: validate before execute).
    const validation = validateWorkflow(input.def);
    if (!validation.ok || !validation.def) {
      return { status: 'invalid', errors: validation.errors };
    }
    const def = validation.def;
    const definitionHash = this.definitionHash(def);

    // Trigger idempotency (§7): at-least-once delivery must not double-run.
    if (input.dedupKey) {
      const existing = await this.options.store.getRunByDedupKey(input.dedupKey);
      if (existing) return { status: 'deduped', runId: existing.id };
    }

    const run = await this.options.store.createRun({
      workflowName: def.name,
      workflowVersionId: `${def.name}@${Date.now()}`,
      status: 'active',
      triggerKind: input.triggerKind ?? 'manual',
      dedupKey: input.dedupKey ?? null,
      params: input.params ?? {},
      retryOf: input.retryOf ?? null,
    });
    // The snapshot blob must exist BEFORE the first journal append —
    // records land in it as they happen (one write, three uses, §2).
    await this.options.store.saveSnapshot({
      runId: run.id,
      definition: def,
      definitionHash,
      definitionHashSource: 'dag',
      nodeStack: [],
      journal: [],
    });

    const abort = new AbortController();
    this.inFlight.set(run.id, abort);
    try {
      const { outcome, verification } = await this.executeRun(run.id, def, input.params ?? {}, {
        signal: input.signal ?? abort.signal,
        expectedDefinitionHash: definitionHash,
      });
      return this.toLaunchResult(outcome, verification);
    } finally {
      this.inFlight.delete(run.id);
    }
  }

  /**
   * High-risk gate (415 §7 + 552 §5 落点⑤): a plan with flagged nodes
   * NEVER auto-executes — the run is created in `awaiting_confirm` and
   * only `confirmLaunch` starts it.
   */
  async launchFromPlan(plan: PlannerResult, input: Omit<LaunchInput, 'def'> & { def?: WorkflowDef }): Promise<LaunchResult> {
    const def = input.def ?? plan.def;
    if (plan.highRiskNodes.length === 0) {
      return this.launch({ ...input, def });
    }
    const validation = validateWorkflow(def);
    if (!validation.ok || !validation.def) {
      return { status: 'invalid', errors: validation.errors };
    }
    const validatedDef = validation.def;
    const run = await this.options.store.createRun({
      workflowName: validatedDef.name,
      workflowVersionId: `${validatedDef.name}@${Date.now()}`,
      status: 'awaiting_confirm',
      triggerKind: input.triggerKind ?? 'manual',
      dedupKey: input.dedupKey ?? null,
      params: input.params ?? {},
      retryOf: input.retryOf ?? null,
    });
    await this.options.store.saveSnapshot({
      runId: run.id,
      definition: validatedDef,
      definitionHash: this.definitionHash(validatedDef),
      definitionHashSource: 'dag',
      nodeStack: [],
      journal: [],
    });
    return { status: 'awaiting_confirm', runId: run.id, highRiskNodes: plan.highRiskNodes };
  }

  /** User confirmed the high-risk plan → execute from the stored def. */
  async confirmLaunch(runId: string): Promise<LaunchResult> {
    const snap = await this.options.store.loadSnapshot(runId);
    const run = await this.options.store.getRun(runId);
    if (!snap || !run || run.status !== 'awaiting_confirm') {
      return { status: 'failed', runId, errorClass: 'unknown', error: 'run is not awaiting confirmation' };
    }
    const prepared = await this.prepareDagSnapshot(snap);
    if ('error' in prepared) {
      return { status: 'failed', runId, errorClass: 'definition_hash_mismatch', error: prepared.error };
    }
    await this.options.store.updateStatus(runId, 'active', null);
    const abort = new AbortController();
    this.inFlight.set(runId, abort);
    try {
      const { outcome, verification } = await this.executeRun(runId, prepared.def, run.params, {
        signal: abort.signal,
        expectedDefinitionHash: prepared.definitionHash,
      });
      return this.toLaunchResult(outcome, verification);
    } finally {
      this.inFlight.delete(runId);
    }
  }

  /** Resume a suspended run after verifying its frozen definition hash. */
  async resume(
    runId: string,
    resume: { token: string; decision: 'approve' | 'deny' | 'timeout' },
  ): Promise<LaunchResult> {
    const payload = verifyResumeToken(this.options.secret ?? 'duya-workflow-dev-secret', resume.token);
    if (!payload || payload.runId !== runId) {
      return { status: 'failed', runId, errorClass: 'unknown', error: 'invalid resume token' };
    }
    const snap = await this.options.store.loadSnapshot(runId);
    const run = await this.options.store.getRun(runId);
    if (!snap || !run) {
      return { status: 'failed', runId, errorClass: 'unknown', error: 'run not found' };
    }
    const prepared = await this.prepareDagSnapshot(snap);
    if ('error' in prepared) {
      return { status: 'failed', runId, errorClass: 'definition_hash_mismatch', error: prepared.error };
    }
    const journal = await this.recoveryJournal(runId, snap.journal as JournalRecord[]);

    await this.options.store.updateStatus(runId, 'active', null);
    const abort = new AbortController();
    this.inFlight.set(runId, abort);
    try {
      const { outcome, verification } = await this.executeRun(runId, prepared.def, run.params, {
        signal: abort.signal,
        journal,
        token: resume.token,
        decision: resume.decision,
        expectedDefinitionHash: prepared.definitionHash,
      });
      return this.toLaunchResult(outcome, verification);
    } finally {
      this.inFlight.delete(runId);
    }
  }

  /** Explicitly recover an orphaned `stopped` run from its snapshot + journal. */
  async resumeStopped(runId: string): Promise<LaunchResult> {
    const snap = await this.options.store.loadSnapshot(runId);
    const run = await this.options.store.getRun(runId);
    if (!snap || !run) {
      return { status: 'failed', runId, errorClass: 'unknown', error: 'run not found' };
    }
    if (run.status !== 'stopped') {
      return { status: 'failed', runId, errorClass: 'run_not_stopped', error: 'run is not recoverably stopped' };
    }
    const prepared = await this.prepareDagSnapshot(snap);
    if ('error' in prepared) {
      return { status: 'failed', runId, errorClass: 'definition_hash_mismatch', error: prepared.error };
    }
    const journal = await this.recoveryJournal(runId, snap.journal as JournalRecord[]);
    await this.options.store.updateStatus(runId, 'active', null);
    const abort = new AbortController();
    this.inFlight.set(runId, abort);
    try {
      const { outcome, verification } = await this.executeRun(runId, prepared.def, run.params, {
        signal: abort.signal,
        journal,
        expectedDefinitionHash: prepared.definitionHash,
      });
      return this.toLaunchResult(outcome, verification);
    } finally {
      this.inFlight.delete(runId);
    }
  }

  /** User cancel — journal-free terminal (§6.4: replayable semantics). */
  async cancel(runId: string): Promise<boolean> {
    const abort = this.inFlight.get(runId);
    if (abort) {
      abort.abort();
      return true;
    }
    // Not in-flight: mark a parked/idle run cancelled directly.
    return this.options.store.updateStatus(runId, 'cancelled', 'cancelled by user');
  }

  /**
   * Crash reconciliation (§6.2): orphaned active runs become explicitly
   * `stopped`; an operator can recover them from the frozen snapshot + journal.
   */
  async reconcile(): Promise<Array<{ runId: string }>> {
    // Implemented over the store port by listing + comparing.
    const candidates = (await Promise.all(['active', 'verifying', 'planning'].map(
      (status) => this.options.store.listRuns({ status }),
    ))).flat();
    const active = new Set(this.activeRunIds());
    const stale = candidates.filter((r) => !active.has(r.id));
    for (const run of stale) {
      const journal = this.journalFrom(await this.options.store.loadJournal(run.id));
      if (journal.reconcileOrphanRunning() > 0) {
        await this.options.store.replaceJournal(run.id, journal.all());
      }
      await this.options.store.updateStatus(run.id, 'stopped', 'crash reconciliation: orphaned run; explicit resume is available');
    }
    return stale.map((r) => ({ runId: r.id }));
  }

  /**
   * Wait-tracker tick (60s-grade; the cron tick host calls this): every
   * parked run past its wait_till gets its on_timeout policy applied
   * through the resume path (decision 'timeout').
   */
  async tickWaitTracker(): Promise<Array<{ runId: string; applied: 'timeout' }>> {
    const parked = await this.options.store.listWaitingPast(Date.now());
    const applied: Array<{ runId: string; applied: 'timeout' }> = [];
    for (const run of parked) {
      const snap = await this.options.store.loadSnapshot(run.id);
      if (!snap) continue;
      const node = findSuspensionNode(snap.definition as WorkflowDef, run.pauseMessage ?? '');
      // Resume with decision 'timeout' — the engine/human-runner maps
      // on_timeout (skip/fail/escalate).
      const token = createResumeToken(this.options.secret ?? 'duya-workflow-dev-secret', {
        runId: run.id,
        nodeId: node?.nodeId ?? 'unknown',
        issuedAt: Date.now(),
      });
      await this.resume(run.id, { token, decision: 'timeout' });
      applied.push({ runId: run.id, applied: 'timeout' });
    }
    return applied;
  }

  // ─── internals ───

  private definitionHash(def: WorkflowDef): string {
    return computeDefinitionHash(def, createWorkflowRuntimePorts(this.options.secret).hash);
  }

  private async prepareDagSnapshot(snap: {
    runId: string;
    definition: unknown;
    definitionHash?: string;
    definitionHashSource?: 'dag' | 'dwf-script';
    nodeStack: Array<{ nodeId: string; status: string; output?: unknown }>;
    journal: unknown[];
  }): Promise<{ def: WorkflowDef; definitionHash: string } | { error: string }> {
    if (snap.definitionHashSource !== undefined && snap.definitionHashSource !== 'dag') {
      return { error: 'stored definition is not a DAG workflow' };
    }
    const validation = validateWorkflow(snap.definition);
    if (!validation.ok || !validation.def) return { error: 'stored DAG definition is invalid' };
    const definitionHash = this.definitionHash(validation.def);
    if (snap.definitionHash !== undefined && snap.definitionHash !== definitionHash) {
      return { error: 'workflow definition hash does not match the stored snapshot' };
    }
    if (snap.definitionHash === undefined || snap.definitionHashSource === undefined) {
      // Older snapshots are anchored by their frozen definition; write the
      // calculated full hash once so all subsequent recoveries are checked.
      await this.options.store.saveSnapshot({
        runId: snap.runId,
        definition: validation.def,
        definitionHash,
        definitionHashSource: 'dag',
        nodeStack: snap.nodeStack,
        journal: [],
      });
    }
    return { def: validation.def, definitionHash };
  }

  private async recoveryJournal(runId: string, legacySnapshotJournal: JournalRecord[]): Promise<Journal> {
    const durable = await this.options.store.loadJournal(runId);
    const journal = this.journalFrom(durable.length > 0 ? durable : legacySnapshotJournal);
    const pruned = journal.pruneTrailingFailures();
    if (pruned > 0) await this.options.store.replaceJournal(runId, journal.all());
    return journal;
  }

  private journalFrom(records: JournalRecord[]): Journal {
    let current = [...records];
    const sink: JournalSink = {
      append: (record) => { current.push(record); },
      readAll: () => [...current],
      replaceAll: (next) => { current = [...next]; },
    };
    return new Journal(sink);
  }

  /** Journal sink that persists every record into the snapshot blob. */
  private journalSink(runId: string, records: JournalRecord[]): JournalSink {
    const manager = this;
    return {
      append(record: JournalRecord) {
        records.push(record);
        void manager.options.store.appendJournal(runId, record);
        manager.options.onProgress?.(record, runId);
      },
      readAll: () => records,
    };
  }

  private async executeRun(
    runId: string,
    def: WorkflowDef,
    params: Record<string, unknown>,
    opts: {
      signal?: AbortSignal;
      journal?: Journal;
      token?: string;
      decision?: 'approve' | 'deny' | 'timeout';
      expectedDefinitionHash?: string;
    },
  ): Promise<{ outcome: EngineOutcome; verification?: VerifyVerdict | undefined }> {
    const records: JournalRecord[] = [];
    let journal: Journal;
    if (opts.journal) {
      journal = opts.journal;
      // Tap new records into the blob + progress channel.
      journal.listener = (record) => {
        void this.options.store.appendJournal(runId, record);
        this.options.onProgress?.(record, runId);
      };
    } else {
      journal = new Journal(this.journalSink(runId, records));
    }

    const engine = new WorkflowEngine({
      host: this.options.host,
      ...(this.options.decisionService
        ? { decisions: new WorkflowDecisionAdapter(this.options.decisionService) }
        : {}),
      ports: createWorkflowRuntimePorts(this.options.secret),
      approvalMode: this.options.approvalMode ?? 'await',
      agentBudget: this.options.agentBudget,
      maxConcurrency: this.options.maxConcurrency ?? this.options.concurrency ?? defaultConcurrency(),
      onObservation: this.options.onObservation,
      signal: opts.signal,
    });

    let outcome: EngineOutcome;
    this.liveEngines.set(runId, engine);
    try {
      if (opts.token && opts.decision) {
        outcome = await engine.resume(def, params, journal, { token: opts.token, decision: opts.decision }, {
          runId,
          journal,
          ...(opts.expectedDefinitionHash !== undefined ? { expectedDefinitionHash: opts.expectedDefinitionHash } : {}),
        });
      } else {
        outcome = await engine.execute(def, params, {
          runId,
          journal,
          ...(opts.expectedDefinitionHash !== undefined ? { expectedDefinitionHash: opts.expectedDefinitionHash } : {}),
        });
      }
    } finally {
      this.liveEngines.delete(runId);
    }

    // Terminal statuses → run row (journal-free stops already skipped
    // the engine's journal writes; here we only mirror the outcome).
    let verification: VerifyVerdict | undefined;
    switch (outcome.status) {
      case 'complete':
        await this.options.store.updateStatus(runId, 'complete', null);
        await this.options.store.setWaitTill(runId, null);
        // Fresh-eyes verify stage (plan 552 Phase 5) — annotation lands
        // in the journal; synthesis MUST present verified/unconfirmed.
        if (this.options.verify) {
          try {
            verification = await runVerifyStage({
              def,
              outputs: outcome.outputs,
              journal,
              runId,
              host: this.options.host,
              decisionService: this.options.decisionService,
              acceptanceCriteria: this.options.verify.acceptanceCriteria,
            });
          } catch {
            verification = undefined; // verify must never fail the run
          }
        }
        break;
      case 'failed':
        await this.options.store.updateStatus(runId, 'failed', outcome.error);
        await this.options.store.setWaitTill(runId, null);
        break;
      case 'waiting':
        await this.options.store.updateStatus(runId, 'blocked', `awaiting approval at ${outcome.nodeId}`);
        await this.options.store.setWaitTill(runId, outcome.waitTill);
        break;
      case 'cancelled':
        await this.options.store.updateStatus(runId, 'cancelled', 'cancelled');
        break;
    }
    this.options.onRunFinished?.(runId, outcome, verification);
    return { outcome, verification };
  }

  private toLaunchResult(outcome: EngineOutcome, verification?: VerifyVerdict): LaunchResult {
    switch (outcome.status) {
      case 'complete':
        return {
          status: 'complete',
          runId: outcome.runId,
          outputs: outcome.outputs,
          verification,
        };
      case 'failed':
        return { status: 'failed', runId: outcome.runId, errorClass: outcome.errorClass, error: outcome.error };
      case 'waiting':
        return {
          status: 'waiting',
          runId: outcome.runId,
          nodeId: outcome.nodeId,
          resumeToken: outcome.resumeToken,
          waitTill: outcome.waitTill,
        };
      case 'cancelled':
        return { status: 'cancelled', runId: outcome.runId };
    }
  }
}

function findSuspensionNode(
  def: WorkflowDef,
  _pauseMessage: string,
): { nodeId: string } | undefined {
  void _pauseMessage;
  for (const phase of def.phases) {
    for (const node of phase.nodes) {
      if (node.human) return { nodeId: node.id };
    }
  }
  return undefined;
}
