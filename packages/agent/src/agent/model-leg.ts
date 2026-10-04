/**
 * Where the current turn's MODEL leg is published for the run engine to reach.
 *
 * ## Why this exists at all
 *
 * Plan 600 item 2 wants `@duya/agent-runtime` to own the
 * `model -> tool -> backfill -> next turn` loop, and the named blocker for
 * binding a real `ModelPort` has been that everything the model leg needs is
 * closure state inside the `streamChat` generator (`DuyaAgent.ts`):
 *
 * | needed by `createLegacyModelPort` | what it actually is |
 * | --- | --- |
 * | `llmClient` | `private llmClient` (`DuyaAgent.ts:268`) — no getter |
 * | `llmMessages` | a per-turn `const`, six transforms downstream of the durable history |
 * | `declaredTools` | the turn's closure-local `tools` |
 * | `turnCount` | the turn loop's counter, closure-local |
 *
 * The worker entry's answer was `openModelStream: () => emptyModelStream()`
 * (`agent-process-entry.ts:3245`), which is correct while it is honest: a model
 * that is asked for a stream and gets nothing is a hole, and a silent stream is
 * that hole. So the gap was not a wiring mistake; it was that there was nothing
 * to wire to.
 *
 * ## Why the leg is NOT the four sources
 *
 * `createLegacyModelPort` takes four sources and calls `llmClient.streamChat`
 * **directly** (`run-engine-model.ts:368`). That is a fourth thing that is not in
 * the table above and is the reason four sources are not enough:
 *
 * `runTurnStream` (`TurnStreamRunner.ts:125`) wraps the provider call in the
 * turn-level replay envelope. On a transport death it calls `deps.onRetryReset`
 * — which in `streamChat` does `executor.discard()` and clears every per-attempt
 * accumulator — emits a `chat:retry` chip, sleeps, and re-issues the request.
 * A port that called `streamChat` directly would drop that envelope, and
 * `onRetryReset` is the replay-on-transport-death layer. It cannot be
 * reconstructed from outside either: it closes over `executor`,
 * `assistantContent`, `deadLoopTracker` and the rest of the turn's accumulators.
 *
 * So what is published is a leg whose `open()` IS `runTurnStream` over the turn's
 * real deps. `buildTurnModelLeg` below constructs it, so there is no caller-
 * supplied `open` that could accidentally be one without the envelope.
 *
 * ## Why `messages` is the TRANSFORMED array, and why that is checkable
 *
 * The array the provider actually receives is not the durable history and not
 * `get messages()`. Per request, `streamChat` builds one:
 *
 * ```
 * prePruneMessages   (runtime-prompt substitution, or `messages` unchanged)
 *   -> llmMessages = compressProjectedToolMessages(prePruneMessages)   :2256
 *   -> this._applyProviderThreadBoundary(llmMessages)                  :2276
 *   -> await this._injectRuntimeContext(llmMessages, ...)             :2284
 *   -> injectOSContextFragment(llmMessages, runtimePromptMessageId)    :2290
 *   -> injectTurnTimestampReminders(llmMessages)                       :2300
 *   -> runTurnStream({ llmMessages, ... })                            :2356
 * ```
 *
 * `get messages()` (`DuyaAgent.ts:278`) recomputes
 * `projectTimelinePersistenceMessages(this.timeline.snapshot())` on every read —
 * a DIFFERENT array, and a strictly less informative one: the transient
 * attachment/deferred-tool context and the OS-context fragment live only on
 * `llmMessages` and never reach the timeline. A model payload built from it
 * would be plausible and wrong, which is the hardest class of defect here.
 *
 * The leg reads `deps.llmMessages` — the same field `runTurnStream` hands the
 * client — so the two cannot diverge. It reads it at CALL time rather than
 * snapshotting at build time, and the reason is the transforms' mutation
 * style: `injectTurnTimestampReminders` REPLACES `messages[i]` with a shallow
 * copy and `_injectRuntimeContext` pushes onto the array, so a copy taken when
 * the leg is built is a different value from the array itself once those run.
 * `runTurnStream` re-reads the field on every attempt for the same reason.
 *
 * What is NOT load-bearing is WHEN the leg is published, as long as it is
 * published after `llmMessages` is bound. Only `compressProjectedToolMessages`
 * can rebind the array; the four transforms after it mutate entries in place,
 * so an earlier publish of the same reference would still observe their output
 * at request time. `model-leg.test.ts` pins the array identity — the part that
 * is load-bearing — by reading one real turn three ways and finding the leg
 * and the provider agree with each other and disagree with `get messages()`.
 *
 * ## Why one instance per run, and not a module-level `let`
 *
 * The worker serves sessions concurrently, so a module-level "current leg"
 * would let one session's engine stream into another session's turn. This is the
 * same argument, and the same hazard, as `TurnPipelinePublisher`; it is not a
 * second copy of `DuyaAgent`'s `turnToolUseContext` reassignment. The worker
 * entry creates one publisher per `chat:start`, hands the same instance to
 * `streamChat`, and closes it when the run's stream ends.
 *
 * ## What this does NOT give the cutover
 *
 * It does not give the engine the request. `ModelRequest.systemPrompt`,
 * `.messages`, `.tools`, `.model`, `.provider`, `.maxOutputTokens` and
 * `.temperature` are all fixed by the turn the legacy loop is already running,
 * and a port that overrode them would change what today's users are sent.
 * Owning the request is the cutover's job, not this seam's.
 *
 * ## Why cancellation DOES reach the provider through this leg
 *
 * The first version of this seam exposed `signal` READ-ONLY and documented the
 * gap: the turn's `AbortController` was a local of `streamChat`, so nothing
 * outside the generator could fire it and the engine's stop left the in-flight
 * provider request running. That is the worst shape a cancellation can have --
 * it reports success while doing nothing -- so `abortRequest` below closes it.
 *
 * The capability is bound to the controller that OWNS `deps.signal`, and
 * `buildTurnModelLeg` refuses to build a leg whose abort controller does not
 * own that signal. The identity check is the point: it is the one property that
 * distinguishes "aborting this cancels the provider request" from "aborting
 * something nearby looks like it cancelled the provider request", and it is
 * checkable without aborting anything.
 *
 * Which controller that is depends on `DuyaAgent.ts:2224-2227`: the request is
 * driven by `this.abortController.signal`, or by a per-request child of it when
 * `llmRequestTimeoutMs` is configured. The publish site passes whichever one it
 * built, so the leg drives exactly the signal `runTurnStream` was handed.
 *
 * The legacy path is untouched by this and still reaches the provider: a
 * run-level abort (`interrupt()`, `DuyaAgent.ts:4398`) fires
 * `this.abortController`, and `createChildAbortController` propagates that to
 * the child. Both callers are still needed until the cutover decides otherwise.
 */

import type { AIClient, Message, SSEEvent } from '@duya/ai';
import type { Tool } from '../types.js';
import { runTurnStream, type TurnStreamRunnerDeps } from './TurnStreamRunner.js';

/**
 * One turn's model leg: what a `ModelPort` needs, plus the envelope it must not
 * lose.
 *
 * `open()` rather than a stream field, because a `ModelPort` is per-RUN state by
 * construction and `ModelRequest` travels as an argument to `stream` — an
 * instance holding one turn's accumulator state is the shape the engine's own
 * header warns against. Each `open()` is a fresh `runTurnStream`, so each has its
 * own replay budget.
 */
export interface TurnModelLeg {
  /** The turn this leg belongs to. Diagnostics, and the refusal messages. */
  readonly turn: number;
  /** The client the legacy loop already drives. Nothing new is constructed. */
  readonly client: AIClient;
  /**
   * The provider-bound message snapshot — the TRANSFORMED per-request array.
   *
   * Read at call time, not snapshotted, for the reason in the header: a replay
   * re-issues the request and must re-read the same field, and the transform
   * chain mutates entries in place (`injectTurnTimestampReminders` replaces
   * `messages[i]` with a shallow copy).
   */
  readonly messages: () => Message[];
  /** This turn's declared tool surface, as `runTurnStream` receives it. */
  readonly declaredTools: readonly Tool[];
  /**
   * The turn's own request signal — the one the legacy loop's provider call is
   * driven by, and the one that governs a stream opened through this leg.
   */
  readonly signal: AbortSignal;
  /**
   * Cancel THIS turn's provider request.
   *
   * The counterpart to `signal`: firing it is what makes `signal.aborted` true,
   * which is what stops the in-flight provider call. A leg without it would let
   * the engine stop its own run while the provider kept streaming — a
   * cancellation that reports success and does nothing.
   *
   * Refuses rather than aborting something else: see `ModelLegPublisher`.
   */
  abortRequest(reason?: unknown): void;
  /**
   * A FRESH `runTurnStream` over this turn's real deps.
   *
   * Includes the replay envelope: `onRetryReset` (which discards the executor
   * and clears the per-attempt accumulators), the `chat:retry` chip, the backoff
   * sleep, and the per-attempt declared-tools refresh. Not optional.
   */
  open(): AsyncIterable<SSEEvent>;
}

/**
 * Build a turn's leg over the deps the legacy loop is already using.
 *
 * The envelope is not a parameter. `open` is `runTurnStream(params.deps)` with
 * no override available, so a caller cannot publish a leg that streams without
 * the replay path — which is the one property that has to be structural, since
 * it is invisible from the outside until a transport dies.
 *
 * `params.abortController` MUST be the controller that produced
 * `params.deps.signal`, and that is checked rather than documented: a leg whose
 * abort controller merely resembles the right one aborts something the provider
 * is not reading, which is the silent-cancellation defect in its purest form.
 */
export function buildTurnModelLeg(params: {
  readonly turn: number;
  readonly deps: TurnStreamRunnerDeps;
  /**
   * The controller OWNING `deps.signal` — `this.abortController`, or the
   * per-request child built from it when a request timeout is configured.
   */
  readonly abortController: AbortController;
}): TurnModelLeg {
  if (params.abortController.signal !== params.deps.signal) {
    throw new Error(
      `refusing to publish turn ${params.turn}: the abort controller does not own this turn's request signal, so aborting it would not cancel the provider request`,
    );
  }
  return {
    turn: params.turn,
    client: params.deps.llmClient,
    messages: () => params.deps.llmMessages,
    declaredTools: params.deps.tools,
    signal: params.deps.signal,
    abortRequest: (reason?: unknown) => {
      params.abortController.abort(reason);
    },
    open: () => runTurnStream(params.deps),
  };
}

/** What a turn published, and the turn it belonged to. */
interface PublishedLeg {
  readonly turn: number;
  readonly leg: TurnModelLeg;
}

/**
 * The live turn's model leg.
 *
 * Supersede-on-publish, refuse-loudly-on-read — the same contract as
 * `TurnPipelinePublisher`, and for the same reason: a hoisted leg is wrong, and
 * wrong silently.
 *
 * A leg is per-TURN because everything in it is per-turn. The client is
 * run-scoped, but `messages`, `declaredTools` and `turn` are not, and a
 * retained turn N-1 leg is one refactor away from a turn whose context has
 * already been compacted away.
 */
export class ModelLegPublisher {
  #current: PublishedLeg | null = null;
  #closed = false;

  /**
   * Publish this turn's leg, superseding the previous turn's.
   *
   * The turn number is read off the leg rather than passed beside it. Two
   * arguments for one number is a second source of truth, and a divergence
   * between them would be invisible in every message that names the turn.
   */
  publish(leg: TurnModelLeg): void {
    if (this.#closed) {
      throw new Error(
        `refusing to publish turn ${leg.turn}: this run's model leg publication is closed, so its turns are over`,
      );
    }
    this.#current = { turn: leg.turn, leg };
  }

  /**
   * The run is over. No turn may be streamed from here on.
   *
   * Distinct from "no turn has been published": a closed publication is a run
   * that HAD turns and has finished, and the distinction is what tells a
   * "stream arrived too early" apart from one that arrived too late.
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
   * The live turn's leg, or a throw naming why there is none.
   *
   * Throws rather than returning a status because the caller is a port, and a
   * port that swallowed this would report a turn that produced no model output
   * as a turn that ended cleanly.
   *
   * The aborted case is a REFUSAL rather than a check the caller has to
   * remember: a leg whose request signal has fired yields nothing, so streaming
   * through it would look exactly like a model that chose to say nothing.
   */
  requireLeg(): TurnModelLeg {
    if (this.#current === null) {
      throw new Error(
        this.#closed
          ? 'refusing to stream a model turn: this run has ended, so no turn holds a model leg'
          : 'refusing to stream a model turn: no turn has published a model leg yet',
      );
    }
    const { turn, leg } = this.#current;
    if (leg.signal.aborted) {
      throw new Error(
        `refusing to stream a model turn: turn ${turn}'s request signal has fired, so its leg would yield nothing`,
      );
    }
    return leg;
  }

  /**
   * Cancel the CURRENT turn's provider request.
   *
   * The engine's stop path, and the only route from a stop to the provider.
   * `run-engine.ts:259` aborts the engine's own controller, which nothing
   * outside the turn reads; this is what carries that cancellation to the
   * request that is actually in flight.
   *
   * Throws rather than returning a status in all three of the cases
   * `TurnPipelinePublisher.queue` throws in, because the failure mode is the
   * same and worse here: a stop that silently failed to reach the provider looks
   * exactly like a stop that succeeded. A caller cannot tell "cancelled" from
   * "aimed at nothing" unless this refuses.
   *
   * The refusals are deliberately NOT collapsed into "abort whatever is current".
   * Aborting turn N-1's controller after turn N published would cancel a request
   * the engine did not intend to stop, which is a worse defect than cancelling
   * nothing.
   */
  abortTurn(reason?: unknown): void {
    if (this.#current === null) {
      throw new Error(
        this.#closed
          ? 'refusing to abort a model turn: this run has ended, so there is no provider request to cancel'
          : 'refusing to abort a model turn: no turn has published a model leg yet',
      );
    }
    const { turn, leg } = this.#current;
    if (leg.signal.aborted) {
      // The request is ALREADY cancelled, so this is not a silent failure — but
      // reporting success for a cancellation this call did not perform is the
      // same false claim `StopReceipt.requested` exists to prevent
      // (`run-engine.ts:234-238`), so it refuses instead.
      throw new Error(
        `refusing to abort turn ${turn}: its request signal has already fired, so this call cancelled nothing`,
      );
    }
    leg.abortRequest(reason);
  }
}
