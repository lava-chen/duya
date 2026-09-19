/**
 * trigger-files.test.ts — plan 552 Phase 6 gate: four trigger channels
 * with dedup idempotency (a hit never re-runs), channel gating against
 * the def's declared triggers, cron instant normalization, and the
 * workflow file registry (save-as / validated load).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  WorkflowManager,
  WorkflowFileRegistry,
  launchFromTrigger,
  normalizeCronInstant,
  buildDedupKey,
  channelAllowed,
  parseWorkflowDef,
  type WorkflowRunStoreLike,
  type ManagedRun,
  type WorkflowHost,
} from '../index.js';

// ─── fixtures (shared shape with manager.test.ts) ───

class MemoryRunStore implements WorkflowRunStoreLike {
  readonly runs = new Map<string, ManagedRun>();
  readonly blobs = new Map<string, { definition: unknown; nodeStack: unknown[]; journal: unknown[] }>();
  runsCreated = 0;

  async createRun(input: Parameters<WorkflowRunStoreLike['createRun']>[0]): Promise<ManagedRun> {
    this.runsCreated++;
    const run: ManagedRun = {
      id: input.id ?? `run-${this.runsCreated}`,
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
  async getRun(id: string) { return this.runs.get(id) ?? null; }
  async getRunByDedupKey(dedupKey: string) {
    for (const run of this.runs.values()) if (run.dedupKey === dedupKey) return run;
    return null;
  }
  async listRuns(filter?: { status?: string }) {
    return [...this.runs.values()].filter((r) => !filter?.status || r.status === filter.status);
  }
  async updateStatus(id: string, status: string, pauseMessage?: string | null) {
    const run = this.runs.get(id);
    if (!run) return false;
    run.status = status;
    run.pauseMessage = pauseMessage ?? null;
    return true;
  }
  async setWaitTill(id: string, waitTill: number | null) {
    const run = this.runs.get(id);
    if (!run) return false;
    run.waitTill = waitTill;
    return true;
  }
  async saveSnapshot(input: { runId: string; definition: unknown; nodeStack: unknown[]; journal: unknown[] }) {
    this.blobs.set(input.runId, { definition: input.definition, nodeStack: input.nodeStack, journal: input.journal });
  }
  async loadSnapshot(runId: string) {
    const blob = this.blobs.get(runId);
    return blob ? { runId, ...blob } : null;
  }
  async appendJournal(runId: string, record: unknown) {
    this.blobs.get(runId)?.journal.push(record);
  }
  async loadJournal(runId: string) { return this.blobs.get(runId)?.journal ?? []; }
  async listWaitingPast() { return []; }
}

function fixtureHost(): WorkflowHost & { agentCalls: string[] } {
  const agentCalls: string[] = [];
  return {
    agentCalls,
    async runAgent(spec) {
      agentCalls.push(spec.prompt);
      return { ok: true, output: `done:${spec.prompt}` };
    },
    async runTool() { return { ok: true, output: 'ok' }; },
    async requestApproval() { return { decision: 'approve' as const }; },
  };
}

const CRON_DEF = parseWorkflowDef({
  name: 'morning-digest',
  description: 'Daily digest',
  triggers: [{ cron: '0 9 * * 1-5' }, { http: { path: '/wf/digest' } }],
  phases: [{ phase: 'p', title: 'P', nodes: [{ id: 'a', agent: 'general-purpose', prompt: 'digest' }] }],
});

describe('trigger dedup idempotency (four channels)', () => {
  it('cron: the same fired minute dedups; a later tick runs anew', async () => {
    const store = new MemoryRunStore();
    const host = fixtureHost();
    const manager = new WorkflowManager({ host, store, secret: 's' });
    const fireAt = Date.UTC(2026, 8, 21, 1, 0, 0); // 09:00 +08

    const first = await launchFromTrigger(manager, {
      channel: 'cron', workflowName: 'morning-digest', cronFireAt: fireAt, def: CRON_DEF,
    });
    expect(first.status).toBe('complete');
    const callsAfterFirst = host.agentCalls.length;

    const replay = await launchFromTrigger(manager, {
      channel: 'cron', workflowName: 'morning-digest', cronFireAt: fireAt, def: CRON_DEF,
    });
    expect(replay.status).toBe('deduped');
    expect((replay as { dedupKey?: string }).dedupKey).toBe('cron:morning-digest:2026-09-21T01:00');
    expect(host.agentCalls.length).toBe(callsAfterFirst); // NO re-run

    // Seconds within the same minute still collide (normalized).
    const sameMinute = await launchFromTrigger(manager, {
      channel: 'cron', workflowName: 'morning-digest', cronFireAt: fireAt + 30_000, def: CRON_DEF,
    });
    expect(sameMinute.status).toBe('deduped');
  });

  it('bot: the inbound message id dedups redelivery', async () => {
    const store = new MemoryRunStore();
    const host = fixtureHost();
    const manager = new WorkflowManager({ host, store, secret: 's' });
    const def = parseWorkflowDef({
      ...CRON_DEF,
      triggers: [{ bot: { mention: true } }],
    });
    const first = await launchFromTrigger(manager, {
      channel: 'bot', workflowName: 'morning-digest', botMessageId: 'wecom-msg-1', def,
    });
    expect(first.status).toBe('complete');
    const replay = await launchFromTrigger(manager, {
      channel: 'bot', workflowName: 'morning-digest', botMessageId: 'wecom-msg-1', def,
    });
    expect(replay.status).toBe('deduped');
    expect(host.agentCalls.length).toBe(1);
  });

  it('http: the idempotency key dedups retries', async () => {
    const store = new MemoryRunStore();
    const host = fixtureHost();
    const manager = new WorkflowManager({ host, store, secret: 's' });
    const first = await launchFromTrigger(manager, {
      channel: 'http', workflowName: 'morning-digest', httpIdempotencyKey: 'req-abc', def: CRON_DEF,
    });
    expect(first.status).toBe('complete');
    const replay = await launchFromTrigger(manager, {
      channel: 'http', workflowName: 'morning-digest', httpIdempotencyKey: 'req-abc', def: CRON_DEF,
    });
    expect(replay.status).toBe('deduped');
  });

  it('manual runs carry no dedup key (deliberate re-invocation)', () => {
    expect(buildDedupKey({ channel: 'manual', workflowName: 'x' })).toBeUndefined();
  });

  it('channel gating: a def without the trigger rejects non-manual channels', async () => {
    const store = new MemoryRunStore();
    const manager = new WorkflowManager({ host: fixtureHost(), store, secret: 's' });
    const manualOnly = parseWorkflowDef({
      name: 'manual-only',
      description: 'x',
      phases: [{ phase: 'p', title: 'P', nodes: [{ id: 'a', noop: true }] }],
    });
    const res = await launchFromTrigger(manager, {
      channel: 'http', workflowName: 'manual-only', httpIdempotencyKey: 'k1', def: manualOnly,
    });
    expect(res.status).toBe('failed');
    expect((res as { error?: string }).error).toContain('does not declare a http trigger');
    expect(store.runsCreated).toBe(0); // rejected before any run row
  });

  it('normalizeCronInstant floors to minute precision', () => {
    expect(normalizeCronInstant(Date.UTC(2026, 8, 21, 1, 0, 59))).toBe('2026-09-21T01:00');
    expect(normalizeCronInstant(new Date(Date.UTC(2026, 8, 21, 1, 5, 0)))).toBe('2026-09-21T01:05');
  });
});

describe('WorkflowFileRegistry (save-as)', () => {
  it('saves, lists, deletes; load re-validates fully', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-registry-'));
    try {
      const registry = new WorkflowFileRegistry(dir);
      expect(registry.save(CRON_DEF)).toContain('morning-digest.yaml');
      expect(registry.list()).toEqual(['morning-digest']);
      const loaded = registry.load('morning-digest');
      expect(loaded.name).toBe('morning-digest');
      expect(loaded.triggers).toHaveLength(2);

      // Tampering fails LOUD on load (schema + semantics re-checked).
      fs.writeFileSync(
        path.join(dir, 'morning-digest.yaml'),
        'name: morning-digest\nphases: []\n',
        'utf8',
      );
      expect(() => registry.load('morning-digest')).toThrow(/failed validation/);

      expect(registry.delete('morning-digest')).toBe(true);
      expect(registry.exists('morning-digest')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid names (path safety)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-registry-'));
    try {
      const registry = new WorkflowFileRegistry(dir);
      expect(() => registry.load('../etc/passwd')).toThrow(/invalid workflow name/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
