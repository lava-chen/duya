/**
 * Plan 600 S2 (inversion step 1) -- why a `ToolExecutionPipeline` cannot be
 * hoisted out of `DuyaAgent.streamChat`.
 *
 * ## The constraint this pins
 *
 * Plan 600 item 2 wants `@duya/agent-runtime` to own the
 * `model -> tool -> backfill -> next turn` loop, and the named blocker for
 * binding a real `ToolPort` has been that `ToolExecutionPipeline` is
 * constructed INSIDE the `streamChat` generator (`DuyaAgent.ts:2036`) so nothing
 * outside it holds a handle.
 *
 * The obvious fix is to hoist the pipeline: build it once and reuse it. **That
 * fix is wrong, and silently so.** `discard()` leaves the pipeline permanently
 * unusable, and TWO independent pieces of state enforce that:
 *
 *   - a one-way `discarded` latch (`StreamingToolExecutor.ts:728`) that nothing
 *     clears, and which short-circuits both drain entry points (`:2004`, `:2052`);
 *   - an ABORTED `siblingAbortController` (`:733`), which the drain loop breaks
 *     on at `:2059`.
 *
 * Both are one-way, which is the part that matters: clearing either one alone
 * does NOT revive the pipeline, so "just reset the flag" is not a fix either.
 * A hoisted instance would go permanently mute after the FIRST model stream
 * retry -- which the loop performs on every transport hiccup
 * (`DuyaAgent.ts:2359` calls `executor.discard()` from `onRetryReset`).
 *
 * The failure mode is the dangerous kind: the drain does not throw and does not
 * report an error. It yields NOTHING. The model asked for a tool, the tool never
 * ran, and the turn received no result of any kind -- so the run keeps going
 * with a hole in its context and the only symptom is a missing side effect.
 *
 * So the correct shape is: construct the pipeline PER TURN (as the code does
 * today) and PUBLISH the current one, rather than constructing one and holding
 * it. These tests exist to make that a property the next slice cannot break by
 * "tidying" the construction site.
 *
 * ## What the mutation proof actually is
 *
 * The mutation these tests are proven against is the one that models the risk:
 * making `discard()` leave the pipeline USABLE again (clearing the latch and
 * handing back an un-aborted controller). That is the change someone would make
 * while hoisting, so it is the change that must turn this file red. Removing
 * the `discarded` guard alone does NOT -- the aborted sibling controller breaks
 * the drain loop on its own -- which is why this file asserts the OBSERVABLE
 * property (a discarded pipeline never runs another tool) rather than any one
 * internal guard.
 *
 * ## Why the assertions are not `a === a`
 *
 * The three tests below share a registry, a tool, and an abort controller, and
 * differ ONLY in which pipeline instance they drain from. A defect in the tool,
 * the registry or the context would therefore fail all three together, and only
 * the instance's own latch can produce the split the tests assert.
 */

import { describe, expect, it } from 'vitest';
import { ToolExecutionPipeline } from '../ToolExecutionPipeline.js';
import { ToolRegistry } from '../registry.js';
import type { MessageUpdate } from '../StreamingToolExecutor.js';
import type { AppState, Tool, ToolResult, ToolUse, ToolUseContext } from '../../types.js';

const PROBE = 'lifetime_probe';

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
    toolUseId: 'turn-ctx',
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

/** Collect the tool_result texts a pipeline drain produced. */
async function drainResults(pipeline: ToolExecutionPipeline): Promise<string[]> {
  const texts: string[] = [];
  for await (const update of pipeline.getRemainingResults() as AsyncIterable<MessageUpdate>) {
    const content = update.message?.content;
    if (typeof content === 'string') texts.push(content);
  }
  return texts;
}

describe('a ToolExecutionPipeline is single-use across turns', () => {
  it('drains a queued tool on a fresh pipeline', async () => {
    const runs = { count: 0 };
    const pipeline = new ToolExecutionPipeline(makeRegistry(runs), async () => true, makeContext());

    pipeline.addTool(use('t1'));

    expect(await drainResults(pipeline)).toHaveLength(1);
    expect(runs.count).toBe(1);
  });

  it('yields NOTHING after discard(), and never runs the tool', async () => {
    // The exact state the loop reaches on a model-stream retry: `discard()` was
    // called on this instance (`DuyaAgent.ts:2359`) and the turn then queued
    // more calls against the same instance.
    const runs = { count: 0 };
    const pipeline = new ToolExecutionPipeline(makeRegistry(runs), async () => true, makeContext());

    pipeline.discard();
    pipeline.addTool(use('t2'));

    const texts = await drainResults(pipeline);

    // Silent, not loud. There is no throw and no error envelope to catch.
    expect(texts).toEqual([]);
    expect(runs.count).toBe(0);
  });

  it('still drains normally on a pipeline built AFTER the discard', async () => {
    // The contrast that keeps the test above honest: same registry shape, same
    // context, same tool -- only the instance differs. If this one drained
    // nothing either, the emptiness above would be a broken harness rather than
    // the instance's latch.
    const runs = { count: 0 };
    const discarded = new ToolExecutionPipeline(makeRegistry(runs), async () => true, makeContext());
    discarded.discard();

    const rebuilt = new ToolExecutionPipeline(makeRegistry(runs), async () => true, makeContext());
    rebuilt.addTool(use('t3'));

    expect(await drainResults(rebuilt)).toHaveLength(1);
    expect(runs.count).toBe(1);
  });
});
