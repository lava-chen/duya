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
 * and a thrown dispatch is a FAILED run (`run-engine.ts:405-408`) rather than a
 * dropped tool.
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
import type { ToolUse } from '../types.js';

/** What a turn published, and the turn it belonged to. */
interface PublishedTurn {
  readonly turn: number;
  readonly pipeline: ToolExecutionPipeline;
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
   */
  publish(turn: number, pipeline: ToolExecutionPipeline): void {
    if (this.#closed) {
      throw new Error(
        `refusing to publish turn ${turn}: this run's pipeline publication is closed, so its turns are over`,
      );
    }
    this.#current = { turn, pipeline };
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
}
