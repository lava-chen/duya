/**
 * The event envelope and the control plane.
 *
 * ## Why the wire CHANNELS live here and not in `transport.ts`
 *
 * `EventSink` / `EventSource` describe how envelopes move, not how a host binds
 * to a runtime. They were originally in `transport.ts`, which made `run.ts`
 * import from `transport.ts` while `transport.ts` imported `RunHandle` back —
 * a dependency cycle, the one thing drift test #2 exists to forbid. The fix is
 * layering, not a `// eslint-disable`: the channel primitives sit with the
 * envelope shapes they carry, `run.ts` depends on this module, and `transport.ts`
 * depends on both. One direction, no cycle.
 *
 * ## `seq` ownership moved from the host to the runtime
 *
 * The id space is PER-SESSION but the counter is PER-TURN. Every POST reopens
 * the stream with `let seqNum = 0` (router.ts:1329) and increments from there
 * (:1568), writing that value as the SSE `id:` and pushing it into the
 * session-wide ring via `updateLastEventId` / `recordEvent` (:1569-1570).
 * `session.lastEventId` and the ring are never reset between turns, so **turn
 * two re-mints ids 1..M that turn one already used.**
 *
 * The reconnect path is NOT the broken part — it was already fixed. Replay
 * writes each record's original `eventId` (router.ts:2412-2423) and the live
 * counter resumes from `session.lastEventId` (:2437, with the regression note
 * at :2432-2436 recording the `let seqNum = 0` bug that preceded it). What
 * breaks is the collision above: `getEventsSince(sessionId, lastEventId)`
 * (:2411) filters on `eventId > lastEventId`, so after a second turn a
 * reconnecting client can be handed turn-one events, or be handed nothing at
 * all, depending on which turn wrote last.
 *
 * Minting `seq` in the runtime fixes this by construction: the counter lives
 * with the ring that consumes it, so one turn can never reissue another's
 * ids, and `Last-Event-ID` becomes a property of the construction rather than
 * something the host has to reconstruct.
 *
 * ## Control frames are not events
 *
 * `ControlFrame` is unnumbered, unpersisted, and not part of the stream. It
 * carries `hello` / `ready` / `error`. Folding it into the event union would
 * force every host to handle it in transcript reconstruction.
 */

import type {
  EventTimestamp,
  RunId,
  SessionId,
  SpanId,
  TraceId,
} from './primitives.js';
import type { ProtocolErrorInfo, ErrorCode } from './errors.js';
import type { RuntimeCapabilities } from './capabilities.js';
import type { RunEvent } from './events/registry.js';

export interface RunEventEnvelope<T extends RunEvent = RunEvent> {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  /** Per-run, starts at 1, strictly +1, MINTED BY THE RUNTIME. */
  readonly seq: number;
  /** Epoch ms; a virtual clock when `manifest.deterministic` is set. */
  readonly timestamp: EventTimestamp;
  readonly traceId: TraceId;
  readonly spanId?: SpanId;
  /** Present only when this run is a resume or a fork. */
  readonly parentRunId?: RunId;
  readonly payload: T;
}

/** An event the decoder did not recognise. Never durable, never persisted. */
export interface UnknownEnvelope {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly timestamp: EventTimestamp;
  readonly traceId: TraceId;
  readonly payload: { readonly kind: 'unknown'; readonly type: string; readonly raw: unknown };
}

export type WireEnvelope = RunEventEnvelope | UnknownEnvelope;

export interface HelloFrame {
  readonly kind: 'hello';
  readonly protocol: { readonly major: number; readonly minor: number };
  readonly host: { readonly name: string; readonly version: string };
}

export interface ReadyFrame {
  readonly kind: 'ready';
  readonly runtime: { readonly name: string; readonly version: string; readonly pid?: number };
  readonly capabilities: RuntimeCapabilities;
}

export interface ErrorFrame {
  readonly kind: 'error';
  readonly error: ProtocolErrorInfo;
}

/** Control-plane frame. Not an event: unnumbered, unpersisted, off-stream. */
export type ControlFrame = HelloFrame | ReadyFrame | ErrorFrame;

/** Envelope construction rules, stated once so every runtime agrees. */
export const SEQ_CONTRACT = {
  start: 1,
  step: 1,
  /** Minted by the runtime, never by a host or an adapter. */
  owner: 'runtime' as const,
  /** `Last-Event-ID` carries this value verbatim. */
  resumeHeader: 'Last-Event-ID' as const,
} as const;

export function isValidSeq(seq: unknown): seq is number {
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= SEQ_CONTRACT.start;
}

// ── wire channels ──────────────────────────────────────────────────────
// Primitive channels over envelopes. Transport-agnostic by construction: they
// say nothing about bytes, HTTP, IPC, or MessagePort. Adapters live in
// `packages/agent-runtime/transport/*` and implement these.

export type WireEvent = RunEventEnvelope | UnknownEnvelope;

/** Host -> runtime. The ONLY way run state propagates. */
export interface EventSink {
  emit(event: RunEventEnvelope): void;
  close(frame?: ControlFrame): void;
  readonly closed: boolean;
}

/** Runtime -> host. Async so a bounded buffer can apply backpressure. */
export interface EventSource extends AsyncIterable<WireEnvelope> {
  close(): void;
}
