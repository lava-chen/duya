import { describe, expect, it } from 'vitest';
import { WorkflowEngine, type WorkflowDef, type WorkflowHost, type WorkflowRuntimePorts } from '../src/index.js';
import { AimdConcurrencyGovernor, ConcurrencyGate, ProviderGovernorRegistry } from '../src/scheduler.js';
import { concurrencyRetuneGraph } from './fixtures/graphs.js';

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T extends void ? undefined : T): void } {
  let resolve!: (value: T extends void ? undefined : T) => void;
  const promise = new Promise<T>((done) => { resolve = done as typeof resolve; });
  return { promise, resolve: (value) => resolve(value) };
}

function runtimePorts(): WorkflowRuntimePorts {
  let id = 0;
  return {
    clock: { nowMs: () => 100, sleep: async () => {} },
    random: { next: () => 0.5 },
    ids: { newId: () => `workflow-${++id}` },
    hash: { sha256: () => '0123456789abcdef'.repeat(4) },
    resumeTokens: {
      create: ({ runId, nodeId }) => `${runId}:${nodeId}`,
      verify: () => null,
    },
  };
}

const phase = (nodes: WorkflowDef['phases'][number]['nodes']): WorkflowDef => ({
  name: 'scheduler-fixture',
  description: 'Scheduler graph fixture',
  phases: [{ phase: 'main', title: 'Main', nodes }],
});

describe('@duya/workflow scheduler', () => {
  it('does not over-admit a queued task when a permit is released', async () => {
    const gate = new ConcurrencyGate(1);
    const releaseFirst = await gate.acquire();
    const waiting = gate.acquire();
    releaseFirst();
    const competing = gate.acquire();
    const releaseWaiting = await waiting;
    expect(gate.active).toBe(1);
    releaseWaiting();
    const releaseCompeting = await competing;
    expect(gate.active).toBe(1);
    releaseCompeting();
    expect(gate.active).toBe(0);
  });

  it('dispatches independent nodes together and applies live retune without restarting in-flight work', async () => {
    const aStarted = deferred();
    const bStarted = deferred();
    const cStarted = deferred();
    const aDone = deferred();
    const releaseA = deferred();
    const releaseB = deferred();
    const releaseC = deferred();
    const calls: string[] = [];
    const concurrencyTrace: string[] = [];
    let active = 0;
    let peakConcurrency = 0;
    const start = (tool: string): void => {
      active++;
      peakConcurrency = Math.max(peakConcurrency, active);
      calls.push(tool);
      concurrencyTrace.push(`start:${tool}:${active}`);
    };
    const finish = (tool: string): void => {
      active--;
      concurrencyTrace.push(`finish:${tool}:${active}`);
    };
    const host: WorkflowHost = {
      async runTool(tool) {
        start(tool);
        if (tool === 'a') { aStarted.resolve(undefined); await releaseA.promise; finish(tool); aDone.resolve(undefined); }
        if (tool === 'b') { bStarted.resolve(undefined); await releaseB.promise; finish(tool); }
        if (tool === 'c') { cStarted.resolve(undefined); await releaseC.promise; finish(tool); }
        return { ok: true, output: tool };
      },
      async runAgent() { return { ok: true }; },
      async requestApproval() { return { decision: 'approve' }; },
    };
    const events: Array<{ type: string; current?: number }> = [];
    const engine = new WorkflowEngine({
      host,
      ports: runtimePorts(),
      maxConcurrency: 2,
      onObservation: (event) => events.push(event),
    });
    const run = engine.execute(concurrencyRetuneGraph, {}, { runId: 'fixed-run' });
    await Promise.all([aStarted.promise, bStarted.promise]);
    expect(calls).toEqual(['a', 'b']);
    expect(peakConcurrency).toBe(2);
    expect(active).toBe(2);

    engine.setMaxConcurrency(1, 'fixed-run');
    expect(events).toEqual([{ type: 'concurrency-changed', runId: 'fixed-run', previous: 2, current: 1 }]);
    releaseA.resolve(undefined);
    await aDone.promise;
    await Promise.resolve();
    expect(calls).toEqual(['a', 'b']);
    expect(active).toBe(1); // retuning does not cancel already-admitted work

    releaseB.resolve(undefined);
    await cStarted.promise;
    releaseC.resolve(undefined);
    const outcome = await run;
    expect(outcome).toMatchObject({ status: 'complete', runId: 'fixed-run' });
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(peakConcurrency).toBe(2);
    expect(concurrencyTrace).toEqual([
      'start:a:1', 'start:b:2', 'finish:a:1', 'finish:b:0', 'start:c:1', 'finish:c:0',
    ]);
  });

  it('reports a numeric additive increase and multiplicative decrease trace', async () => {
    const trace = [4];
    const changes: string[] = [];
    const governor = new AimdConcurrencyGovernor({
      initialLimit: 4,
      maxLimit: 8,
      increaseEvery: 4,
      onChange: ({ current, cause }) => { trace.push(current); changes.push(cause); },
    });
    governor.recordSuccess();
    governor.recordSuccess();
    governor.recordSuccess();
    governor.recordSuccess();
    governor.recordCongestion();
    governor.recordSuccess();
    governor.recordSuccess();
    governor.recordSuccess();
    governor.recordSuccess();

    expect(trace).toEqual([4, 5, 2, 3]);
    expect(changes).toEqual(['success', 'congestion', 'success']);
    const result = await governor.run(async () => 'ok', () => false);
    expect(result).toBe('ok');

    const registry = new ProviderGovernorRegistry(() => ({ initialLimit: 2 }));
    expect(registry.forProvider('provider-a')).toBe(registry.forProvider('provider-a'));
    expect(registry.forProvider('provider-a')).not.toBe(registry.forProvider('provider-b'));
  });

  it('reduces a provider window when the Host returns a transient provider result', async () => {
    const governor = new AimdConcurrencyGovernor({ initialLimit: 4 });
    const result = await governor.run(
      async () => ({ ok: false, errorClass: 'transient' }),
      (value) => Boolean(value && typeof value === 'object' && 'errorClass' in value && value.errorClass === 'transient'),
      (value) => value.ok,
    );
    expect(result.ok).toBe(false);
    expect(governor.limit).toBe(2);
  });

  it('emits run-stalled when an invalid graph has pending nodes and no ready work', async () => {
    const events: Array<{ type: string; pendingNodeIds?: string[] }> = [];
    const host: WorkflowHost = {
      async runTool(tool) { return { ok: true, output: tool }; },
      async runAgent() { return { ok: true }; },
      async requestApproval() { return { decision: 'approve' }; },
    };
    const engine = new WorkflowEngine({ host, ports: runtimePorts(), onObservation: (event) => events.push(event) });
    const outcome = await engine.execute(phase([
      { id: 'node-a', tool: 'a', when: 'node-b.succeeded == true' },
      { id: 'node-b', tool: 'b', when: 'node-a.succeeded == true' },
    ]), {}, { runId: 'stalled-run' });

    expect(outcome).toMatchObject({ status: 'failed', errorClass: 'scheduler_stalled' });
    expect(events).toEqual([{ type: 'run-stalled', runId: 'stalled-run', phase: 'main', pendingNodeIds: ['node-a', 'node-b'], settledNodeIds: [] }]);
  });
});
