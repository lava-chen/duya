/**
 * The one place a run projection is composed.
 *
 * A renderer that opens a run needs three things at once, and they have to be
 * the SAME run:
 *
 *  1. the live event stream, projected through `RunSession`, and
 *  2. the durable ledger row, which is the only thing that can say the run
 *     actually ENDED, and
 *  3. a scope, so that switching sessions tears all of it down.
 *
 * The tempting shortcut is to treat the stream's end as the run's end. That is
 * wrong in a way users see: a dropped socket, a cancelled worker, a Host
 * restart all look like "the stream stopped", and a client that reads that as
 * "the run finished" shows a completed answer for a turn that never ran. So
 * the terminal state here comes from the ledger, always, and the stream only
 * ever supplies content.
 *
 * ## Why this is shared
 *
 * The Web surface and the Desktop surface must agree on what a run LOOKED
 * like. Two compositions of the same three ingredients would drift — one
 * would learn to trust the stream, the other would learn to poll harder — and
 * the drift would only show up on the surface that changed last. One
 * implementation, two transports.
 */

import type { AgentRunRecord, RunId, SessionId } from '@duya/agent-protocol';
import { RunSession } from './run-session.js';
import { RunEventStream, delay, type RunEventStreamOptions } from './run-event-stream.js';
import type { HostApiBridge } from '../transport/host-api.js';

/** The durable run fields a projection reports. */
export type DurableRunStatus = AgentRunRecord['status'];

export interface RunProjectionOptions {
  readonly bridge: HostApiBridge;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  /** Selection scope. Aborting it stops the stream and the ledger poll. */
  readonly signal: AbortSignal;
  /** How often the durable ledger is re-read while the run is open. */
  readonly ledgerPollIntervalMs?: number;
  /** How often the ledger is polled when the bridge cannot stream. */
  readonly fallbackPollIntervalMs?: number;
  readonly reconnectDelayMs?: number;
  readonly stallTimeoutMs?: number;
  readonly onState?: RunEventStreamOptions['onState'];
  readonly onRejected?: RunEventStreamOptions['onRejected'];
}

/** What a caller holds onto: a projection it can read and subscribe to. */
export interface RunProjection {
  getSnapshot(): ReturnType<RunSession['getSnapshot']>;
  /** Latest durable Host ledger status; null until the first ledger read. */
  getDurableStatus(): DurableRunStatus | null;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  settled(): Promise<void>;
}

const DEFAULT_LEDGER_POLL_MS = 1_000;
const DEFAULT_FALLBACK_POLL_MS = 250;

/**
 * Open one run projection.
 *
 * The returned object is inert until `start()` is called, so a caller can
 * subscribe to it before any event arrives without racing the first frame.
 */
export function createRunProjection(options: RunProjectionOptions): RunProjection {
  const bridge = options.bridge;
  const listeners = new Set<() => void>();
  const pollController = new AbortController();
  // The composition owns the surface. The stream feeds it, and so does the
  // durable-window fallback, so both paths project into the SAME state.
  const session = new RunSession({ runId: options.runId, sessionId: options.sessionId });
  let durableStatus: DurableRunStatus | null = null;
  let terminalObserved = false;
  let stopped = false;
  let stream: RunEventStream | null = null;
  let streamStop: (() => void) | null = null;
  let ledgerPoll: Promise<void> | null = null;
  let fallbackPoll: Promise<void> | null = null;
  let removeScopeAbort = (): void => undefined;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    pollController.abort();
    streamStop?.();
    stream?.stop();
    removeScopeAbort();
  };

  const openStream = bridge.openRunStream;
  if (openStream !== undefined) {
    const eventStream = new RunEventStream({
      runId: options.runId,
      sessionId: options.sessionId,
      session,
      openStream,
      signal: options.signal,
      ...(options.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: options.reconnectDelayMs }),
      ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
      ...(options.onState === undefined ? {} : { onState: options.onState }),
      ...(options.onRejected === undefined ? {} : { onRejected: options.onRejected }),
      onEnd: () => {
        // A terminal ledger row proves the run ended, but the stream still owns
        // the last durable tail. Close only after a clean EOF observed after
        // that ledger read, including a replay after reconnect.
        if (!terminalObserved) return;
        stop();
      },
    });
    stream = eventStream;
    streamStop = () => eventStream.stop();
    eventStream.subscribe(() => notify());
  }

  const onScopeAbort = (): void => stop();
  options.signal.addEventListener('abort', onScopeAbort, { once: true });
  removeScopeAbort = () => {
    options.signal.removeEventListener('abort', onScopeAbort);
    for (const listener of listeners) listeners.delete(listener);
  };
  if (options.signal.aborted) stop();

  /**
   * Read the durable ledger and publish the terminal status.
   *
   * The status is only ever REPORTED, never invented: a read that fails leaves
   * the previous status in place, so a transient Host hiccup cannot turn a
   * running run into a failed one.
   */
  const readLedger = async (): Promise<void> => {
    try {
      const runs = await bridge.listRuns(options.sessionId, 50);
      if (stopped || pollController.signal.aborted) return;
      const record = runs.find((candidate) => candidate.runId === options.runId);
      if (record === undefined) return;
      const status = record.status;
      if (status !== durableStatus) {
        durableStatus = status;
        notify();
      }
      if (status !== 'running') terminalObserved = true;
    } catch {
      // A transient ledger read failure must not invent terminal state or stop
      // replay; the next poll can recover it.
    }
  };

  const pollLedger = async (): Promise<void> => {
    const intervalMs = options.ledgerPollIntervalMs ?? DEFAULT_LEDGER_POLL_MS;
    while (!stopped && !pollController.signal.aborted) {
      await readLedger();
      if (stopped || !(await delay(intervalMs, pollController.signal))) break;
    }
  };

  /**
   * The no-stream fallback: read durable windows on a cursor.
   *
   * This is exact, not approximate. The cursor is the surface's own
   * `lastAcceptedSeq`, so a window is never re-applied and never skipped. It
   * is only slower, because the client asks instead of being pushed to.
   */
  const pollWindows = async (): Promise<void> => {
    const intervalMs = options.fallbackPollIntervalMs ?? DEFAULT_FALLBACK_POLL_MS;
    while (!stopped && !pollController.signal.aborted) {
      try {
        const cursor = session.getSnapshot().lastAcceptedSeq;
        const events = await bridge.readRunEvents(options.runId, cursor, 500);
        if (stopped || pollController.signal.aborted) break;
        if (events.length > 0) {
          session.acceptWindow(events);
          notify();
        }
      } catch {
        // Same rule as the ledger read: a failed read is not a terminal state.
      }
      if (stopped || !(await delay(intervalMs, pollController.signal))) break;
    }
  };

  return {
    getSnapshot: () => session.getSnapshot(),
    getDurableStatus: () => durableStatus,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      if (stopped) return;
      stream?.start();
      ledgerPoll ??= pollLedger();
      if (stream === null) fallbackPoll ??= pollWindows();
    },
    stop,
    settled: async () => {
      await Promise.all([
        stream?.settled() ?? Promise.resolve(),
        ledgerPoll ?? Promise.resolve(),
        fallbackPoll ?? Promise.resolve(),
      ]);
    },
  };
}
