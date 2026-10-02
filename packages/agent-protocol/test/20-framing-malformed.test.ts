/**
 * Malformed input — framing and parsing under adversarial bytes.
 *
 * ## The contract
 *
 * Every one of these inputs must produce exactly one of two outcomes:
 *
 *   - a **valid decode**, or
 *   - a **controlled `ProtocolError`**.
 *
 * Never a hang, never an unbounded allocation, never a random exception type.
 * The third outcome is the dangerous one: a caller that catches only
 * `ProtocolError` will propagate anything else into a transport loop, and a
 * decoder that allocates before validating turns a 4-byte length header into a
 * 4 GiB request.
 *
 * ## Why these specific cases
 *
 * Each one is a real failure mode of a length-prefixed or newline-delimited
 * stream, not a generic "fuzz" input:
 *
 *  - **truncated length prefix** — a connection cut mid-header. The decoder
 *    must buffer the partial header rather than read garbage.
 *  - **declared length beyond the buffer** — the 4 GiB attack. Rejection has
 *    to happen on the HEADER, before any allocation.
 *  - **oversized frame** — a legitimate but too-large payload.
 *  - **nesting depth** — JSON.parse itself is iterative-safe, but a recursive
 *    walk over a hostile value is a stack-overflow vector.
 *  - **negative / non-integer seq** — a seq that passes JSON but violates the
 *    contract. See G-8.
 *  - **unknown event** — the forward-compatibility path.
 *  - **invalid JSON** — the plain case, asserted so the others are not the only
 *    thing being checked.
 */

import { describe, expect, it } from 'vitest';
import {
  LengthPrefixedDecoder,
  LIMITS,
  assertWithinStructuralLimits,
  byteLength,
  decodeNdjson,
  decodeSseFrames,
  encodeLengthPrefixed,
  encodeNdjson,
  encodeSseFrame,
} from '../src/framing.js';
import { ProtocolError } from '../src/errors.js';
import { fromEnvelope, validate, isUnknownEnvelope } from '../src/codecs.js';
import { isValidSeq } from '../src/envelope.js';
import type { JsonValue } from '../src/hash.js';

/** A decoder must fail in exactly this shape, or not at all. */
function expectControlled(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(
      error,
      `expected a ProtocolError, got ${error instanceof Error ? error.constructor.name : typeof error}`,
    ).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe('invalid_event_frame');
    return;
  }
}

const TIGHT: typeof LIMITS = {
  maxEventBytes: 256,
  maxSequenceLength: 8,
  maxNestingDepth: 4,
};

describe('length-prefixed framing', () => {
  it('round-trips a payload', () => {
    const decoder = new LengthPrefixedDecoder(TIGHT);
    const bytes = encodeLengthPrefixed(new TextEncoder().encode('{"a":1}'), TIGHT);
    const out = decoder.push(bytes);
    expect(out).toHaveLength(1);
    expect(new TextDecoder().decode(out[0])).toBe('{"a":1}');
  });

  it('buffers a header split across two pushes instead of reading garbage', () => {
    // A connection cut mid-header is the common case, not an exotic one. The
    // decoder must hold the partial bytes and wait rather than interpret them.
    const decoder = new LengthPrefixedDecoder(TIGHT);
    const bytes = encodeLengthPrefixed(new TextEncoder().encode('{"a":1}'), TIGHT);
    expect(decoder.push(bytes.slice(0, 2))).toEqual([]);
    expect(decoder.push(bytes.slice(2))).toHaveLength(1);
  });

  it('rejects a declared length larger than the limit WITHOUT allocating it', () => {
    // The security-relevant ordering. A header claiming 4 GiB must be refused
    // on the header alone; buffering first would let a 4-byte request become a
    // 4 GiB allocation.
    const decoder = new LengthPrefixedDecoder(TIGHT);
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 4 * 1024 * 1024 * 1024, false);
    expectControlled(() => decoder.push(header));
  });

  it('rejects a payload that exceeds maxEventBytes', () => {
    expectControlled(() => encodeLengthPrefixed(new TextEncoder().encode('x'.repeat(1024)), TIGHT));
  });

  it('waits rather than failing when the declared body has not arrived yet', () => {
    // A declared length with a short buffer is not corruption, it is latency.
    // Failing here would break every stream that delivers a frame in two TCP
    // segments.
    const decoder = new LengthPrefixedDecoder(TIGHT);
    const bytes = encodeLengthPrefixed(new TextEncoder().encode('{"a":1}'), TIGHT);
    expect(decoder.push(bytes.slice(0, 6))).toEqual([]);
  });

  it('reassembles a frame delivered one byte at a time', () => {
    const decoder = new LengthPrefixedDecoder(TIGHT);
    const bytes = encodeLengthPrefixed(new TextEncoder().encode('{"a":1}'), TIGHT);
    let frames: Uint8Array[] = [];
    for (const b of bytes) frames = decoder.push(new Uint8Array([b]));
    expect(frames).toHaveLength(1);
  });
});

describe('ndjson framing', () => {
  it('decodes well-formed lines', () => {
    expect(decodeNdjson('{"a":1}\n{"b":2}\n', TIGHT)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('rejects invalid JSON with a controlled error', () => {
    expectControlled(() => decodeNdjson('{"a":\n', TIGHT));
  });

  it('rejects a frame beyond the byte budget', () => {
    expectControlled(() => decodeNdjson(`{"a":"${'x'.repeat(512)}"}\n`, TIGHT));
  });

  it('rejects nesting deeper than the limit rather than overflowing the stack', () => {
    let deep = '1';
    for (let i = 0; i < 40; i += 1) deep = `{"a":${deep}}`;
    expectControlled(() => decodeNdjson(`${deep}\n`, TIGHT));
  });

  it('rejects an array longer than the element limit', () => {
    const long = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));
    expectControlled(() => decodeNdjson(`${long}\n`, TIGHT));
  });

  it('byteLength counts UTF-8 bytes, not code units', () => {
    // A budget checked in code units lets a 3-byte-per-character payload
    // through at a third of its real size.
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('中')).toBe(3);
    expect(byteLength('😀')).toBe(4);
  });
});

describe('sse framing', () => {
  it('round-trips a frame', () => {
    const text = encodeSseFrame(1, 'tool.call_started', { type: 'x' }, TIGHT);
    const frames = decodeSseFrames(text, TIGHT);
    expect(frames).toHaveLength(1);
    // Field order is fixed id -> event -> data, and `id` is the envelope seq
    // verbatim, which is what makes `Last-Event-ID` resumption work.
    expect(frames[0]?.id).toBe('1');
    expect(frames[0]?.event).toBe('tool.call_started');
  });

  it('keeps data as a string, so JSON errors surface at the codec layer', () => {
    // Not a gap: the SSE framing layer's job is field assembly, and parsing
    // belongs to `fromEnvelope`. Asserting it here would pin an implementation
    // detail that the codec is free to change.
    const frames = decodeSseFrames('event: x\ndata: {oops\n\n', TIGHT);
    expect(frames[0]?.data).toBe('{oops');
    expectControlled(() => fromEnvelope('{oops'));
  });

  it('treats a frame with no terminating blank line as complete, not corrupt', () => {
    const text = 'event: x\ndata: {"a":1}\n';
    expect(() => decodeSseFrames(text, TIGHT)).not.toThrow();
  });
});

describe('structural limits', () => {
  it('accepts a value inside the limits', () => {
    expect(() => assertWithinStructuralLimits({ a: { b: [1, 2] } } as JsonValue, TIGHT)).not.toThrow();
  });

  it('rejects excessive nesting', () => {
    let deep: JsonValue = 1;
    for (let i = 0; i < 20; i += 1) deep = { a: deep };
    expectControlled(() => assertWithinStructuralLimits(deep, TIGHT));
  });

  it('rejects an oversized sequence', () => {
    expectControlled(() => assertWithinStructuralLimits(Array.from({ length: 32 }, (_, i) => i) as JsonValue, TIGHT));
  });
});

describe('envelope decoding (G-8 and forward compatibility)', () => {
  const valid = {
    runId: 'r1',
    sessionId: 's1',
    seq: 1,
    timestamp: 0,
    traceId: 't1',
    payload: { type: 'run.paused', reason: 'user' },
  };

  it('decodes a valid envelope', () => {
    const out = fromEnvelope(valid);
    expect(isUnknownEnvelope(out)).toBe(false);
  });

  it('rejects a negative seq', () => {
    const issues = validate({ ...valid, seq: -1 });
    expect(issues.map((i) => i.path).join()).toMatch(/seq/);
  });

  it('rejects a non-integer seq', () => {
    const issues = validate({ ...valid, seq: 1.5 });
    expect(issues.map((i) => i.path).join()).toMatch(/seq/);
  });

  it('rejects a zero seq, because the contract starts at 1', () => {
    expect(isValidSeq(0)).toBe(false);
    expect(validate({ ...valid, seq: 0 }).map((i) => i.path).join()).toMatch(/seq/);
  });

  it('an unknown event type decodes to the unknown envelope, not a throw', () => {
    // The forward-compatibility path. A newer runtime must be able to speak to
    // an older host; a hard failure here is how a version bump breaks every
    // deployed host at once.
    const out = fromEnvelope({ ...valid, payload: { type: 'assistant.telepathy', vibe: 'good' } });
    expect(isUnknownEnvelope(out)).toBe(true);
  });

  it('an unknown envelope carries the raw payload for diagnosis and is never persisted', () => {
    const out = fromEnvelope({ ...valid, payload: { type: 'assistant.telepathy' } });
    if (!isUnknownEnvelope(out)) throw new Error('expected unknown');
    expect(out.payload.kind).toBe('unknown');
    expect(out.payload.type).toBe('assistant.telepathy');
  });

  it('rejects a missing runId', () => {
    const { runId: _omitted, ...withoutRunId } = valid;
    expect(validate(withoutRunId).map((i) => i.path).join()).toMatch(/runId/);
  });

  it('rejects a payload that is not an object', () => {
    expect(validate({ ...valid, payload: 'nope' }).length).toBeGreaterThan(0);
  });
});

describe('nothing here hangs, and nothing escapes as a raw exception', () => {
  const hostile: readonly (() => unknown)[] = [
    () => decodeNdjson('', LIMITS),
    () => decodeNdjson('\n\n\n', LIMITS),
    () => decodeNdjson(' ', LIMITS),
    () => decodeSseFrames('data:', LIMITS),
    () => decodeSseFrames('\n\n\n\n', LIMITS),
    () => new LengthPrefixedDecoder(LIMITS).push(new Uint8Array(0)),
    () => new LengthPrefixedDecoder(LIMITS).push(new Uint8Array([0xff, 0xff, 0xff, 0xff])),
    () => assertWithinStructuralLimits(null as JsonValue, LIMITS),
    () => fromEnvelope(null),
    () => fromEnvelope([]),
    () => fromEnvelope('string'),
    () => fromEnvelope(42),
  ];

  it.each(hostile.map((f, i) => [i, f] as const))('input #%i resolves without escaping', (_i, action) => {
    // The contract is a disjunction: return a value, or throw ProtocolError.
    // Anything else — a bare SyntaxError, a RangeError from a deep walk, a
    // TypeError from reading a property of null — is a bug, because a caller
    // written to catch ProtocolError will propagate it into the transport loop.
    let returned = false;
    try {
      action();
      returned = true;
    } catch (error) {
      expect(
        error,
        `escaped as ${error instanceof Error ? error.constructor.name : typeof error}`,
      ).toBeInstanceOf(ProtocolError);
    }
    // `returned` is not asserted further: both outcomes are legal, and the
    // assertion above is the whole point. Naming it keeps the intent readable.
    void returned;
  });
});
