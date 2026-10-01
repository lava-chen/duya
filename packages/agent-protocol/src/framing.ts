/**
 * Framing: bytes to envelopes and back, with explicit resource limits.
 *
 * ## Why this is its own file
 *
 * puts SSE<->envelope and NDJSON<->envelope both in `codecs.ts`, which
 * conflates three separate concerns. pi-protocol splits them —
 * `framing.ts` / `codec.ts` / `schemas.ts` — and its README states the rule
 * directly: framing is handled "independently of schemas". Adopted here.
 *
 * ## The three limits
 *
 * The first draft declared `maxEventBytes` with no default and no nesting or
 * element limit at all. pi-protocol sets all three explicitly. Adopted with the
 * same values so the two packages do not disagree silently.
 *
 * ## Validate the declared length BEFORE buffering
 *
 * This ordering is the security-relevant one. A decoder that buffers first and
 * validates later will happily accept a declared length of 4 GiB and try to
 * hold it. Every decoder here rejects on the header alone.
 *
 * ## No JSON accumulator
 *
 * step 3 deletes router.ts:1334-1386, a 64 KB-capped buffer that
 * existed only because `sendEvent` could emit a multi-line JSON body. The
 * protocol mandates exactly one `JSON.stringify` per line, so a bare newline
 * inside a frame is a protocol violation, not something to accumulate around.
 */

import { DEFAULT_LIMITS, type ProtocolLimits } from './capabilities.js';
import type { JsonValue } from './hash.js';
import { ProtocolError } from './errors.js';

export type { ProtocolLimits };

export type FrameEncoding = 'ndjson' | 'sse';

export const LIMITS: ProtocolLimits = DEFAULT_LIMITS;

// ── NDJSON ────────────────────────────────────────────────────────────────

/**
 * One `JSON.stringify` per line. Never produces a bare newline, so a decoder
 * can split on `\n` and be done.
 */
export function encodeNdjson(value: JsonValue, limits: ProtocolLimits = LIMITS): string {
  const line = JSON.stringify(value);
  assertByteBudget(line, limits);
  return `${line}\n`;
}

/**
 * Parse one frame's JSON, converting a parse failure into a `ProtocolError`.
 *
 * Without this wrapper a malformed frame throws a bare `SyntaxError`, and a
 * caller written to catch `ProtocolError` — which is the only error type this
 * package documents — propagates it into the transport loop instead of
 * handling it. The two failure modes then look identical to an operator (both
 * kill the stream) while only one of them is diagnosed.
 */
function parseFrame(line: string): JsonValue {
  try {
    return JSON.parse(line) as JsonValue;
  } catch (error) {
    throw new ProtocolError({
      code: 'invalid_event_frame',
      message: `frame is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
    });
  }
}

export function decodeNdjson<T = JsonValue>(
  text: string,
  limits: ProtocolLimits = LIMITS,
): T[] {
  const out: T[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) break;
    const line = text.slice(start, nl);
    start = nl + 1;
    if (line.length === 0) continue;
    assertByteBudget(line, limits);
    out.push(parseFrame(line) as T);
  }
  const tail = text.slice(start);
  if (tail.length) {
    assertByteBudget(tail, limits);
    out.push(parseFrame(tail) as T);
  }
  return out;
}

// ── SSE ───────────────────────────────────────────────────────────────────

/**
 * Field order is fixed: `id:` -> `event:` -> `data:`. `id` is the envelope's
 * `seq` verbatim, which is what makes `Last-Event-ID` resumption work.
 *
 * ## The frame is measured, not walked
 *
 * The first draft called `assertByteBudget` twice: once on the serialised data,
 * then again on the assembled frame — which contains that same data, so the
 * large part of the string was walked twice per frame. On the highest-rate path
 * in the protocol that is pure waste.
 *
 * The frame's length is the data's length plus a bounded header and a two-byte
 * terminator, so the second check measures the header alone and adds. The result
 * is identical and the cost is independent of payload size.
 */
export function encodeSseFrame(
  seq: number,
  eventType: string,
  envelope: JsonValue,
  limits: ProtocolLimits = LIMITS,
): string {
  const data = JSON.stringify(envelope);
  const dataBytes = assertByteBudget(data, limits);
  const prefix = `id: ${seq}\nevent: ${eventType}\ndata: `;
  const terminator = '\n\n';
  const totalBytes = dataBytes + byteLength(prefix) + byteLength(terminator);
  if (totalBytes > limits.maxEventBytes) {
    throw new ProtocolError({
      code: 'invalid_event_frame',
      message: `frame is ${totalBytes} bytes, maxEventBytes is ${limits.maxEventBytes}`,
    });
  }
  return `${prefix}${data}${terminator}`;
}

export interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

export function decodeSseFrames(text: string, limits: ProtocolLimits = LIMITS): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let id: string | undefined;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    const data = dataLines.join('\n');
    assertByteBudget(data, limits);
    // `exactOptionalPropertyTypes` is on: an absent `id` must be an ABSENT
    // property, not `id: undefined`.
    frames.push({
      ...(id !== undefined ? { id } : {}),
      ...(event !== undefined ? { event } : {}),
      data,
    });
  }
  return frames;
}

// ── length-prefixed (in-process / subprocess) ─────────────────────────────

/**
 * 4-byte unsigned big-endian length prefix, then the payload. The declared
 * length is validated BEFORE any payload byte is buffered.
 */
export class LengthPrefixedDecoder {
  #buffer: Uint8Array = new Uint8Array(0);
  readonly #limits: ProtocolLimits;

  constructor(limits: ProtocolLimits = LIMITS) {
    this.#limits = limits;
  }

  /** Feed arbitrary fragmentation; returns every complete payload available. */
  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer, 0);
    merged.set(chunk, this.#buffer.length);

    const out: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      if (merged.length - offset < 4) break;
      const view = new DataView(merged.buffer, merged.byteOffset + offset, 4);
      const declared = view.getUint32(0, false);
      // Header-only check: reject before allocating or buffering the payload.
      if (declared > this.#limits.maxEventBytes) {
        throw new ProtocolError({
          code: 'invalid_event_frame',
          message: `declared frame length ${declared} exceeds maxEventBytes ${this.#limits.maxEventBytes}`,
        });
      }
      if (merged.length - offset - 4 < declared) break;
      out.push(merged.slice(offset + 4, offset + 4 + declared));
      offset += 4 + declared;
    }
    this.#buffer = merged.slice(offset);
    return out;
  }

  /** Call when the stream closes, to detect truncation. */
  end(): void {
    if (this.#buffer.length) {
      throw new ProtocolError({
        code: 'invalid_event_frame',
        message: `stream ended with ${this.#buffer.length} trailing byte(s)`,
      });
    }
  }

  get pending(): number {
    return this.#buffer.length;
  }
}

export function encodeLengthPrefixed(payload: Uint8Array, limits: ProtocolLimits = LIMITS): Uint8Array {
  if (payload.byteLength > limits.maxEventBytes) {
    throw new ProtocolError({
      code: 'invalid_event_frame',
      message: `payload ${payload.byteLength} exceeds maxEventBytes ${limits.maxEventBytes}`,
    });
  }
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength, false);
  out.set(payload, 4);
  return out;
}

// ── structural limits ─────────────────────────────────────────────────────

/**
 * Enforce the byte budget, and report the measured size.
 *
 * Returning the count lets a caller that is about to build a larger string
 * containing this one add the two lengths instead of re-measuring the whole
 * assembly. The existing callers ignore the return value, so this is additive.
 */
function assertByteBudget(value: string, limits: ProtocolLimits): number {
  const bytes = byteLength(value);
  if (bytes > limits.maxEventBytes) {
    throw new ProtocolError({
      code: 'invalid_event_frame',
      message: `frame is ${bytes} bytes, maxEventBytes is ${limits.maxEventBytes}`,
    });
  }
  return bytes;
}

/**
 * UTF-8 byte length of a string.
 *
 * ## Why this is not a hand-rolled char loop
 *
 * The first draft walked the string in JS, testing each code unit against
 * 0x80 / 0x800 / surrogate ranges. Correct, allocation-free, and slower than
 * the native path on every runtime that has one — while the rest of this
 * repository has been calling `Buffer.byteLength(s, 'utf8')` for its byte
 * budgets all along (25+ call sites under `electron/`).
 *
 * The native fast path is used when `Buffer` exists, which covers Electron
 * main, the agent subprocess, and every Node-side host. The loop remains as the
 * fallback because this package is deliberately reachable from a renderer, where
 * `nodeIntegration` is off and `Buffer` is undefined. A guard costs one property
 * read per call; dropping the fallback would move a perf win into a crash.
 */
export function byteLength(value: string): number {
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(value, 'utf8');
  }
  return utf8LengthFallback(value);
}

function utf8LengthFallback(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Enforce the element-count and nesting-depth limits on a decoded value. */
export function assertWithinStructuralLimits(
  value: JsonValue,
  limits: ProtocolLimits = LIMITS,
): void {
  const walk = (node: JsonValue, depth: number): void => {
    if (depth > limits.maxNestingDepth) {
      throw new ProtocolError({
        code: 'invalid_event_frame',
        message: `nesting depth exceeds ${limits.maxNestingDepth}`,
      });
    }
    if (Array.isArray(node)) {
      if (node.length > limits.maxSequenceLength) {
        throw new ProtocolError({
          code: 'invalid_event_frame',
          message: `array length ${node.length} exceeds ${limits.maxSequenceLength}`,
        });
      }
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (node !== null && typeof node === 'object') {
      const record = node as { readonly [key: string]: JsonValue };
      const keys = Object.keys(record);
      if (keys.length > limits.maxSequenceLength) {
        throw new ProtocolError({
          code: 'invalid_event_frame',
          message: `map entries ${keys.length} exceeds ${limits.maxSequenceLength}`,
        });
      }
      for (const key of keys) walk(record[key] as JsonValue, depth + 1);
    }
  };
  walk(value, 0);
}
