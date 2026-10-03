/**
 * The narrow seam to whatever actually executes the run.
 *
 * ## Why this is an interface and not a `WorkerManager` import
 *
 * The runtime has to start an execution and receive its events, and it must be
 * able to do that without knowing whether the executor is a child process on
 * stdio, an HTTP endpoint, or a script in a test. Two reasons, in order of
 * weight:
 *
 *  1. **Testability without a process.** The Reference Run's closed loop has to
 *     be provable with no API key and no Electron. A structural interface lets
 *     a test supply a scripted executor and exercise the whole
 *     Control Plane 鈫?Runtime 鈫?RunEvent 鈫?SQLite path deterministically.
 *  2. **The executor is replaceable.** `@duya/agent` is the executor today.
 *     Rewriting the model loop, or moving it into a sandbox, must not require
 *     touching run identity, `seq`, or event persistence 鈥?that is the entire
 *     reason the run layer exists.
 *
 * So the seam is deliberately tiny: start, and receive frames. Everything the
 * executor cannot be asked for (cancel, pause, resume) is expressed in protocol
 * terms and handled by the controller, not delegated.
 *
 * ## Why `start` takes the MANIFEST (plan 587 R2.1)
 *
 * It used to take `(runId, sessionId, input, sink)`, which is a problem the
 * first real dispatch exposed: with the run id passed as a bare string, the
 * adapter could only forward an id, so the host kept issuing the executor's
 * command ITSELF and the run id travelled as a second, unrelated value. Two
 * dispatches, two ids, and a run whose executor was never told what it was
 * executing.
 *
 * `start(manifest, input, sink)` makes the run's whole identity and its
 * resolved configuration available at the ONE place an execution begins, so the
 * adapter can put the canonical `runId`, the manifest reference and the input
 * revision on the same wire message that starts the work. A host that also
 * sends its own command has two dispatches again, and the second one has no
 * manifest 鈥?which is why `RunController` calls this exactly once.
 */

import type { RunEventEnvelope, RunManifest, StopDisposition } from '@duya/agent-protocol';
import { runInputRevision } from '@duya/agent-protocol';
import type { RawFrame } from '../translate/chat-event-translator.js';

/**
 * The input digest, re-exported from the protocol package (plan 587 R2.2).
 *
 * It used to be DEFINED here. R2.2 made the worker verify it, and the worker
 * cannot import `@duya/agent-runtime` 鈥?so the canonical implementation moved
 * to `@duya/agent-protocol` and this re-export keeps every existing import
 * working. There is still exactly one derivation of the value; what changed is
 * that the side that CHECKS it and the side that PRODUCES it now read the same
 * function.
 */
export { runInputRevision };

/** Re-exported, so an adapter can name a disposition without a second import. */
export type { StopDisposition };

/**
 * What a stop is being asked for.
 *
 * An object rather than a positional `graceMs`, because the second argument is
 * the one that gets lost: a stop with no reason recorded is a kill in the
 * durable log that nobody can account for, and the reason is the only field
 * that says who asked for it.
 */
export interface StopRequest {
  /** The window in which a cooperative stop is honoured. */
  readonly graceMs: number;
  /** Who asked, in the caller's own words. Recorded in the terminal. */
  readonly reason: string;
}

/**
 * What the stop turned into.
 *
 * ## Why `stop` returns this at all
 *
 * It used to return `Promise<void>`, and the host's interrupt is synchronous and
 * fire-and-forget. So the await resolved before the grace window had even
 * opened: a cancel reported success for a worker that was still running, and
 * nothing upstream could tell a clean stop from a process that had to be killed.
 * The Desktop host has ALWAYS escalated after a grace deadline
 * (`WorkerManager.interruptWorker`); this receipt is what makes that visible,
 * and it is the same stop path, not a second one.
 *
 * ## The boundedness contract
 *
 * `stop` MUST resolve, and anything awaiting it must survive it not resolving.
 * A stop nobody answered is reported as `escalated`, because "we stopped
 * waiting" and "it stopped cleanly" are different claims and only the second one
 * is a success.
 */
export interface StopReceipt {
  /** True when a stop was actually put to an executor. */
  readonly requested: boolean;
  /** How it ended. See {@link StopDisposition}. */
  readonly disposition: StopDisposition;
  /** How long the caller waited, for a log line. Never a promise of more. */
  readonly waitedMs: number;
  /** Echoed back, so a receipt can be logged without the original request. */
  readonly reason: string;
}

/** An execution started by the runtime. */
export interface ExecutionHandle {
  /**
   * Stop the execution, and report what happened.
   *
   * `graceMs` is the window in which a cooperative stop is honoured before the
   * adapter escalates to a platform kill. The runtime is the caller, and it
   * bounds its own await on top of that: an adapter that never resolves must
   * still leave the run closable.
   *
   * Plan 587 R2.1 bound this to the host's EXISTING single interrupt function
   * and deliberately added no second stop path. R2.3 added none either. What
   * changed is that the SAME function's outcome is reported, and that a stop
   * nobody answered became a reportable state instead of an invisible one.
   */
  stop(request: StopRequest): Promise<StopReceipt>;
}

/** Receives frames from the executor as they are produced. */
export interface ExecutionSink {
  /**
   * One raw frame from the executor.
   *
   * Raw, not translated: the runtime owns translation so the event vocabulary
   * is a property of the run layer rather than of the transport. An executor
   * that already speaks the protocol may push envelopes through
   * {@link ExecutionSink.envelope} instead.
   */
  frame(raw: RawFrame): void;
  /** An event the runtime already built (a `run.started`, a synthetic failure). */
  envelope?(envelope: RunEventEnvelope): void;
  /** The executor's stream ended without a terminal frame. */
  end(): void;
}

/** Everything an executor needs to know about the turn it is about to run. */
export interface RunStartInput {
  readonly sessionId: string;
  readonly prompt: string;
  readonly options: Readonly<Record<string, unknown>>;
  /**
   * The digest that identifies THIS input, pinned before the execution began.
   *
   * Carried rather than recomputed by each side: the Control Plane writes it
   * into the run row, the adapter puts it on the executor's command, and a
   * later retry of the same run can compare against the row instead of
   * guessing whether "the same input" means the same bytes.
   */
  readonly revision: string;
}

/** What the runtime needs from an executor. */
export interface ExecutionChannel {
  /**
   * Begin an execution.
   *
   * @param manifest - The Control Plane's frozen decision about this run. The
   *   canonical `runId` is `manifest.runId`; an adapter that mints its own id
   *   here is a second run-identity source.
   * @param input - The resolved prompt, options, and the input revision.
   * @param sink - Where the executor reports. The controller guarantees
   *   `sink.end()` is safe to call more than once, so an executor does not have
   *   to track whether the run already settled.
   *
   * @throws {ExecutionDispatchError} when the executor is not available. The
   *   controller turns it into a terminal, so a refused dispatch leaves no run
   *   that looks live.
   */
  start(manifest: RunManifest, input: RunStartInput, sink: ExecutionSink): Promise<ExecutionHandle>;
}

/**
 * The executor refused to begin.
 *
 * Distinct from a generic throw so a host can tell "the worker was never there"
 * from "the adapter is broken". Both are refusals 鈥?neither started an
 * execution 鈥?but only one of them is fixed by spawning a worker, and a host
 * that cannot tell them apart retries the wrong thing.
 */

export class ExecutionDispatchError extends Error {
  /** Stable across hosts: the code a caller branches on. */
  readonly code = 'dispatch_refused' as const;

  constructor(reason: string) {
    super(`the executor refused to start the run: ${reason}`);
    this.name = 'ExecutionDispatchError';
  }
}
