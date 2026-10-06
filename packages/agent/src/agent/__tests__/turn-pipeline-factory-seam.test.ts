/**
 * Plan 610 A3-2b4: the per-turn `ToolExecutionPipeline` factory, and the
 * per-turn lifetime it has to keep.
 *
 * ## What this file proves
 *
 * `ToolExecutionPipeline` was a `const` local of the `streamChat` generator, so
 * nothing outside that generator could construct one. `TurnPipelinePublisher`
 * exposes `queue` / `drain` / `discard`, and all three read one `#current`
 * record that only `publish` writes -- so with the loop gone, the tool leg had
 * no producer at all. `buildTurnPipeline` is that producer.
 *
 * Two claims, kept apart on purpose because they are proved two different ways:
 *
 *  1. **Reachability and single implementation** are facts about a
 *     composition, so they are asserted against the SOURCE, comment-stripped
 *     the way `boundary-gates.mjs:52` strips for its own detectors. Counting
 *     naively would let the prose in `DuyaAgent.ts` -- which names
 *     `ToolExecutionPipeline`, `publish` and `streamChat` constantly -- satisfy
 *     the counts on its own. This is the same technique, and for the same
 *     reason, as `live-turn-single-driver.test.ts`.
 *
 *  2. **The per-turn lifetime** is a fact about objects, so it is asserted by
 *     RUNNING the publisher against real pipelines and real tools.
 *
 * ## The hazard the lifetime exists for
 *
 * `ToolExecutionPipeline.getRemainingResults()` RE-SERVES its items on a second
 * drain (measured: `engine-drain-carryover.test.ts:332-347`). In production that
 * is harmless only because each turn gets a FRESH pipeline. An engine drains on
 * every turn, so a pipeline that owned two turns would settle the same attempt
 * key twice -- two `settle:key:...:succeeded` rows indistinguishable from one
 * correct row.
 *
 * The `drained` latch cannot catch that, and the reason is structural: the
 * latch lives on the PUBLICATION RECORD and `publish` resets it. Re-publishing
 * one instance therefore hands the engine a clean latch over an already-drained
 * pipeline. The only defence is to refuse the instance itself, and that is what
 * the publisher now does.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TurnPipelinePublisher } from '../../tool/turn-pipeline-publisher.js';
import { ToolExecutionPipeline } from '../../tool/ToolExecutionPipeline.js';
import { ToolRegistry } from '../../tool/registry.js';
import { stripComments } from '../../../../../scripts/architecture/strip-comments.mjs';
import type { MessageUpdate } from '../../tool/StreamingToolExecutor.js';
import type { AppState, Tool, ToolResult, ToolUse, ToolUseContext } from '../../types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUYA = path.join(HERE, '..', 'DuyaAgent.ts');

/** The gate's own stripper, so these counts cannot disagree with CI's. */
function code(abs: string): string {
  return stripComments(fs.readFileSync(abs, 'utf8')).text;
}

function occurrences(pattern: RegExp, text: string): number {
  return (text.match(new RegExp(pattern.source, 'g')) ?? []).length;
}

// ============================================================================
// 1. The seam is reachable, and there is only one of it
// ============================================================================

describe('the pipeline factory is public, and the loop no longer builds its own', () => {
  it('declares buildTurnPipeline without a `private` modifier', () => {
    // Reachability, stated the way the language states it. `private` here is a
    // compile-time-only modifier, so this is really a statement about intent:
    // a `private` factory would still typecheck at the call site inside the
    // class and would be unreachable from the composition.
    const src = code(DUYA);
    expect(occurrences(/\bbuildTurnPipeline\b/g, src)).toBeGreaterThan(0);
    expect(src).not.toMatch(/private\s+buildTurnPipeline/);
  });

  it('constructs ToolExecutionPipeline exactly once, inside the factory', () => {
    // The load-bearing count. `new ToolExecutionPipeline(` appearing anywhere
    // else -- including inside the generator -- is a second implementation of
    // "what a turn's pipeline is", which is the thing that would let the legacy
    // and the engine drift apart while every other test still passed.
    const src = code(DUYA);
    expect(occurrences(/new ToolExecutionPipeline\s*\(/g, src)).toBe(1);
    expect(src).toContain('buildTurnPipeline(request: TurnPipelineRequest): ToolExecutionPipeline');
  });

  it('routes the generator through the factory rather than around it', () => {
    // Positive, so this cannot be satisfied by deleting the loop's pipeline
    // entirely: a file that stopped dispatching tools would also have no second
    // construction site.
    const src = code(DUYA);
    expect(occurrences(/this\.buildTurnPipeline\s*\(/g, src)).toBe(1);
  });

  it('publishes through the request, so a caller without a publisher still builds one', () => {
    // `?.` on purpose: the CLI and the sub-agent tool run no engine, and a
    // missing publisher is the pre-plan case rather than an error.
    const src = code(DUYA);
    expect(src).toContain('request.publisher?.publish(request.turn, executor)');
  });
});

// ============================================================================
// 2. The per-turn lifetime, asserted by running it
// ============================================================================

const PROBE = 'turn_pipeline_probe';

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
    toolUseId: 'turn-pipeline-seam-ctx',
    getAppState: () => state,
    setAppState: (f) => {
      state = f(state);
    },
    abortController: new AbortController(),
    options: {},
  };
}

function pipelineFor(runs: { count: number }): ToolExecutionPipeline {
  return new ToolExecutionPipeline(makeRegistry(runs), async () => true, makeContext());
}

function use(id: string): ToolUse {
  return { id, name: PROBE, input: { id } };
}

async function drainTexts(publisher: TurnPipelinePublisher): Promise<string[]> {
  const texts: string[] = [];
  for await (const update of publisher.drain() as AsyncIterable<MessageUpdate>) {
    const content = update.message?.content;
    if (typeof content === 'string') texts.push(content);
  }
  return texts;
}

describe('a pipeline cannot own two turns', () => {
  it('REFUSES the same instance republished for a later turn', () => {
    // THE mutation this slice exists to survive: hold one pipeline across two
    // turns. Before the refusal this threw nothing, and because `publish`
    // resets the record's `drained` latch, the second turn drained a pipeline
    // that had already served -- settling the same attempt key a second time.
    const publisher = new TurnPipelinePublisher();
    const pipeline = pipelineFor({ count: 0 });

    publisher.publish(1, pipeline);
    expect(() => publisher.publish(2, pipeline)).toThrow(/already published as turn 1/);
  });

  it('still accepts a FRESH pipeline per turn, so the refusal is not a global latch', () => {
    // The contrast that keeps the guard honest. A refusal that blocked the
    // second turn outright would make the guard pass while breaking the loop.
    const publisher = new TurnPipelinePublisher();
    publisher.publish(1, pipelineFor({ count: 0 }));
    expect(() => publisher.publish(2, pipelineFor({ count: 0 }))).not.toThrow();
  });
});

describe('a pipeline built per turn drains its own results exactly once', () => {
  it('runs each turn\'s tool and refuses only the repeat of one publication', async () => {
    // End-to-end through the publisher's three legs, which is the whole point
    // of the seam: queue hands the call over, drain collects it, and the tool
    // really RAN (so an empty drain cannot be a broken fixture passing quietly).
    const runs = { count: 0 };
    const publisher = new TurnPipelinePublisher();

    publisher.publish(1, pipelineFor(runs));
    publisher.queue(use('t1'));
    expect(await drainTexts(publisher)).toHaveLength(1);
    expect(runs.count).toBe(1);

    // A second drain of THAT publication is refused, for the re-serve reason.
    await expect(drainTexts(publisher)).rejects.toThrow(/refusing to drain turn 1 twice/);

    // The next turn gets its own pipeline, and its own single drain.
    publisher.publish(2, pipelineFor(runs));
    publisher.queue(use('t2'));
    expect(await drainTexts(publisher)).toHaveLength(1);
    expect(runs.count).toBe(2);
  });
});