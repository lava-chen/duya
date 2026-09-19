/**
 * manager.test.ts — plan 552 Phase 4 gate: kill -9 recovery (crash
 * reconciliation → interrupted → resume replays the journal cache →
 * complete), dedup idempotency, wait-tracker timeout application, and
 * journal dual-write persistence.
 */

import { describe, it, expect } from 'vitest';
import {
  WorkflowManager,
  Journal,
  MemoryJournalSink,
  parseWorkflowDef,
  type WorkflowRunStoreLike,
  type ManagedRun,
  type JournalRecord,
  type WorkflowHost,
  computeReqHash,
  createResumeToken,
} from '../index.js';

// ─── in-memory store fake (mirrors the core-db store semantics) ───

class MemoryRunStore implements WorkflowRunStoreLike {
  readonly runs = new Map<string, ManagedRun>();
  readonly blobs = new Map<string, { definition: unknown; nodeStack: unknown[]; journal: unknown[] }>();

  async createRun(input: Parameters<WorkflowRunStoreLike['createRun']>[0]): Promise<ManagedRun> {
    const run: ManagedRun = {
      id: input.id ?? `run-${this.runs.size + 1}`,
      workflowName: input.workflowName,
      workflowVersionId: input.workflowVersionId ?? null,
      status: input.status ?? 'inactive',
      triggerKind: input.triggerKind ?? null,
      dedupKey: input.dedupKey ?? null,
      params: input.params ?? {},
      waitTill: null,
      retryOf: input.retryOf ?? null,
      pauseMessage: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.runs.set(run.id, run);
    return run;
  }

  async getRun(id: string): Promise<ManagedRun | null> {
    return this.runs.get(id) ?? null;
  }

  async getRunByDedupKey(dedupKey: string): Promise<ManagedRun | null> {
    for (const run of this.runs.values()) if (run.dedupKey === dedupKey) return run;
    return null;
  }

  async listRuns(filter?: { status?: string }): Promise<ManagedRun[]> {
    return [...this.runs.values()].filter((r) => !filter?.status || r.status === filter.status);
  }

  async updateStatus(id: string, status: string, pauseMessage?: string | null): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run) return false;
    run.status = status;
    run.pauseMessage = pauseMessage ?? null;
    run.updatedAt = Date.now();
    return true;
  }

  async setWaitTill(id: string, waitTill: number | null): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run) return false;
    run.waitTill = waitTill;
    return true;
  }

  async saveSnapshot(input: { runId: string; definition: unknown; nodeStack: unknown[]; journal: unknown[] }): Promise<void> {
    this.blobs.set(input.runId, { definition: input.definition, nodeStack: input.nodeStack, journal: input.journal });
  }

  async loadSnapshot(runId: string) {
    const blob = this.blobs.get(runId);
    return blob ? { runId, ...blob } : null;
  }

  async appendJournal(runId: string, record: unknown): Promise<void> {
    const blob = this.blobs.get(runId);
    if (blob) blob.journal.push(record);
  }

  async loadJournal(runId: string): Promise<unknown[]> {
    return this.blobs.get(runId)?.journal ?? [];
  }

  async listWaitingPast(now: number): Promise<ManagedRun[]> {
    return [...this.runs.values()].filter((r) => r.waitTill !== null && r.waitTill <= now && r.status === 'blocked');
  }
}

function fixtureHost(): WorkflowHost & { agentCalls: string[] } {
  const agentCalls: string[] = [];
  return {
    agentCalls,
    async runAgent(spec) {
      agentCalls.push(spec.prompt);
      return { ok: true, output: `done:${spec.prompt}` };
    },
    async runTool() {
      return { ok: true, output: 'tool-ok' };
    },
    async requestApproval() {
      return { decision: 'approve' as const };
    },
  };
}

const WF_DEF = parseWorkflowDef({
  name: 'kill-recovery',
  description: 'two agent nodes then an approval gate',
  phases: [
    {
      phase: 'work',
      title: 'Work',
      nodes: [
        { id: 'a1', agent: 'general-purpose', prompt: 'step one' },
        { id: 'a2', agent: 'general-purpose', prompt: 'step two' },
        {
          id: 'gate',
          human: { prompt: 'Ship it?', timeout: { hours: 1, on_timeout: 'fail' } },
        },
      ],
    },
  ],
});

const SECRET = 'test-secret';

describe('WorkflowManager — kill -9 recovery (plan 552 Phase 4 gate)', () => {
  it('suspend → crash reconcile → interrupted → resume replays cache → complete', async () => {
    const store = new MemoryRunStore();
    const host = fixtureHost();
    const manager = new WorkflowManager({ host, store, secret: SECRET, approvalMode: 'suspend' });

    // 1. Launch: both agent nodes run, the gate parks the run.
    const first = await manager.launch({ def: WF_DEF, params: {} });
    expect(first.status).toBe('waiting');
    if (first.status !== 'waiting') return;
    expect(host.agentCalls).toEqual(['step one', 'step two']);

    // 2. Simulated kill -9: a NEW manager instance (fresh in-flight set),
    // same store. The parked run is a DURABLE park — reconciliation must
    // NOT touch it (it resumes as-is; §6.2 only orphans RUNNING-class runs).
    const crashedManager = new WorkflowManager({ host, store, secret: SECRET, approvalMode: 'suspend' });
    const stale = await crashedManager.reconcile();
    expect(stale).toEqual([]);
    expect((await store.getRun(first.runId))?.status).toBe('blocked');

    // 3. Resume: journal cache replays a1/a2 (NO new host calls), the
    // approval lands, the run completes.
    const second = await crashedManager.resume(first.runId, {
      token: first.resumeToken,
      decision: 'approve',
    });
    expect(second.status).toBe('complete');
    if (second.status !== 'complete') return;
    expect(second.outputs.a2).toBe('done:step two');
    expect(second.outputs.gate).toMatchObject({ approved: true });
    expect(host.agentCalls).toEqual(['step one', 'step two']); // cache hit — zero re-pay
    expect((await store.getRun(first.runId))?.status).toBe('complete');
  });

  it('mid-execution crash: orphaned active run → interrupted → resume replays its cache', async () => {
    const store = new MemoryRunStore();
    const host = fixtureHost();
    const manager = new WorkflowManager({ host, store, secret: SECRET, approvalMode: 'suspend' });

    // Simulate a process death mid-run: an 'active' run whose journal
    // holds a1's succeeded record (persisted before the crash).
    const run = await store.createRun({ workflowName: WF_DEF.name, status: 'active', params: {} });
    await store.saveSnapshot({ runId: run.id, definition: WF_DEF, nodeStack: [], journal: [] });
    const a1Hash = computeReqHash('node_result', {
      agent: 'general-purpose',
      prompt: 'step one',
      model: undefined,
      item: undefined,
    });
    await store.appendJournal(run.id, {
      seq: 0, kind: 'node_result', nodeId: 'a1', attempt: 1, reqHash: a1Hash,
      status: 'succeeded', result: 'done:step one', atMs: Date.now(),
    } as JournalRecord);

    // Reconciliation sees an active run the (new) engine is NOT running.
    const stale = await manager.reconcile();
    expect(stale.map((s) => s.runId)).toEqual([run.id]);
    expect((await store.getRun(run.id))?.status).toBe('interrupted');

    // Resume replays a1 from the journal cache (zero re-pay) and finishes.
    const token = createResumeToken(SECRET, { runId: run.id, nodeId: 'gate', issuedAt: Date.now() });
    const result = await manager.resume(run.id, { token, decision: 'approve' });
    expect(result.status).toBe('complete');
    expect(host.agentCalls).toEqual(['step two']); // a1 cached, a2 truly ran
  });

  it('journal records dual-write into the snapshot blob as they happen', async () => {
    const store = new MemoryRunStore();
    const host = fixtureHost();
    const manager = new WorkflowManager({ host, store, secret: SECRET, approvalMode: 'suspend' });
    const progress: Array<{ runId: string; kind: string }> = [];
    const manager2 = new WorkflowManager({
      host,
      store,
      secret: SECRET,
      approvalMode: 'suspend',
      onProgress: (record, runId) => progress.push({ runId, kind: record.kind }),
    });
    void manager;
    const result = await manager2.launch({ def: WF_DEF, params: {} });
    if (result.status !== 'waiting') throw new Error(`expected waiting, got ${result.status}`);
    const persisted = (await store.loadJournal(result.runId)) as JournalRecord[];
    expect(persisted.length).toBeGreaterThan(2);
    expect(persisted.some((r) => r.kind === 'phase' && r.status === 'running')).toBe(true);
    expect(persisted.some((r) => r.kind === 'node_result' && r.nodeId === 'a1' && r.status === 'succeeded')).toBe(true);
    expect(progress.length).toBe(persisted.length);
  });

  it('dedup key returns the existing run without executing', async () => {
    const store = new MemoryRunStore();
    const host = fixtureHost();
    const manager = new WorkflowManager({ host, store, secret: SECRET, approvalMode: 'await' });
    const key = 'cron:2026-09-20T09:00';
    const first = await manager.launch({ def: WF_DEF, dedupKey: key });
    const callsAfterFirst = host.agentCalls.length;
    const second = await manager.launch({ def: WF_DEF, dedupKey: key });
    expect(second.status).toBe('deduped');
    if (first.status !== 'deduped') {
      expect((second as { runId: string }).runId).toBe((first as { runId: string }).runId);
    }
    expect(host.agentCalls.length).toBe(callsAfterFirst); // no re-execution
  });

  it('wait-tracker tick applies on_timeout=fail to parked runs', async () => {
    const store = new MemoryRunStore();
    const host = fixtureHost();
    const manager = new WorkflowManager({ host, store, secret: SECRET, approvalMode: 'suspend' });
    const result = await manager.launch({ def: WF_DEF, params: {} });
    if (result.status !== 'waiting') throw new Error('expected waiting');
    // Force the parked deadline into the past (simulated 60s tick).
    await store.setWaitTill(result.runId, Date.now() - 1000);
    const applied = await manager.tickWaitTracker();
    expect(applied.map((a) => a.runId)).toContain(result.runId);
    const run = await store.getRun(result.runId);
    expect(run?.status).toBe('failed'); // on_timeout: fail beats a leaking suspension
  });

  it('high-risk plan stops at awaiting_confirm until confirmLaunch (Phase 5)', async () => {
    const store = new MemoryRunStore();
    const host = fixtureHost();
    let wokeWith: { runId: string; status: string } | undefined;
    const manager = new WorkflowManager({
      host,
      store,
      secret: SECRET,
      approvalMode: 'await',
      onRunFinished: (runId, outcome) => {
        wokeWith = { runId, status: outcome.status };
      },
    });

    const plan = {
      def: WF_DEF,
      highRiskNodes: ['gate'],
      warnings: [],
    };
    const gated = await manager.launchFromPlan(plan, { params: {} });
    expect(gated.status).toBe('awaiting_confirm');
    if (gated.status !== 'awaiting_confirm') return;
    expect((await store.getRun(gated.runId))?.status).toBe('awaiting_confirm');
    expect(host.agentCalls).toEqual([]); // nothing executed

    // Confirm → executes → completes → auto-wake hook fired.
    const done = await manager.confirmLaunch(gated.runId);
    expect(done.status).toBe('complete');
    expect(host.agentCalls).toEqual(['step one', 'step two']);
    expect(wokeWith).toMatchObject({ runId: gated.runId, status: 'complete' });
  });

  it('verify stage annotates the completed run (Phase 5)', async () => {
    const store = new MemoryRunStore();
    const host = fixtureHost();
    const manager = new WorkflowManager({
      host,
      store,
      secret: SECRET,
      approvalMode: 'await',
      verify: { acceptanceCriteria: 'steps one and two ran' },
    });
    const result = await manager.launch({ def: WF_DEF, params: {} });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.verification).toBeDefined();
    expect(result.verification?.verification).toBe('verified');
  });

  it('cancel marks an idle parked run cancelled', async () => {
    const store = new MemoryRunStore();
    const host = fixtureHost();
    const manager = new WorkflowManager({ host, store, secret: SECRET, approvalMode: 'suspend' });
    const result = await manager.launch({ def: WF_DEF, params: {} });
    if (result.status !== 'waiting') throw new Error('expected waiting');
    const ok = await manager.cancel(result.runId);
    expect(ok).toBe(true);
    expect((await store.getRun(result.runId))?.status).toBe('cancelled');
  });
});
