/**
 * Pure JSON and identity validation for run-event stream frames.
 *
 * The caller owns transport acquisition and decides how to report rejected
 * frames. This module validates envelope identity and ordering fields before
 * a caller admits the event to shared run state.
 */

import type { RunEventEnvelope, SessionId, RunId } from '@duya/agent-protocol';
import type { SseFrame } from './sse.js';

/** What one SSE frame turned out to be. */
export type DecodedRunFrame =
  | { readonly kind: 'envelope'; readonly envelope: RunEventEnvelope }
  /** The stream transport failure frame: `{ status, code }` with `event: error`. */
  | { readonly kind: 'stream_error'; readonly code: string }
  | { readonly kind: 'ignored'; readonly reason: IgnoredFrameReason };

export type IgnoredFrameReason =
  | 'unknown_event'
  | 'malformed_json'
  | 'malformed_envelope'
  | 'empty_payload';

/** The event name assigned to a run envelope. */
export const RUN_EVENT_NAME = 'run';
/** The event name assigned to a stream failure. */
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
 * Validate the envelope fields needed for run/session identity and ordering.
 *
 * The payload check is deliberately shallow: it requires an object and a
 * non-empty discriminant, but does not validate variant-specific fields. The
 * protocol union supplies compile-time shapes; the shared surface model owns
 * event handling. This decoder must not be described as full payload validation.
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
