/**
 * Session-level exits that do NOT create a run.
 *
 * A compaction and a side question are both things a client can ask for
 * WITHOUT starting a turn: compaction rewrites the transcript in place, and a
 * side question is a one-shot answer that never touches the durable history.
 * Neither has a `runId`, so neither can live under the `/v1/agent-runs`
 * namespace — every sub-path there is understood as run lifecycle.
 *
 * These are therefore SESSION-level contracts, injected into the Host HTTP
 * server as OPTIONAL capabilities, exactly like `HostRunExecutionApiV1`. A
 * Host that did not assemble them answers 404 with a named code instead of
 * pretending the feature exists.
 */

import type { SessionId } from './primitives.js';

/** What the caller asks for. `instructions` is the user's own compaction hint. */
export interface SessionCompactInput {
  readonly sessionId: SessionId;
  /**
   * Free-form instructions forwarded to the worker's summarizer.
   *
   * Deliberately the ONLY knob exposed: `strategy` and `maxMessagesToKeep`
   * exist worker-side, but they are internal dials whose meaning a caller
   * cannot infer, so they are not part of this contract.
   */
  readonly instructions?: string;
}

/**
 * The terminal outcome of a compaction.
 *
 * `status:'ok'` means the transcript was rewritten. `status:'error'` means it
 * was NOT — the two must never collapse into one answer, because "nothing
 * happened" and "it happened" are opposite instructions for the caller.
 */
export type SessionCompactResult =
  | {
      readonly status: 'ok';
      readonly strategy: string;
      readonly tokensRemoved: number;
      readonly tokensRetained: number;
      readonly removedCount: number;
      readonly messageCount: number;
    }
  | { readonly status: 'error'; readonly code: string; readonly message: string };

/**
 * The frames a compaction stream carries.
 *
 * A compaction is a multi-minute LLM call, so the transport is a stream with
 * a keepalive rather than one long POST that answers at the end: the worker
 * can go quiet for minutes, and a silent connection is a connection a proxy
 * will cut.
 */
export type SessionCompactEvent =
  | { readonly event: 'compact:started'; readonly data: { readonly sessionId: SessionId } }
  | { readonly event: 'compact:keepalive'; readonly data: { readonly at: number } }
  | {
      readonly event: 'compact:completed';
      readonly data: Extract<SessionCompactResult, { status: 'ok' }>;
    }
  | {
      readonly event: 'compact:failed';
      readonly data: Extract<SessionCompactResult, { status: 'error' }>;
    };

/**
 * What `reserve` hands back.
 *
 * A refusal carries the HTTP status and the structured code the route must
 * answer with. The success arm carries the event stream.
 */
export type SessionCompactReservation =
  | { readonly ok: true; readonly events: AsyncIterable<SessionCompactEvent> }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

/**
 * Session-level manual compaction.
 *
 * ## Why `reserve` is synchronous
 *
 * The route has to decide between a JSON error (404/409) and a `200` SSE
 * stream BEFORE it writes a single header. A promise-shaped API cannot
 * express that: the route would have to await the promise to learn whether it
 * may stream, and by then it has already committed to a response shape.
 *
 * So the capability RESERVES the session slot synchronously and hands back
 * the stream. The reservation is released when the stream finishes — or when
 * the consumer stops early.
 */
export interface HostSessionCompactionApiV1 {
  reserve(input: SessionCompactInput): SessionCompactReservation;
}

/**
 * A side question: one answer, no transcript change, no run.
 *
 * Not guarded on session busyness on purpose. A side question exists to be
 * asked WHILE a turn is running — that is the whole feature — so refusing it
 * because a turn is in flight would defeat it.
 */
export interface HostSessionSideQuestionApiV1 {
  ask(input: { sessionId: SessionId; question: string }): Promise<{ answer: string }>;
}
