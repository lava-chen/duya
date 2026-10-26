/**
 * Reconnecting run event stream for the CLI.
 *
 * The Host's SSE stream ends for reasons that are not the turn's verdict: the
 * Host restarts, a socket is reset, a laptop sleeps. Treating the first
 * transport error as the turn's result is how a healthy turn showed up as
 * `terminated` (2026-10-26) even though the worker finished and persisted the
 * answer.
 *
 * The durable event log is the source of truth, so recovery has two shapes:
 *
 *  - the run is still open → re-subscribe from the last accepted `seq`;
 *  - the run already settled while this client was away → replay what is left
 *    from the durable log, then let the caller read the run record for the
 *    verdict.
 *
 * The cursor is the highest `seq` this generator actually yielded, so a
 * resumed stream never re-delivers an event the consumer may have rendered —
 * and `HostEventStream` dedupes anyway, which makes any overlap harmless.
 */

import type { RunEventEnvelope, RunId } from '@duya/agent-protocol';
import { HostSessionHttpError, type HostSessionHttpClient } from '@duya/host/http-client';

/** Delays between recovery attempts; the last value repeats. */
const DEFAULT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000] as const;

/** Pages of durable events replayed after a settled run. */
const REPLAY_PAGE_SIZE = 500;

export interface RunEventResumeOptions {
  readonly signal?: AbortSignal;
  readonly retryDelaysMs?: readonly number[];
  /** Called once per drop, before the first recovery attempt. */
  readonly onRecovering?: (error: unknown) => void;
  /** Called when the stream is open again after a drop. */
  readonly onRecovered?: () => void;
}

type RunEventSource = Pick<
  HostSessionHttpClient,
  'watchAgentRunEvents' | 'getAgentRun' | 'readAgentRunEvents'
>;

/**
 * Yield the run's events, surviving transport drops until the run settles.
 *
 * Throws when recovery is impossible (the run is gone, or the Host refused the
 * credentials) and after the retry budget is spent.
 */
export async function* watchRunEventsWithResume(
  client: RunEventSource,
  runId: RunId,
  options: RunEventResumeOptions = {},
): AsyncGenerator<RunEventEnvelope, void, void> {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let cursor = 0;
  let recovering = false;

  resume: for (;;) {
    try {
      for await (const event of client.watchAgentRunEvents(runId, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(cursor > 0 ? { afterSeq: cursor } : {}),
      })) {
        cursor = Math.max(cursor, event.seq);
        yield event;
      }
      return;
    } catch (error) {
      if (options.signal?.aborted === true || isPermanent(error)) throw error;
      if (!recovering) {
        recovering = true;
        options.onRecovering?.(error);
      }

      for (let attempt = 0; attempt < delays.length; attempt += 1) {
        await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 0, options.signal);
        if (options.signal?.aborted) throw error;
        let record: Awaited<ReturnType<RunEventSource['getAgentRun']>>;
        try {
          record = await client.getAgentRun(runId);
        } catch (readError) {
          if (isPermanent(readError)) throw readError;
          continue;
        }
        if (record === null) throw error;
        if (record.terminal === null) {
          // Still running: reopen the stream from the cursor.
          recovering = false;
          options.onRecovered?.();
          continue resume;
        }
        // Settled while this client was away. The live stream may no longer
        // carry the history it missed, so replay the durable log instead.
        let after = cursor;
        for (;;) {
          const events = await client.readAgentRunEvents(runId, {
            afterSeq: after,
            limit: REPLAY_PAGE_SIZE,
          });
          for (const event of events) {
            if (event.seq <= cursor) continue;
            cursor = event.seq;
            yield event;
          }
          if (events.length < REPLAY_PAGE_SIZE) break;
          after = cursor;
        }
        if (recovering) options.onRecovered?.();
        return;
      }

      throw error;
    }
  }
}

/** A 4xx that retrying cannot fix: the run is gone, or the token is wrong. */
function isPermanent(error: unknown): boolean {
  if (!(error instanceof HostSessionHttpError)) return false;
  return error.status === 401 || error.status === 403 || error.status === 404;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
