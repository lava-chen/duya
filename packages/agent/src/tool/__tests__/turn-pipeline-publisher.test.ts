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
 * something the engine turns into a failed run (`run-engine.ts:405-408`) instead
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
