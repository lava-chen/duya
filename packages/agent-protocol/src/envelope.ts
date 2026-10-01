/**
 * The event envelope and the control plane.
 *
 * Design source: 07-agent-protocol-spec.md §2 and §2.1.
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
 * ## `seq` ownership moved from the host to the runtime (07 §2.1)
 *
 * Today `seqNum` is a PER-CONNECTION counter (router.ts:1329, assigned at
 * :1568), and `handleGetChat` replays buffered events through a FRESH counter
 * (:2479) while writing an `id:` taken from the ring's original `eventId`
 * (:2423). The consequence is concrete: **a replayed event's `id` does not
 * match the original stream**, so `Last-Event-ID` resumption cannot be trusted.
 *
 * Minting `seq` in the runtime fixes both half at once: `id` is identically
 * `seq`, and resumption becomes a property of the construction rather than
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
