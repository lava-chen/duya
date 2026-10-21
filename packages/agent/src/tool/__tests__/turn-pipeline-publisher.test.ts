/**
 * Plan 600 S2 (inversion step 1) -- the per-turn pipeline publication, and the
 * cost of getting it wrong.
 *
 * ## What this pins
 *
 * `TurnPipelinePublisher` is the answer to "the engine cannot reach the
 * pipeline, so `queueTool` throws". It gives the worker entry the CURRENT turn's
 * pipeline while keeping the pipeline itself per-turn and un-hoisted (see
 * `tool-pipeline-turn-lifetime.test.ts` for why hoisting is wrong).
 *
 * The property worth a test is not "the tool arrives" — that is one line — but
 * that publishing is not a FREE pass. The failure this whole slice exists to
 * avoid is SILENT: a tool the model asked for, buffered into a pipeline that can
 * never run it, with no error anywhere. So each test below asserts that the
 * wrong turn is REFUSED, loudly and distinguishably, because a refusal is
 * something the engine turns into a failed run (`run-engine.ts:454-457`) instead
 * of a hole in the context.
 *
 * ## Why these are not `a === a`
 *
 * The three refusals are asserted on MESSAGES that name three different causes
 * (no turn / run over / turn discarded), and the reachability test asserts an
 * observable effect: the tool actually RAN. A publisher that swallowed, or that
 * routed to the wrong instance, cannot satisfy both. Test 4 is the contrast that
 * keeps tests 2 and 3 honest — it proves the harness can tell a live pipeline
 * from a dead one, so an empty drain in 2 or 3 cannot be a broken fixture.
 *
 * ## The mutation these are proven against
 *
 * Turning the refusals into no-ops — `queue` that dispatches whenever a pipeline
 * is merely PRESENT, ignoring both `close()` and `isUsable()`. That is the
 * "tidying" change a later slice would make while binding the model port, and it
 * is the one that must turn this file red.
 */

import { describe, expect, it } from 'vitest';
import { TurnPipelinePublisher } from '../turn-pipeline-publisher.js';
import { ToolExecutionPipeline } from '../ToolExecutionPipeline.js';
import { ToolRegistry } from '../registry.js';
import type { MessageUpdate } from '../StreamingToolExecutor.js';
import type { AppState, Tool, ToolResult, ToolUse, ToolUseContext } from '../../types.js';

const PROBE = 'publisher_probe';

/** A registry with one counting tool, shared by every test below. */
function makeRegistry(runs: { count: number }): ToolRegistry {
  const registry = new ToolRegistry();
  const definition: Tool = {
    name: PROBE,
    description: 'Records that it ran, and says so.',
    input_schema: { type: 'object', properties: {} },
  };
  registry.register(definition, {
    execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
      runs.count += 1;
      return { id: String(input.id ?? 'none'), name: PROBE, result: `ran:${runs.count}` };
    },
  });
  return registry;
}

function makeContext(): ToolUseContext {
  let state: AppState = {};
  return {
    toolUseId: 'publisher-ctx',
    getAppState: () => state,
    setAppState: (f) => {
      state = f(state);
    },
    abortController: new AbortController(),
    options: {},
  };
}

function use(id: string): ToolUse {
  return { id, name: PROBE, input: { id } };
}

function pipelineFor(runs: { count: number }): ToolExecutionPipeline {
  return new ToolExecutionPipeline(makeRegistry(runs), async () => true, makeContext());
}

/** Drain a pipeline the way the legacy loop does, collecting result texts. */
async function drainResults(pipeline: ToolExecutionPipeline): Promise<string[]> {
  const texts: string[] = [];
  for await (const update of pipeline.getRemainingResults() as AsyncIterable<MessageUpdate>) {
    const content = update.message?.content;
    if (typeof content === 'string') texts.push(content);
  }
  return texts;
}

describe('TurnPipelinePublisher routes to the live turn and refuses the others', () => {
  it('hands a tool to the turn that published, and it runs', async () => {
    // The mechanism working: an engine dispatch reaches the real pipeline, and
    // the tool's effect is observable rather than merely buffered.
    const runs = { count: 0 };
    const publisher = new TurnPipelinePublisher();
    const pipeline = pipelineFor(runs);
    publisher.publish(1, pipeline);

    expect(publisher.currentTurn()).toBe(1);
    publisher.queue(use('a1'));

    expect(await drainResults(pipeline)).toHaveLength(1);
    expect(runs.count).toBe(1);
  });

  it('REFUSES a dispatch when no turn has published a pipeline', () => {
    // The case the old `queueTool` covered by refusing everything: the engine
    // dispatched before `streamChat` reached its first turn. A tool dropped here
    // is a hole in the model's context, so it must throw.
    const publisher = new TurnPipelinePublisher();

    expect(() => publisher.queue(use('a2'))).toThrow(/no turn has published a pipeline/);
  });

  it('REFUSES a dispatch after the run is closed, and refuses a late publish', () => {
    // The stale-turn case at run granularity. Once `close()` has run, the turn
    // that owned the pipeline is gone; reaching for it now would be a dispatch
    // into a turn that finished. The message must differ from the "never
    // published" one, because a dispatch that arrived too early and one that
    // arrived too late are different bugs.
    const runs = { count: 0 };
    const publisher = new TurnPipelinePublisher();
    const pipeline = pipelineFor(runs);
    publisher.publish(1, pipeline);

    publisher.close();

    expect(() => publisher.queue(use('a3'))).toThrow(/this run has ended/);
    // A turn that starts after the close cannot resurrect the publication.
    expect(() => publisher.publish(2, pipelineFor(runs))).toThrow(/publication is closed/);
    expect(runs.count).toBe(0);
  });

  it('REFUSES a dispatch into a turn whose pipeline was discarded', async () => {
    // THE silent failure this slice exists to prevent. A discarded pipeline
    // still ACCEPTS `addTool` -- it buffers, computes nothing, and its drain
    // yields nothing. Queueing into it would be exactly the mute hoisted
    // instance, one turn later and for a new reason.
    const runs = { count: 0 };
    const publisher = new TurnPipelinePublisher();
    const pipeline = pipelineFor(runs);
    publisher.publish(2, pipeline);

    // The state the loop reaches on a model-stream retry (`DuyaAgent.ts:2359`).
    pipeline.discard();

    expect(() => publisher.queue(use('a4'))).toThrow(
      /turn 2's pipeline has been discarded, so the call would be buffered and never run/,
    );

    // Nothing ran, and nothing was left buffered either.
    expect(await drainResults(pipeline)).toEqual([]);
    expect(runs.count).toBe(0);
  });

  it('routes to the NEW turn after a supersede, never to the discarded old one', async () => {
    // What "per turn, published" has to mean in practice: a second turn gets a
    // second pipeline, and the first turn's dead instance stops being reachable.
    // This is the hoisting test in its positive form — the publisher is what
    // makes a per-turn rebuild viable from outside the generator.
    const runs = { count: 0 };
    const publisher = new TurnPipelinePublisher();
    const first = pipelineFor(runs);
    publisher.publish(1, first);
    first.discard();

    const second = pipelineFor(runs);
    publisher.publish(2, second);
    expect(publisher.currentTurn()).toBe(2);

    publisher.queue(use('a5'));

    // The live turn's pipeline ran it.
    expect(await drainResults(second)).toHaveLength(1);
    expect(runs.count).toBe(1);
    // And the dead one ran nothing, rather than being the one reached.
    expect(await drainResults(first)).toEqual([]);
  });

  it('a live pipeline is distinguishable from a dead one', async () => {
    // The contrast that keeps the refusals above honest. Same registry, same
    // context, same tool, one pipeline each -- the ONLY difference is the
    // `discard()`. If this one also drained nothing, the empty drains above
    // would be a broken harness rather than the latch.
    const runs = { count: 0 };
    const dead = pipelineFor(runs);
    dead.discard();
    const live = pipelineFor(runs);

    expect(dead.isUsable()).toBe(false);
    expect(live.isUsable()).toBe(true);

    live.addTool(use('a6'));
    expect(await drainResults(live)).toHaveLength(1);
    expect(runs.count).toBe(1);
  });
});

// ============================================================================
// drain() / discard(): the route, and the per-turn lifetime it has to protect
//
// Added in plan 610 A3-2b2. `queue` alone is not a tool leg: without a route to
// `getRemainingResults` the composition could only take a host's own handle on
// the live executor, and a handle CAN be held across turns. That is the whole
// hazard, and it is measured rather than theoretical -- see below.
// ============================================================================

/** Drain THROUGH THE PUBLISHER, counting results. The route under test. */
async function drainThroughPublisher(publisher: TurnPipelinePublisher): Promise<string[]> {
  const texts: string[] = [];
  for await (const update of publisher.drain()) {
    const content = update.message?.content;
    if (typeof content === 'string') texts.push(content);
  }
  return texts;
}

describe('TurnPipelinePublisher.drain is a route with a per-turn lifetime', () => {
  it('drains the published turn, and the tool really ran', async () => {
    const runs = { count: 0 };
    const publisher = new TurnPipelinePublisher();
    publisher.publish(1, pipelineFor(runs));

    publisher.queue(use('d1'));

    // Not "the tool arrives" -- the effect is observable, so a drain wired to a
    // mute or discarded instance fails here rather than passing on structure.
    expect(await drainThroughPublisher(publisher)).toHaveLength(1);
    expect(runs.count).toBe(1);
  });

  it('REFUSES a second drain of one publication, because the pipeline RE-SERVES', async () => {
    // THE HAZARD, named. `ToolExecutionPipeline.getRemainingResults` yields its
    // items again on a second call -- measured in `engine-drain-carryover.test.ts`
    // as a real double `settle:key:…:succeeded`, which is indistinguishable from a
    // correct ledger. In production it is harmless ONLY because `streamChat`
    // publishes a fresh pipeline every turn.
    //
    // The engine drains on EVERY turn, so "one publication, two drains" is
    // exactly "one pipeline held across two turns" expressed at the publisher.
    // The refusal is what makes it unrepresentable.
    const runs = { count: 0 };
    const publisher = new TurnPipelinePublisher();
    publisher.publish(1, pipelineFor(runs));
    publisher.queue(use('d2'));

    expect(await drainThroughPublisher(publisher)).toHaveLength(1);
    await expect(drainThroughPublisher(publisher)).rejects.toThrow(
      /RE-SERVES its results on a second drain/,
    );
  });

  it('a NEW publication may be drained, so the refusal is per-turn and not a latch', async () => {
    // The contrast that keeps the refusal honest. Same publisher, same
    // registry, same tool; only a second `publish` differs. Without it the test
    // above would pass against a publisher that simply refused every second
    // call forever -- which is the "discarded is a one-way latch" failure mode
    // `tool-pipeline-turn-lifetime.test.ts` exists to prevent.
    const runs = { count: 0 };
    const publisher = new TurnPipelinePublisher();
    publisher.publish(1, pipelineFor(runs));
    publisher.queue(use('d3'));
    expect(await drainThroughPublisher(publisher)).toHaveLength(1);

    publisher.publish(2, pipelineFor(runs));
    publisher.queue(use('d4'));

    expect(publisher.currentTurn()).toBe(2);
    expect(await drainThroughPublisher(publisher)).toHaveLength(1);
    expect(runs.count).toBe(2);
  });

  it('REFUSES to drain a discarded turn, rather than yielding nothing', async () => {
    // The silent shape. A discarded pipeline accepts `queue` and drains NOTHING,
    // with no error anywhere -- a turn that silently loses every tool result.
    // `drain` must therefore refuse, exactly as `queue` does.
    const runs = { count: 0 };
    const publisher = new TurnPipelinePublisher();
    const pipeline = pipelineFor(runs);
    publisher.publish(3, pipeline);

    publisher.discard();

    expect(pipeline.isUsable()).toBe(false);
    await expect(drainThroughPublisher(publisher)).rejects.toThrow(
      /pipeline has been discarded, so the drain would yield nothing/,
    );
  });

  it('REFUSES before any turn has published, and after the run is closed', async () => {
    const publisher = new TurnPipelinePublisher();
    await expect(drainThroughPublisher(publisher)).rejects.toThrow(
      /no turn has published a pipeline yet/,
    );

    publisher.publish(1, pipelineFor({ count: 0 }));
    publisher.close();
    await expect(drainThroughPublisher(publisher)).rejects.toThrow(/this run has ended/);
  });

  it('discard() drops the live turn queued calls, and refuses the same three states', async () => {
    const runs = { count: 0 };
    const publisher = new TurnPipelinePublisher();
    publisher.publish(1, pipelineFor(runs));
    publisher.queue(use('d5'));

    publisher.discard();

    // Nothing ran -- the max_tokens fail-fast shape the agent calls this for.
    // Read through the PUBLISHER rather than off a handle on the pipeline,
    // because the whole point of the drain route is that no such handle exists:
    // a `drain()` that exposed the executor would let one be kept across turns,
    // which is the hazard the one-shot refusal above is there to stop.
    await expect(drainThroughPublisher(publisher)).rejects.toThrow(/has been discarded/);
    expect(runs.count).toBe(0);

    const empty = new TurnPipelinePublisher();
    expect(() => empty.discard()).toThrow(/no turn has published a pipeline yet/);
    publisher.close();
    expect(() => publisher.discard()).toThrow(/this run has ended/);
  });
});
