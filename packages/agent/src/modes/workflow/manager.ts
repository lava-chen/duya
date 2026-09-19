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
 *     in-flight are marked `interrupted` — never auto-rerun; resume is
 *     an explicit decision (kill -9 recovery replays journal cache).
 *
 * Storage is a port (`WorkflowRunStoreLike`) so the manager is unit
 * testable with an in-memory fake; production binds the core-db
 * store over IPC (`workflowRunDb`).
 */

import type { WorkflowDef } from './schema.js';
import { validateWorkflow } from './validate.js';
import { WorkflowEngine, type EngineOutcome, type EngineOptions } from './engine.js';
import { Journal, type JournalRecord, type JournalSink } from './journal.js';
import { verifyResumeToken, createResumeToken } from './resume-token.js';
import type { WorkflowHost } from './host.js';
import type { GuiRunPorts } from './gui-runner.js';

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
    nodeStack: Array<{ nodeId: string; status: string; output?: unknown }>;
    journal: unknown[];
  }): Promise<void>;
  loadSnapshot(runId: string): Promise<{
    runId: string;
    definition: unknown;
    nodeStack: Array<{ nodeId: string; status: string; output?: unknown }>;
    journal: unknown[];
  } | null>;
  appendJournal(runId: string, record: unknown): Promise<void>;
  loadJournal(runId: string): Promise<unknown[]>;
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
  | { status: 'complete'; runId: string; outputs: Record<string, unknown> }
  | { status: 'failed'; runId: string; errorClass: string; error: string }
  | { status: 'waiting'; runId: string; nodeId: string; resumeToken: string; waitTill: number }
  | { status: 'cancelled'; runId: string }
  | { status: 'deduped'; runId: string }
  | { status: 'invalid'; errors: Array<{ path: string; message: string }> };

// ─── manager ───

export interface WorkflowManagerOptions {
  host: WorkflowHost;
  store: WorkflowRunStoreLike;
  decisionService?: EngineOptions['decisionService'];
  gui?: GuiRunPorts;
  /** Resume-token HMAC secret (production: host-provided, persistent). */
  secret?: string;
  approvalMode?: 'await' | 'suspend';
  agentBudget?: number;
  concurrency?: number;
  /** Live progress tap (SSE) — receives every journal record. */
  onProgress?: (record: JournalRecord, runId: string) => void;
}

export class WorkflowManager {
  /** runId → abort controller for in-flight runs (cancel + reconciliation). */
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly options: WorkflowManagerOptions) {}

  /** Run ids the engine is currently executing (crash reconciliation input). */
  activeRunIds(): string[] {
    return [...this.inFlight.keys()];
  }

  async launch(input: LaunchInput): Promise<LaunchResult> {
    // Static validation gates every launch (§10: validate before execute).
    const validation = validateWorkflow(input.def);
    if (!validation.ok || !validation.def) {
      return { status: 'invalid', errors: validation.errors };
    }
    const def = validation.def;

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
      nodeStack: [],
      journal: [],
    });

    const abort = new AbortController();
    this.inFlight.set(run.id, abort);
    try {
      const outcome = await this.executeRun(run.id, def, input.params ?? {}, {
        signal: input.signal ?? abort.signal,
      });
      return this.toLaunchResult(outcome);
    } finally {
      this.inFlight.delete(run.id);
    }
  }

  /**
   * Resume a suspended run. The token binds run + node identity (timing-
   * safe HMAC); the decision lands as its own approval record and the
   * journal cache replays completed nodes at zero cost (§6.4).
   */
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
    const def = snap.definition as WorkflowDef;
    const journal = this.journalFrom(snap.journal as JournalRecord[]);

    await this.options.store.updateStatus(runId, 'active', null);
    const outcome = await this.executeRun(runId, def, run.params, { journal, token: resume.token, decision: resume.decision });
    return this.toLaunchResult(outcome);
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
   * Crash reconciliation (§6.2): runs the engine does not report
   * in-flight → `interrupted`. Called at startup / heartbeat with the
   * engine's live set; persistence handles the rest.
   */
  async reconcile(): Promise<Array<{ runId: string }>> {
    // Implemented over the store port by listing + comparing.
    const all = await this.options.store.listRuns({ status: 'active' as string });
    const verifying = await this.options.store.listRuns({ status: 'verifying' as string });
    const candidates = [...all, ...verifying];
    const active = new Set(this.activeRunIds());
    const stale = candidates.filter((r) => !active.has(r.id));
    for (const run of stale) {
      await this.options.store.updateStatus(run.id, 'interrupted', 'crash reconciliation: engine not running this run');
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

  private journalFrom(records: JournalRecord[]): Journal {
    const sink: JournalSink = {
      append: () => {},
      readAll: () => records,
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
    },
  ): Promise<EngineOutcome> {
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
      decisionService: this.options.decisionService,
      secret: this.options.secret,
      gui: this.options.gui,
      approvalMode: this.options.approvalMode ?? 'await',
      agentBudget: this.options.agentBudget,
      concurrency: this.options.concurrency,
      signal: opts.signal,
    });

    let outcome: EngineOutcome;
    if (opts.token && opts.decision) {
      outcome = await engine.resume(def, params, journal, { token: opts.token, decision: opts.decision }, { runId, journal });
    } else {
      outcome = await engine.execute(def, params, { runId, journal });
    }

    // Terminal statuses → run row (journal-free stops already skipped
    // the engine's journal writes; here we only mirror the outcome).
    switch (outcome.status) {
      case 'complete':
        await this.options.store.updateStatus(runId, 'complete', null);
        await this.options.store.setWaitTill(runId, null);
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
    return outcome;
  }

  private toLaunchResult(outcome: EngineOutcome): LaunchResult {
    switch (outcome.status) {
      case 'complete':
        return { status: 'complete', runId: outcome.runId, outputs: outcome.outputs };
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
