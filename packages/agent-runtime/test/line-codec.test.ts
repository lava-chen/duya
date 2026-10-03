/**
 * The line decoder, against the fragmentation that actually breaks decoders.
 *
 * ## What these tests are for
 *
 * A decoder that only ever sees whole lines passes with almost any
 * implementation. The failures live at the seams: a frame split across two
 * reads, a `\n` that lands on a chunk boundary, a 3-byte CJK character split
 * across two reads, and a producer that stops mid-frame. Each has a test here
 * that fails against the naive implementation -- `Buffer.concat` per chunk, or
 * `chunk.toString('utf8')` per chunk -- and passes against this one.
 *
 * The CJK case is the one worth dwelling on. A hand-rolled decoder turns a split
 * multi-byte sequence into U+FFFD, and every ASCII test still passes. It is the
 * same corruption class as the repo's encoding gate, arriving by a different
 * road, so it gets a test that splits a character deliberately.
 */

import { describe, expect, it } from 'vitest';
import { ProtocolError } from '@duya/agent-protocol';
import { NdjsonLineDecoder, encodeNdjsonLine, parseNdjsonLine } from '../src/transport/line-codec.js';
import type { JsonValue } from '@duya/agent-protocol';

const enc = new TextEncoder();

/**
 * Real three-byte UTF-8 characters, written as ESCAPES on purpose.
 *
 * The literals below are genuinely multi-byte -- a decoder that splits one
 * across two reads turns it into U+FFFD -- but they are spelled as escapes so
 * this source file stays pure ASCII. That is not cosmetic: this repository has
 * a text-encoding gate precisely because a non-ASCII literal has been mangled in
 * transit before, and a test whose subject is byte-level corruption is the
 * worst possible place to introduce one. The characters are asserted to be
 * three bytes wide below, so the test cannot silently stop being multi-byte.
 */
const CJK = '\u4e2d\u6587\u6d4b\u8bd5';
const EMOJI = '\u{1f600}\u{1f680}';

/** Feed bytes one at a time, the worst fragmentation a pipe can produce. */
function pushByByte(decoder: NdjsonLineDecoder, text: string): string[] {
  const bytes = enc.encode(text);
  const out: string[] = [];
  for (const byte of bytes) out.push(...decoder.push(Uint8Array.of(byte)));
  return out;
}

describe('the NDJSON line decoder: chunk boundaries', () => {
  it('completes a line no matter where the newline falls', () => {
    const line = JSON.stringify({ type: 'chat:text', content: 'hello' });
    for (let cut = 1; cut < line.length; cut++) {
      const decoder = new NdjsonLineDecoder();
      const bytes = enc.encode(`${line}\n`);
      const first = decoder.push(bytes.subarray(0, cut));
      const second = decoder.push(bytes.subarray(cut));
      // Every possible split of the SAME bytes must yield exactly one line.
      expect([...first, ...second]).toEqual([line]);
    }
  });

  it('yields several lines from one chunk, in order', () => {
    const decoder = new NdjsonLineDecoder();
    const lines = decoder.push(enc.encode('{"a":1}\n{"b":2}\n{"c":3}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('yields nothing for a chunk that completes no line', () => {
    const decoder = new NdjsonLineDecoder();
    expect(decoder.push(enc.encode('{"partial":'))).toEqual([]);
    expect(decoder.pendingBytes).toBeGreaterThan(0);
    expect(decoder.push(enc.encode('true}\n'))).toEqual(['{"partial":true}']);
  });

  it('survives a newline that lands exactly on a chunk boundary', () => {
    const decoder = new NdjsonLineDecoder();
    expect(decoder.push(enc.encode('{"a":1}'))).toEqual([]);
    expect(decoder.push(enc.encode('\n'))).toEqual(['{"a":1}']);
    // And the next line starts clean rather than inheriting the newline.
    expect(decoder.push(enc.encode('{"b":2}\n'))).toEqual(['{"b":2}']);
  });
});

describe('a multi-byte character split across two reads is not corrupted', () => {
  it('uses characters that really are multi-byte', () => {
    // Guards the guard: if these were ever ASCII, every test below would pass
    // against a decoder that cannot handle a split character at all.
    expect(enc.encode(CJK).length).toBe(12);
    expect(enc.encode(CJK).length).toBeGreaterThan(CJK.length);
    expect(enc.encode(EMOJI).length).toBe(8);
  });

  it('reassembles a CJK frame delivered one byte at a time', () => {
    const line = JSON.stringify({ type: 'chat:text', content: CJK });
    const lines = pushByByte(new NdjsonLineDecoder(), `${line}\n`);
    expect(lines).toEqual([line]);
    const parsed = parseNdjsonLine(lines[0]!) as { content: string };
    expect(parsed.content).toBe(CJK);
    expect(lines[0]).not.toContain('\uFFFD');
  });

  it('reassembles a four-byte character split one byte at a time', () => {
    // Emoji are four bytes with a surrogate pair in the JS string, so a
    // decoder that measures bytes in UTF-16 code units gets this wrong too.
    const line = JSON.stringify({ type: 'chat:text', content: EMOJI });
    const lines = pushByByte(new NdjsonLineDecoder(), `${line}\n`);
    expect(lines).toEqual([line]);
    expect(lines[0]).not.toContain('\uFFFD');
  });

  it('reassembles when the split lands in the MIDDLE of the character', () => {
    const bytes = enc.encode(JSON.stringify({ c: CJK }));
    // One byte into the first three-byte character.
    const cut = bytes.indexOf(0xe4) + 1;
    expect(cut).toBeGreaterThan(0);
    // Prove the cut really is mid-character: the byte at `cut` is a
    // continuation byte (10xxxxxx), not a lead byte.
    expect((bytes[cut]! & 0xc0) >>> 6).toBe(2);

    const decoder = new NdjsonLineDecoder();
    // The terminator matters: without it no line ever completes and the test
    // would be asserting about a buffer rather than about a delivered frame.
    const framed = enc.encode(`${JSON.stringify({ c: CJK })}\n`);
    const out = [
      ...decoder.push(framed.subarray(0, cut)),
      ...decoder.push(framed.subarray(cut)),
    ];
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain('\uFFFD');
    expect((parseNdjsonLine(out[0]!) as { c: string }).c).toBe(CJK);
    expect(() => decoder.end()).not.toThrow();
  });
});

describe('it is a line decoder, not a multi-line reassembler', () => {
  it('refuses pretty-printed JSON instead of joining the lines', () => {
    // The failure this file exists to prevent. A reassembler would accept this
    // and produce one object; the protocol says one `JSON.stringify` per line,
    // so the first line is simply not JSON and must be refused.
    const decoder = new NdjsonLineDecoder();
    const lines = decoder.push(enc.encode('{\n  "type": "chat:text"\n}\n'));
    expect(lines).toEqual(['{', '  "type": "chat:text"', '}']);
    expect(() => parseNdjsonLine(lines[0]!)).toThrow(ProtocolError);
    expect(() => parseNdjsonLine(lines[1]!)).toThrow(ProtocolError);
  });

  it('keeps no more than one incomplete line', () => {
    // A reassembler holds all three lines until the JSON parses. This holds at
    // most the current line -- and in fact holds NOTHING once a line is
    // terminated, which is why the previous test can see all three separately.
    const decoder = new NdjsonLineDecoder();
    expect(decoder.push(enc.encode('{\n'))).toEqual(['{']);
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.push(enc.encode('  "a": 1\n'))).toEqual(['  "a": 1']);
    expect(decoder.pendingBytes).toBe(0);
    // And a genuinely incomplete tail IS held, because it has to be.
    expect(decoder.push(enc.encode('{"unterm'))).toEqual([]);
    expect(decoder.pendingBytes).toBe(8);
  });
});

describe('the bound and the disconnect', () => {
  it('refuses a line over the byte bound instead of buffering it', () => {
    const decoder = new NdjsonLineDecoder({
      maxEventBytes: 64,
      maxSequenceLength: 1000,
      maxNestingDepth: 8,
    });
    expect(() => decoder.push(enc.encode('x'.repeat(200)))).toThrow(ProtocolError);
  });

  it('refuses a producer that never terminates a line', () => {
    // The ordering claim: the bound is checked BEFORE the append, so a
    // newline-free producer is cut off at the bound rather than growing first.
    const decoder = new NdjsonLineDecoder({
      maxEventBytes: 32,
      maxSequenceLength: 1000,
      maxNestingDepth: 8,
    });
    expect(() => decoder.push(enc.encode('y'.repeat(64)))).toThrow(/newline/);
  });

  it('reports truncation when the stream ends mid-frame', () => {
    const decoder = new NdjsonLineDecoder();
    decoder.push(enc.encode('{"type":"chat:text"'));
    // The whole point: a truncated tail must NOT be read as a frame, and the
    // run must not be reported as cleanly finished.
    expect(() => decoder.end()).toThrow(ProtocolError);
  });

  it('reports a stream that ends mid-character', () => {
    const decoder = new NdjsonLineDecoder();
    const bytes = enc.encode(JSON.stringify({ c: CJK }));
    // One byte into the first three-byte character, so the decoder is left
    // holding an incomplete sequence when the pipe closes.
    const cut = bytes.indexOf(0xe4) + 1;
    expect((bytes[cut]! & 0xc0) >>> 6).toBe(2);
    decoder.push(bytes.subarray(0, cut));
    // The decoder still holds an incomplete sequence at close.
    expect(() => decoder.end()).toThrow(ProtocolError);
  });

  it('ends cleanly on a whole number of lines', () => {
    const decoder = new NdjsonLineDecoder();
    decoder.push(enc.encode('{"a":1}\n{"b":2}\n'));
    expect(() => decoder.end()).not.toThrow();
  });
});

describe('encoding a line', () => {
  it('produces exactly one line, and never a bare newline', () => {
    const encoded = encodeNdjsonLine({ content: 'line one\nline two' } as JsonValue);
    expect(encoded.endsWith('\n')).toBe(true);
    // Exactly one newline: the terminator. The payload's newline is escaped by
    // `JSON.stringify`, which is why the frame can never be split.
    expect(encoded.split('\n')).toHaveLength(2);
    expect(parseNdjsonLine(encoded.trim())).toEqual({ content: 'line one\nline two' });
  });

  it('round-trips through the decoder byte-for-byte', () => {
    const values: JsonValue[] = [
      { type: 'chat:text', content: 'plain' },
      { type: 'chat:text', content: 'CJK content' },
      { type: 'chat:text', content: 'with\nnewline' },
      { type: 'chat:tool_use', input: { nested: { deep: [1, 2, 3] } } },
    ];
    const decoder = new NdjsonLineDecoder();
    const lines: string[] = [];
    for (const value of values) lines.push(...decoder.push(enc.encode(encodeNdjsonLine(value))));
    expect(lines.map((l) => parseNdjsonLine(l))).toEqual(values);
    expect(() => decoder.end()).not.toThrow();
  });
});
