/**
 * dag-concurrency.test.ts — same-layer DAG scheduling (card 622-07).
 *
 * The engine used to run `topoSort(phase.nodes)` node by node: a linear
 * order that can only be executed one after another. The scheduler now
 * runs a phase as Kahn LAYERS — every node in a layer is independent of
 * its siblings, so their host calls may interleave; nodes in later layers
 * still wait for the layer below.
 *
 * Three things are locked here, and each of them has teeth:
 *   1. two independent siblings in one layer MUST interleave,
 *   2. two nodes that DO depend on each other MUST stay serial,
 *   3. the number of concurrent host calls MUST stay within
 *      `options.concurrency` (the shared `Semaphore`).
 *
 * Case 2 is the control group: without it, "faster" would also pass case 1.
 */

import { describe, it, expect } from 'vitest';
import {
  WorkflowEngine,
  parseWorkflowDef,
  type WorkflowHost,
  type HostCallContext,
} from '../../src/worker-workflows/index.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Call key of one host invocation (map items carry their item index). */
function callKey(ctx: HostCallContext): string {
  return ctx.itemIndex === undefined ? ctx.nodeId : `${ctx.nodeId}#${ctx.itemIndex}`;
}

/**
 * Fake host that records the call sequence and keeps every call open
 * until `gateOn` distinct calls are in flight. The `holdMs` fallback
 * keeps a serial executor from hanging — it is slow, not broken.
 */
function tracingHost(gateOn: number, holdMs: number): {
  host: WorkflowHost;
  events: string[];
  inputs: Map<string, unknown>;
  peak: () => number;
} {
  const events: string[] = [];
  const inputs = new Map<string, unknown>();
  const started = new Set<string>();
  let inFlight = 0;
  let peak = 0;
  let open: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  const track = async (ctx: HostCallContext): Promise<void> => {
    const key = callKey(ctx);
    events.push(`start:${key}`);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    started.add(key);
    if (started.size >= gateOn) open?.();
    await Promise.race([gate, delay(holdMs)]);
    inFlight -= 1;
    events.push(`end:${key}`);
  };

  const host: WorkflowHost = {
    async runTool(_tool, input, ctx) {
      inputs.set(callKey(ctx), input);
      await track(ctx);
      return { ok: true, output: `out:${callKey(ctx)}` };
    },
    async runAgent(_spec, ctx) {
      await track(ctx);
      return { ok: true, output: `out:${callKey(ctx)}` };
    },
    async requestApproval() {
      return { decision: 'approve' };
    },
  };

  return { host, events, inputs, peak: () => peak };
}

/**
 * Interleaving ⇔ the second call starts BEFORE the first one ends.
 * "Both nodes ran" is NOT interleaving — this is the distinguishing
 * predicate the whole card hinges on.
 */
function interleaved(events: string[]): boolean {
  const secondStart = events.findIndex((e, i) => i > 0 && e.startsWith('start:'));
  if (secondStart === -1) return false;
  const firstEnd = events.findIndex((e) => e.startsWith('end:'));
  return firstEnd === -1 || secondStart < firstEnd;
}

// ─── fixtures ───

const INDEPENDENT_DEF = parseWorkflowDef({
  name: 'independent-siblings',
  description: 'two nodes without dependencies in one phase',
  phases: [
    {
      phase: 'work',
      title: 'Work',
      nodes: [
        { id: 'alpha', tool: 'work.alpha' },
        { id: 'beta', tool: 'work.beta' },
      ],
    },
  ],
});

const DEPENDENT_DEF = parseWorkflowDef({
  name: 'dependent-siblings',
  description: 'the second node consumes the first node output',
  phases: [
    {
      phase: 'work',
      title: 'Work',
      nodes: [
        { id: 'alpha', tool: 'work.alpha' },
        { id: 'beta', tool: 'work.beta', input: { seed: '${alpha.output}' } },
      ],
    },
  ],
});

// ─── cases ───

describe('same-layer DAG scheduling (card 622-07)', () => {
  it('interleaves two independent sibling nodes in the same layer', async () => {
    const { host, events } = tracingHost(2, 50);
    const engine = new WorkflowEngine({ host });
    const outcome = await engine.execute(INDEPENDENT_DEF, {});
    expect(outcome.status).toBe('complete');
    expect(events).toHaveLength(4);
    expect(
      interleaved(events),
      `the two independent siblings must overlap, got ${events.join(' -> ')}`,
    ).toBe(true);
  });

  it('keeps two dependent nodes serial inside one phase (control group)', async () => {
    const { host, events, inputs } = tracingHost(2, 50);
    const engine = new WorkflowEngine({ host });
    const outcome = await engine.execute(DEPENDENT_DEF, {});
    expect(outcome.status).toBe('complete');
    // beta reads ${alpha.output} → it depends on alpha → different layer.
    expect(events).toEqual(['start:alpha', 'end:alpha', 'start:beta', 'end:beta']);
    expect(
      interleaved(events),
      `a dependent node must not start before its dependency finished, got ${events.join(' -> ')}`,
    ).toBe(false);
    // …and beta really consumed alpha's output (it ran after alpha).
    expect(inputs.get('beta')).toEqual({ seed: 'out:alpha' });
  });

  it('caps same-layer concurrency at options.concurrency', async () => {
    const def = parseWorkflowDef({
      name: 'capped-layer',
      description: 'five independent nodes, concurrency of two',
      phases: [
        {
          phase: 'work',
          title: 'Work',
          nodes: [
            { id: 'one', tool: 'work.one' },
            { id: 'two', tool: 'work.two' },
            { id: 'three', tool: 'work.three' },
            { id: 'four', tool: 'work.four' },
            { id: 'five', tool: 'work.five' },
          ],
        },
      ],
    });
    const { host, peak } = tracingHost(Number.MAX_SAFE_INTEGER, 5);
    const engine = new WorkflowEngine({ host, concurrency: 2 });
    const outcome = await engine.execute(def, {});
    expect(outcome.status).toBe('complete');
    // Never more than the configured limit …
    expect(peak()).toBeLessThanOrEqual(2);
    // … and not silently serial either.
    expect(peak()).toBe(2);
  });

  it('keeps map fan-out parallel and deadlock-free at concurrency 1', async () => {
    const def = parseWorkflowDef({
      name: 'map-parallel',
      description: 'map items keep their own parallelism',
      params: [{ name: 'items', type: 'json', required: true }],
      phases: [
        {
          phase: 'work',
          title: 'Work',
          nodes: [
            {
              id: 'fanout',
              agent: 'general-purpose',
              prompt: 'handle ${item}',
              map: { over: 'params.items', as: 'item' },
            },
          ],
        },
      ],
    });

    // The map node must NOT hold a node-level semaphore slot: its items
    // take slots themselves, and holding one would deadlock at limit 1.
    const serial = tracingHost(Number.MAX_SAFE_INTEGER, 1);
    const serialEngine = new WorkflowEngine({ host: serial.host, concurrency: 1 });
    const serialOutcome = await serialEngine.execute(def, { items: ['a', 'b', 'c'] });
    expect(serialOutcome.status).toBe('complete');
    expect(serial.events).toHaveLength(6);

    // The map parallelism itself is unchanged: the items still overlap.
    const parallel = tracingHost(3, 20);
    const parallelEngine = new WorkflowEngine({ host: parallel.host });
    const parallelOutcome = await parallelEngine.execute(def, { items: ['a', 'b', 'c'] });
    expect(parallelOutcome.status).toBe('complete');
    expect(parallel.peak()).toBe(3);
  });
});
