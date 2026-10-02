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
 *     Control Plane → Runtime → RunEvent → SQLite path deterministically.
 *  2. **The executor is replaceable.** `@duya/agent` is the executor today.
 *     Rewriting the model loop, or moving it into a sandbox, must not require
 *     touching run identity, `seq`, or event persistence — that is the entire
 *     reason the run layer exists.
 *
 * So the seam is deliberately tiny: start, and receive frames. Everything the
 * executor cannot be asked for (cancel, pause, resume) is expressed in protocol
 * terms and handled by the controller, not delegated.
 */

import type { RunEventEnvelope } from '@duya/agent-protocol';
import type { RawFrame } from '../translate/chat-event-translator.js';

/** An execution started by the runtime. */
export interface ExecutionHandle {
  /**
   * Stop the execution. `graceMs` is the window in which a cooperative stop is
   * honoured before the caller escalates; the runtime never escalates on its
   * own, because only the host knows whether a hard kill is acceptable.
   */
  stop(graceMs: number): Promise<void>;
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

/** What the runtime needs from an executor. */
export interface ExecutionChannel {
  /**
   * Begin an execution.
   *
   * @param sink - Where the executor reports. The controller guarantees
   *   `sink.end()` is safe to call more than once, so an executor does not have
   *   to track whether the run already settled.
   */
  start(
    runId: string,
    sessionId: string,
    input: { readonly prompt: string; readonly options: Readonly<Record<string, unknown>> },
    sink: ExecutionSink,
  ): Promise<ExecutionHandle>;
}
