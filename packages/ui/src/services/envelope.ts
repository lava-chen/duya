/**
 * Wire decoding for the browser transport.
 *
 * Every value that arrives from `fetch` is `unknown` until something says
 * otherwise, and the client is the last place that can say it. The BFF is a
 * same-origin facade over a typed Host API, but it speaks JSON over HTTP: the
 * types in `@duya/agent-protocol` describe the SHAPE, not the bytes on this
 * socket. A browser client that casts without looking produces two failures
 * that both look like "the server is broken": a render crash on a malformed
 * frame, and — worse — a frame that parses into an envelope with a plausible
 * `seq` but no payload, which the surface model would then admit as progress.
 *
 * So decoding here rejects rather than repairs. A rejected frame is dropped and
 * counted; it never becomes a half-truth.
 */

import type { RunEventEnvelope, SessionId, RunId } from '@duya/agent-protocol';
import type { SseFrame } from './sse.js';

/** What one SSE frame turned out to be. */
export type DecodedRunFrame =
  | { readonly kind: 'envelope'; readonly envelope: RunEventEnvelope }
  /** The BFF's own failure frame: `{ status, code }` with `event: error`. */
  | { readonly kind: 'stream_error'; readonly code: string }
  | { readonly kind: 'ignored'; readonly reason: IgnoredFrameReason };

export type IgnoredFrameReason =
  | 'unknown_event'
  | 'malformed_json'
  | 'malformed_envelope'
  | 'empty_payload';

/** The event name the BFF writes for a Host envelope. */
export const RUN_EVENT_NAME = 'run';
/** The event name the BFF writes when its upstream Host reader fails. */
export const STREAM_ERROR_EVENT_NAME = 'error';

/**
 * Turn one SSE frame into either a protocol envelope, a reported stream
 * failure, or a counted rejection.
 */
export function decodeRunFrame(frame: SseFrame): DecodedRunFrame {
  if (frame.event === STREAM_ERROR_EVENT_NAME) {
    const code = readErrorCode(frame.data);
    return { kind: 'stream_error', code };
  }
  if (frame.event !== RUN_EVENT_NAME) return { kind: 'ignored', reason: 'unknown_event' };
  if (frame.data === '') return { kind: 'ignored', reason: 'malformed_json' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    return { kind: 'ignored', reason: 'malformed_json' };
  }
  const envelope = readRunEventEnvelope(parsed);
  if (envelope === null) return { kind: 'ignored', reason: 'malformed_envelope' };
  return { kind: 'envelope', envelope };
}

function readErrorCode(data: string): string {
  try {
    const parsed: unknown = JSON.parse(data);
    if (isRecord(parsed) && typeof parsed['code'] === 'string' && /^[a-z0-9_]{1,80}$/.test(parsed['code'])) {
      return parsed['code'];
    }
  } catch {
    // A failure frame with an unreadable body still names itself as a failure.
  }
  return 'upstream_unavailable';
}

/**
 * Validate one decoded JSON value as a `RunEventEnvelope`, or return `null`.
 *
 * The payload is the one field that cannot be validated structurally — it is
 * the protocol's full event union, and only the payload itself knows which
 * variant it is. The shared surface model is the exhaustive switch over that
 * union, and it answers unknown types with "no effect" rather than a guess, so
 * a payload this function cannot recognise degrades to a no-op instead of a
 * fabricated row. Everything the ENVELOPE contributes — identity and the
 * sequence number, which are what admission and ordering depend on — is checked
 * here.
 */
export function readRunEventEnvelope(value: unknown): RunEventEnvelope | null {
  if (!isRecord(value)) return null;
  const runId = value['runId'];
  const sessionId = value['sessionId'];
  const seq = value['seq'];
  const timestamp = value['timestamp'];
  const traceId = value['traceId'];
  if (typeof runId !== 'string' || runId === '') return null;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return null;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  if (typeof traceId !== 'string') return null;

  const payload = value['payload'];
  if (!isRecord(payload) || typeof payload['type'] !== 'string' || payload['type'] === '') return null;

  const parentRunId = value['parentRunId'];
  const spanId = value['spanId'];
  return {
    runId: runId as RunId,
    sessionId: sessionId as SessionId,
    seq,
    timestamp,
    traceId,
    ...(typeof parentRunId === 'string' ? { parentRunId } : {}),
    ...(typeof spanId === 'string' ? { spanId } : {}),
    // The payload's discriminant was verified above; the variant's own fields
    // are the shared model's business, not this transport's.
    payload: payload as unknown as RunEventEnvelope['payload'],
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
