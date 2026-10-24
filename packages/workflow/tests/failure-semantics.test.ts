import { describe, expect, it } from 'vitest';
import { WorkflowEngine, Journal, MemoryJournalSink, type WorkflowDef, type WorkflowHost, type WorkflowRuntimePorts } from '../src/index.js';
import { failureIsolationGraph } from './fixtures/graphs.js';

function testPorts(options: { now?: number; randomValues?: number[] } = {}): {
  ports: WorkflowRuntimePorts;
  sleeps: number[];
  now(): number;
} {
  let currentTime = options.now ?? 1_000;
  let randomIndex = 0;
  const randomValues = options.randomValues ?? [];
  const sleeps: number[] = [];
  let nextId = 0;
  return {
    ports: {
      clock: {
        nowMs: () => currentTime,
        sleep: async (ms) => { sleeps.push(ms); currentTime += ms; },
      },
      random: { next: () => randomValues[randomIndex++] ?? 0.5 },
      ids: { newId: () => `run-${++nextId}` },
      hash: { sha256: () => 'a'.repeat(64) },
      resumeTokens: { create: ({ runId, nodeId }) => `${runId}:${nodeId}`, verify: () => null },
    },
    sleeps,
    now: () => currentTime,
  };
}

function emptyHost(overrides: Partial<WorkflowHost> = {}): WorkflowHost {
  return {
    async runTool() { return { ok: true, output: 'ok' }; },
    async runAgent() { return { ok: true, output: 'ok' }; },
    async requestApproval() { return { decision: 'approve' }; },
    ...overrides,
  };
}

describe('@duya/workflow failure semantics', () => {
  it('blocks only the failed node dependency subtree and preserves independent results across phases', async () => {
    const calls: string[] = [];
    const host = emptyHost({
      async runTool(tool) {
        calls.push(tool);
        return tool === 'fragile'
          ? { ok: false, error: 'permanent tool failure', errorClass: 'tool_error' }
          : { ok: true, output: tool };
      },
    });
    const journal = new Journal(new MemoryJournalSink(), { nowMs: () => 1_000 });
    const engine = new WorkflowEngine({ host, ports: testPorts().ports });

    const outcome = await engine.execute(failureIsolationGraph, {}, { runId: 'branch-run', journal });

    expect(outcome).toMatchObject({ status: 'failed', nodeId: 'fragile', errorClass: 'tool_error' });
    expect(calls).toEqual(['fragile', 'steady', 'steady-child', 'later-steady']);
    expect(journal.all().find((record) => record.nodeId === 'steady'))
      .toMatchObject({ status: 'succeeded', result: 'steady' });
    expect(journal.all().filter((record) => record.errorClass === 'dependency_failed').map((record) => record.nodeId))
      .toEqual(['fragile-child', 'fragile-grandchild', 'later-dependent']);
    expect(journal.all().filter((record) => record.nodeId === 'later-steady')).toMatchObject([
      { status: 'succeeded', result: 'later-steady' },
    ]);
  });

  it('retries with exponential backoff and injected jitter at exact clock times', async () => {
    const timing = testPorts({ now: 1_000, randomValues: [0, 0.5] });
    const callTimes: number[] = [];
    let attempts = 0;
    const host = emptyHost({
      async runTool() {
        callTimes.push(timing.now());
        attempts++;
        if (attempts <= 2) return { ok: false, error: 'temporary service error', errorClass: 'transient' };
        return { ok: true, output: 'recovered' };
      },
    });
    const def: WorkflowDef = {
      name: 'retry-clock', description: 'Record the retry delay trajectory',
      phases: [{ phase: 'main', title: 'Main', nodes: [{ id: 'retry-node', tool: 'flaky', on_error: 'retry', max_retries: 2 }] }],
    };
    const journal = new Journal(new MemoryJournalSink(), { nowMs: timing.now });
    const engine = new WorkflowEngine({ host, ports: timing.ports });

    const outcome = await engine.execute(def, {}, { runId: 'retry-run', journal });

    expect(outcome.status).toBe('complete');
    expect(timing.sleeps).toEqual([125, 500]);
    expect(callTimes).toEqual([1_000, 1_125, 1_625]);
    expect(journal.all().filter((record) => record.nodeId === 'retry-node').map(({ status, atMs }) => [status, atMs]))
      .toEqual([['failed', 1_000], ['failed', 1_125], ['succeeded', 1_625]]);
  });

  it('keeps map budget exhaustion run-scoped and writes no replayable failed node record', async () => {
    const calls: string[] = [];
    const host = emptyHost({ async runTool() { calls.push('called'); return { ok: true }; } });
    const def: WorkflowDef = {
      name: 'map-budget', description: 'Budget exhaustion in fan-out must reach the run',
      params: [{ name: 'items', type: 'json', required: true }],
      phases: [{ phase: 'main', title: 'Main', nodes: [{
        id: 'fanout', tool: 'item-tool', map: { over: 'params.items', as: 'item', parallel: true },
      }] }],
    };
    const journal = new Journal(new MemoryJournalSink(), { nowMs: () => 1_000 });
    const engine = new WorkflowEngine({ host, ports: testPorts().ports, hostCallCap: 0 });

    const outcome = await engine.execute(def, { items: ['a', 'b', 'c'] }, { runId: 'budget-run', journal });

    expect(outcome).toMatchObject({ status: 'failed', errorClass: 'budget_exceeded' });
    expect(calls).toEqual([]);
    expect(journal.all().filter((record) => record.kind === 'node_result' && record.status === 'failed')).toEqual([]);
  });

  it('cancels without invoking nodes or writing a replayable failure record', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const host = emptyHost({ async runTool() { calls.push('called'); return { ok: true }; } });
    const def: WorkflowDef = {
      name: 'cancel', description: 'Do not execute after cancellation',
      phases: [{ phase: 'main', title: 'Main', nodes: [{ id: 'node', tool: 'tool' }] }],
    };
    const journal = new Journal(new MemoryJournalSink(), { nowMs: () => 1_000 });
    const engine = new WorkflowEngine({ host, ports: testPorts().ports, signal: controller.signal });

    const outcome = await engine.execute(def, {}, { runId: 'cancel-run', journal });

    expect(outcome).toMatchObject({ status: 'cancelled', runId: 'cancel-run' });
    expect(calls).toEqual([]);
    expect(journal.all().filter((record) => record.kind === 'node_result' && record.status === 'failed')).toEqual([]);
  });
});
