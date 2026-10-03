/**
 * Terminal-state resolution — how a run's fate is decided from its events.
 *
 * ## The one rule everything else follows
 *
 * The terminal transition is a **one-shot CAS**, and the first writer wins.
 * Budget exhaustion, tool-error stop, natural completion, and cancellation all
 * compete for the same slot with no priority between them — only arrival order.
 * That is deliberate: any priority scheme needs a total order the host may not
 * have observed yet, and a host that applies "cancellation beats completion"
 * from a stream it is reading out of order will rewrite history.
 *
 * Three consequences fall out of it, and they are the whole point of this module:
 *
 *  - Cancellation is `completed`, never `failed`. Cancelling is not a failure,
 *    and a run log that records a user pressing stop as an error is a log nobody
 *    can use for availability maths.
 *  - A hard kill is `failed` with `escalated: true`. Reporting `cancelled`
 *    would be a lie: the clean cancel path was not honoured.
 *  - A run that ends with no terminal event at all is `failed` with
 *    `runtime_crash`, not silently `completed`. Silence is not consent.
 *
 * ## Why this is a function and not a class
 *
 * It is pure reasoning about a list of events: same list in, same verdict out.
 * That is what makes it testable with no clock, no process, and no database —
 * which is the entire reason it lives in `agent-core` instead of next to the
 * transport that produced the events.
 */

import type { ProtocolErrorInfo, RunStatus, RunTerminalState, StopReason } from '@duya/agent-protocol';
import type { RunEvent } from '@duya/agent-protocol';

/** The two event types that end a run. Everything else is non-terminal. */
const TERMINAL_TYPES = new Set<RunEvent['type']>(['run.completed', 'run.failed']);

/**
 * True when `type` ends a run.
 *
 * Kept as a function over the two literal strings rather than a re-derived
 * table: `EVENT_META` describes events, it does not decide run lifecycle, and
 * a registry lookup here would make an added event silently terminal.
 */
export function isTerminalEventType(type: RunEvent['type']): boolean {
  return TERMINAL_TYPES.has(type);
}

/** Why a run was stopped, when the caller knows something the stream does not. */
export interface RunTerminationIntent {
  /** The host asked the run to stop. */
  readonly cancelRequested?: boolean;
  /** `graceMs` elapsed and the transport had to hard-kill. */
  readonly escalated?: boolean;
  /**
   * Why the stop was asked for, in the caller's own words (`user`, `budget`,
   * `delete`, ...).
   *
   * Recorded rather than derived because it is the only thing in the durable
   * receipt that answers "who asked for this kill". A run that is `runtime_crash`
   * with `escalated: true` is, on its own, an unanswered question; the reason is
   * the half that makes it investigable.
   */
  readonly requestedReason?: string;
  /** The host is shutting down; the run did not choose to end. */
  readonly hostShutdown?: boolean;
}

export interface ResolveRunOutcomeOptions {
  /**
   * Facts the event stream cannot carry on its own. Absent means "the stream
   * said nothing", which is a real state and is treated as such.
   */
  readonly intent?: RunTerminationIntent;
  /**
   * True when a budget ceiling was reached. Distinct from an error: the run
   * did what it was told to do and then stopped, which is a different fact
   * from "it broke".
   */
  readonly budgetExhausted?: boolean;
  /** Wall-clock milliseconds the run consumed, when known. */
  readonly wallClockMs?: number;
}

/**
 * The error every run without a terminal event fails with.
 *
 * `runtime_crash` is the honest code: the stream ended without saying why, and
 * the only supportable claim is that the runtime stopped reporting.
 */
const IMPLICIT_CRASH: ProtocolErrorInfo = {
  code: 'runtime_crash',
  message: 'the run stream ended with no terminal event',
};

/**
 * Decide how a run ended.
 *
 * @param events - Every event of the run, in `seq` order.
 * @param opts  - Termination facts the stream itself cannot carry.
 */
export function resolveRunOutcome(
  events: readonly RunEvent[],
  opts: ResolveRunOutcomeOptions = {},
): RunTerminalState {
  for (const event of events) {
    if (event.type === 'run.failed') {
      return { status: 'failed', error: event.error };
    }
    if (event.type === 'run.completed') {
      return terminalFromCompletion(event.status, event.stopReason, event.cancelRequested, opts);
    }
  }

  // No terminal event. The only remaining question is WHY, and the answer
  // changes the verdict rather than just the error message.
  if (opts.budgetExhausted === true) {
    return { status: 'budget_exhausted' };
  }
  if (opts.intent?.escalated === true) {
    return {
      status: 'failed',
      error: {
        ...IMPLICIT_CRASH,
        message: 'the transport hard-killed the run before the clean cancel path completed',
        // `escalated` is the verdict; `requestedReason` is the provenance. The
        // reason is spread in only when the caller supplied one, so a verdict
        // that did not record it does not grow a fabricated value.
        details: {
          escalated: true,
          ...(opts.intent.requestedReason === undefined
            ? {}
            : { requestedReason: opts.intent.requestedReason }),
        },
      },
    };
  }
  if (opts.intent?.cancelRequested === true) {
    return { status: 'cancelled' };
  }
  return { status: 'failed', error: IMPLICIT_CRASH };
}

/**
 * Cancellation outranks a successful completion.
 *
 * `run.completed{status:'completed'}` after the host asked to stop means the
 * model finished in the same window the user pressed stop. Which of the two is
 * the truth is unobservable from the stream, so the host's own statement wins:
 * a user who pressed stop and saw the run keep going is right to be annoyed,
 * and a run log that disagrees with them is not going to help anyone debug that.
 */
function terminalFromCompletion(
  status: RunStatus,
  stopReason: StopReason | undefined,
  eventCancelRequested: boolean | undefined,
  opts: ResolveRunOutcomeOptions,
): RunTerminalState {
  const cancelRequested = eventCancelRequested === true || opts.intent?.cancelRequested === true;
  const budgetExhausted = opts.budgetExhausted === true || status === 'budget_exhausted';

  if (budgetExhausted) return { status: 'budget_exhausted' };
  if (cancelRequested || status === 'cancelled') return { status: 'cancelled' };
  return stopReason === undefined
    ? { status: 'completed' }
    : { status: 'completed', stopReason };
}

/**
 * Whether a terminal state may still be overwritten.
 *
 * Always false. The function exists so that the one-shot property is a
 * *callable* fact at the persistence layer rather than a comment there: the
 * Control Plane's terminal update goes through this, and a second writer gets
 * `false` instead of overwriting a decided history.
 */
export function isTerminal(state: RunTerminalState): boolean {
  return (
    state.status === 'completed' ||
    state.status === 'cancelled' ||
    state.status === 'budget_exhausted' ||
    state.status === 'failed'
  );
}
