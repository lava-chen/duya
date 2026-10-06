/**
 * Where the current turn's `ToolExecutionPipeline` is published for the run
 * engine to reach.
 *
 * ## Why publication exists at all
 *
 * Plan 600 item 2 wants `@duya/agent-runtime` to own the
 * `model -> tool -> backfill -> next turn` loop, and the named blocker for
 * binding a real `ToolPort` has been that `ToolExecutionPipeline` is a `const`
 * local inside the `streamChat` generator (`DuyaAgent.ts:2036`), so no handle
 * reaches the worker entry. Until now the worker entry's answer was to throw
 * (`agent-process-entry.ts:3197`), which is correct and loud: a model that asks
 * for a tool and gets no tool is a hole in the context, and a throw says so.
 *
 * ## Why not hoist the pipeline
 *
 * Because hoisting is wrong, and silently so.
 * `tool-pipeline-turn-lifetime.test.ts` pins it: `discard()` leaves a pipeline
 * permanently unusable, via a one-way `discarded` latch
 * (`StreamingToolExecutor.ts:728`) AND an ABORTED `siblingAbortController`
 * (`:733`). Clearing either alone does not revive it. The legacy loop calls
 * `discard()` from `onRetryReset` on every model-stream hiccup
 * (`DuyaAgent.ts:2359`), so ONE hoisted instance would go permanently mute
 * after the first retry -- accepting tools, draining nothing, and reporting no
 * error at all.
 *
 * So the shape is: build per turn, as the code does today, and PUBLISH the
 * current one. What is published is superseded each turn rather than retained,
 * which is what keeps the long-lived-instance failure out by construction --
 * there is no field here that outlives a turn except the record of the turn
 * before it, and that one is dropped rather than kept.
 *
 * ## The cost of getting this wrong
 *
 * Publication is only worth having if violating it is VISIBLE, because the
 * alternative is the silent failure above. `queue` therefore REFUSES, loudly and
 * distinctly, in all three ways the current turn's pipeline can be the wrong
 * one:
 *
 *  - nothing published yet (the engine dispatched before `streamChat` reached a
 *    turn, or after the publication was closed);
 *  - the run is over (`close()`), so the turn that owned the pipeline is gone;
 *  - the current turn's pipeline has been `discard()`ed, so a tool handed to it
 *    would be buffered and never run. This is the case that would otherwise be
 *    the mute one, and it is the reason `isUsable()` exists.
 *
 * Every refusal is an `Error` naming the turn, because the caller is the engine
 * and a thrown dispatch is a FAILED run (`run-engine.ts:454-457`) rather than a
 * dropped tool.
 *
 * ## What the class exposes, and why it is a complete tool leg
 *
 * `queue` / `drain` / `discard` -- hand work over, collect it, throw it away.
 * `drain` and `discard` were added in plan 610 A3-2b2, and the reason is that
 * `queue` alone is not a tool leg: without them the composition had no route to
 * `getRemainingResults`, so the host handed over its OWN handle on the live
 * executor and `ToolPort` cost three independent obligations that could disagree
 * with each other. Three methods that all read the same `#current` record cannot
 * disagree; three host callbacks that each captured a pipeline at a different
 * moment could. See `drain` for the one property that makes the route safe.
 *
 * ## Why one instance per run, and not a module-level `let`
 *
 * The worker serves sessions concurrently, so a module-level "current pipeline"
 * would let one session's engine dispatch into another session's turn.
 * `DuyaAgent.ts:2032` has exactly that shape for `turnToolUseContext`; this is
 * not a second copy of it. `agent-process-entry.ts` creates one publisher per
 * `chat:start`, hands the same instance to both `streamChat` and `queueTool`,
 * and closes it when the run's stream ends.
 */

import type { ToolExecutionPipeline } from './ToolExecutionPipeline.js';
import type { MessageUpdate } from './StreamingToolExecutor.js';
import type { ToolUse } from '../types.js';

/** What a turn published, and the turn it belonged to. */
interface PublishedTurn {
  readonly turn: number;
  readonly pipeline: ToolExecutionPipeline;
  /**
   * Whether THIS publication has already been drained.
   *
   * The re-serve guard, and the reason it lives on the record rather than on
   * the publisher: `publish` builds a fresh record per turn, so "drained" is a
   * property of one published turn and dies with it. See `drain`.
   */
  drained: boolean;
}

export class TurnPipelinePublisher {
  /** The live turn, or `null` before the first publication and after `close()`. */
  #current: PublishedTurn | null = null;
  #closed = false;

  /**
   * Publish this turn's pipeline, superseding the previous turn's.
   *
   * Called once per turn from the `streamChat` generator, immediately after the
   * pipeline is constructed. The previous record is dropped, NOT retained: a
   * publisher that kept a handle to turn N-1 would be the hoisted instance this
   * class exists to avoid, reachable one refactor away.
   *
   * REFUSES the same instance twice, which is the other half of that: a fresh
   * record for a pipeline that already has one resets this record's `drained`
   * latch and hands out a second drain of a pipeline that re-serves. See the
   * body for why the latch alone cannot see it.
   */
  publish(turn: number, pipeline: ToolExecutionPipeline): void {
    if (this.#closed) {
      throw new Error(
        `refusing to publish turn ${turn}: this run's pipeline publication is closed, so its turns are over`,
      );
    }
    // The per-turn lifetime, enforced here rather than trusted to every caller.
    //
    // `drained` below is a PER-RECORD latch and `publish` is what clears it, so
    // re-publishing one instance would reset that latch and hand the engine a
    // second drain of a pipeline that RE-SERVES -- two `settle:key:…:succeeded`
    // rows that no test could tell from one correct row. The `drained` guard
    // therefore cannot catch this shape; it is invisible to it by construction.
    //
    // The only defence is to refuse the instance itself, here, where "which
    // turn owns this pipeline" is decided. Building per turn is the contract
    // `buildTurnPipeline` is written to keep (it constructs, and caches
    // nothing), and a memoised pipeline would otherwise be one `??=` away.
    if (this.#current !== null && this.#current.pipeline === pipeline) {
      throw new Error(
        `refusing to publish turn ${turn}: that pipeline is already published as turn ${this.#current.turn}. A published pipeline re-serves its results on a second drain, so one pipeline cannot own two turns -- construct a fresh one`,
      );
    }
    this.#current = { turn, pipeline, drained: false };
  }

  /**
   * The run is over. No turn may be dispatched from here on.
   *
   * Distinct from "no turn has been published": a closed publication is a run
   * that HAD turns and has finished, and the distinction is what tells a
   * "dispatch arrived too early" apart from a "dispatch arrived too late".
   */
  close(): void {
    this.#closed = true;
    this.#current = null;
  }

  /** The live turn's number, or `null`. Diagnostics and assertions. */
  currentTurn(): number | null {
    return this.#current?.turn ?? null;
  }

  /**
   * Hand one tool call to the current turn's pipeline.
   *
   * The only path from the engine to a pipeline, and the only place the three
   * refusals above are enforced. Throws rather than returning a status: a caller
   * that swallowed this would be back to silently dropping a tool the model
   * asked for.
   */
  queue(block: ToolUse): void {
    if (this.#current === null) {
      throw new Error(
        this.#closed
          ? 'refusing to dispatch a tool: this run has ended, so no turn holds a pipeline'
          : 'refusing to dispatch a tool: no turn has published a pipeline yet',
      );
    }
    const { turn, pipeline } = this.#current;
    if (!pipeline.isUsable()) {
      throw new Error(
        `refusing to dispatch tool '${block.name}': turn ${turn}'s pipeline has been discarded, so the call would be buffered and never run`,
      );
    }
    pipeline.addTool(block);
  }

  /**
   * Drain the live turn's pipeline, ONCE.
   *
   * ## The route this adds, and the one hazard it has to survive
   *
   * `queue` could already reach a pipeline but `drain` could not, so `ToolPort.drain`
   * had no route to `ToolExecutionPipeline.getRemainingResults` through the
   * publisher and the composition had to take a host's own handle on the live
   * executor -- three host obligations (`queueTool` / `drainTools` /
   * `discardTools`) where one publisher is the truth. This is that route, and it
   * deliberately hands out an ITERABLE rather than the pipeline itself: a caller
   * cannot retain the executor, so it cannot reach next turn's pipeline through a
   * stale reference.
   *
   * The hazard is measured, not hypothetical.
   * `ToolExecutionPipeline.getRemainingResults` RE-SERVES its items on a second
   * call. In production that is harmless only because `streamChat` publishes a
   * FRESH pipeline every turn, so turn 2 drains a different instance. An engine
   * drains on EVERY turn, so a publisher that let one publication be drained
   * twice would settle the same attempt key twice -- two `settle:key:…:succeeded`
   * rows that are indistinguishable from one correct row
   * (`engine-drain-carryover.test.ts:332-347` records the measurement).
   *
   * So the refusal is structural rather than advisory:
   *
   *  - `#current` is read AT CALL TIME, never handed out. There is no handle to
   *    hold across turns, which is what makes "one pipeline for two turns"
   *    unrepresentable instead of merely discouraged.
   *  - `drained` is a per-record latch, set here and cleared only by `publish`.
   *    A second drain of the SAME publication throws.
   *
   * Throws rather than returning a status for the same reason `queue` does: a
   * swallowed refusal here is a turn that silently receives no tool results.
   */
  async *drain(): AsyncGenerator<MessageUpdate, void, unknown> {
    if (this.#current === null) {
      throw new Error(
        this.#closed
          ? 'refusing to drain tools: this run has ended, so no turn holds a pipeline'
          : 'refusing to drain tools: no turn has published a pipeline yet',
      );
    }
    const { turn, pipeline } = this.#current;
    if (!pipeline.isUsable()) {
      throw new Error(
        `refusing to drain turn ${turn}'s tools: its pipeline has been discarded, so the drain would yield nothing and the turn would silently lose every result`,
      );
    }
    if (this.#current.drained) {
      throw new Error(
        `refusing to drain turn ${turn} twice: a published pipeline RE-SERVES its results on a second drain, so this would settle the same calls a second time. Publish the next turn's pipeline instead`,
      );
    }
    // Latched BEFORE the first `yield`, not after the drain finishes. An
    // abandoned drain (a consumer that breaks out early, a throw upstream) has
    // still consumed the publication, and re-entering it is exactly the
    // double-serve this refuses.
    this.#current.drained = true;
    yield* pipeline.getRemainingResults();
  }

  /**
   * Drop the live turn's queued, unstarted calls.
   *
   * The third leg, and it closes the tool-leg obligation set: `queue` hands work
   * over, `drain` collects it, `discard` throws it away. Same refusals as the
   * other two, because a `discard` into the wrong turn is the same defect.
   */
  discard(): void {
    if (this.#current === null) {
      throw new Error(
        this.#closed
          ? 'refusing to discard tools: this run has ended, so no turn holds a pipeline'
          : 'refusing to discard tools: no turn has published a pipeline yet',
      );
    }
    const { turn, pipeline } = this.#current;
    if (!pipeline.isUsable()) {
      throw new Error(
        `refusing to discard turn ${turn}'s tools: its pipeline has already been discarded, so there is nothing queued that could run`,
      );
    }
    pipeline.discard();
  }
}
