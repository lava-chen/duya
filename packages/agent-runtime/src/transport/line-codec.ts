/**
 * The chunk-safe NDJSON line decoder shared by every transport that moves bytes.
 *
 * ## Why this is a separate file, and not `framing.decodeNdjson`
 *
 * `framing.ts` decodes a WHOLE string. That is the right shape for a document
 * you already hold and the wrong shape for a pipe, because a pipe hands you
 * arbitrary byte ranges with no relationship to line boundaries. `decodeNdjson`
 * is called on `text` and silently treats the tail as a complete frame, which
 * is correct for a file and catastrophic for a socket: a chunk that ends
 * mid-frame becomes a truncated "frame" that fails to parse, and the error
 * points at JSON rather than at the real fault, which is that the read side
 * forgot it is a stream.
 *
 * So this is an INCREMENTAL decoder, and the difference is the whole reason it
 * exists: `push` may be called with any fragmentation at all and returns only
 * the lines that are genuinely complete.
 *
 * ## A line is a line. This is NOT a multi-line reassembler.
 *
 * The older failure this replaces was a 64 KB buffer in `router.ts` that grew
 * until a frame parsed, existing only because a producer could emit a
 * multi-line JSON body. This decoder never grows across a newline. `#pending`
 * holds at most ONE incomplete line, and a complete line is removed from it
 * immediately. A producer that sends pretty-printed JSON over two lines gets
 * two parse failures, not one reassembled object -- and there is a test named
 * after exactly that, because "it works by accumulating" is the failure mode
 * this file has to be unable to have.
 *
 * ## The UTF-8 boundary is the part a hand-rolled decoder gets wrong
 *
 * A 3-byte CJK character can be split across two reads. The naive decoder --
 * `Buffer.concat(chunks).toString('utf8')` per chunk, or
 * `chunk.toString('utf8')` -- turns that split into U+FFFD and the frame is
 * silently corrupted while every test that used ASCII still passes. This is
 * exactly the corruption the repo's encoding gate was written for, arriving by
 * a different road.
 *
 * So the bytes are decoded by a `TextDecoder` in streaming mode, which holds an
 * incomplete trailing sequence internally and completes it on the next chunk.
 * `fatal: true` is deliberate: a byte sequence that is not valid UTF-8 is
 * protocol-invalid, and silently substituting U+FFFD would be a lie about the
 * payload's bytes.
 *
 * ## The bound is on BYTES, checked before the append
 *
 * `maxEventBytes` is a byte count, so the accumulator counts bytes and not
 * characters; a 16 MiB bound measured in UTF-16 code units is roughly half the
 * real bound for CJK. The check happens before the decoded text is appended, so
 * a producer that never sends a newline is refused at the bound instead of
 * growing the heap first. That is the same ordering `framing.ts` states for the
 * length-prefixed decoder ("validate the declared length BEFORE buffering"),
 * applied to the case where there is no declared length: the accumulated size
 * is the only length there is.
 */

import { DEFAULT_LIMITS, ProtocolError, byteLength, encodeNdjson } from '@duya/agent-protocol';
import type { JsonValue, ProtocolLimits } from '@duya/agent-protocol';

/** The default bound: the protocol's own `maxEventBytes`. */
export const LINE_CODEC_LIMITS: ProtocolLimits = DEFAULT_LIMITS;

/**
 * Incremental NDJSON reader.
 *
 * Feed it every byte the pipe produced, in whatever sizes the pipe produced
 * them, and read back the lines that are complete. Holds no run state, mints
 * nothing, and cannot execute anything: it is a byte-to-line function with a
 * buffer, which is what keeps it from becoming a second engine.
 */
export class NdjsonLineDecoder {
  readonly #limits: ProtocolLimits;
  // Inferred from the assignment rather than annotated: the DOM/Node global is
  // a VALUE, and naming it as a type is the mistake this comment prevents.
  readonly #utf8;
  /** Decoded text of the single incomplete line being accumulated. */
  #pending = '';
  /** UTF-8 byte length of `#pending`. The bound is a byte bound. */
  #pendingBytes = 0;

  constructor(limits: ProtocolLimits = LINE_CODEC_LIMITS) {
    this.#limits = limits;
    this.#utf8 = new TextDecoder('utf-8', { fatal: true });
  }

  /**
   * Feed one chunk of whatever the pipe handed over.
   *
   * @returns every line completed by this chunk, in arrival order. A chunk that
   * completes nothing returns an empty array, which is the normal case for a
   * large frame arriving a few bytes at a time.
   * @throws {ProtocolError} `invalid_event_frame` when the bytes are not valid
   * UTF-8, or when a single line would exceed `maxEventBytes`.
   */
  push(chunk: Uint8Array): string[] {
    if (chunk.byteLength === 0) return [];

    let decoded: string;
    try {
      // `stream: true` is what holds an incomplete trailing multi-byte
      // sequence instead of turning it into U+FFFD.
      decoded = this.#utf8.decode(chunk, { stream: true });
    } catch {
      throw new ProtocolError({
        code: 'invalid_event_frame',
        message: 'the stream carried bytes that are not valid UTF-8',
      });
    }

    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = decoded.indexOf('\n', start);
      if (nl === -1) break;
      // THE LINE IS THE BUFFER PLUS THIS CHUNK'S PART. Dropping `#pending`
      // here is the bug this comment exists to prevent, and it is a quiet one:
      // every frame that arrived split across two reads was emitted as the
      // TAIL of its own first half, which is still valid JSON often enough that
      // an ASCII-only suite never noticed. `pushByByte` in the test walks a
      // whole frame one byte at a time, so no split can hide.
      const line = this.#pending + decoded.slice(start, nl);
      this.#pending = '';
      this.#pendingBytes = 0;
      start = nl + 1;
      if (line.length === 0) continue;
      if (byteLength(line) > this.#limits.maxEventBytes) {
        throw new ProtocolError({
          code: 'invalid_event_frame',
          message: `frame is ${byteLength(line)} bytes, maxEventBytes is ${this.#limits.maxEventBytes}`,
        });
      }
      lines.push(line);
    }

    const tail = decoded.slice(start);
    if (tail.length > 0) {
      // BEFORE the append, so the bound is enforced against the total and a
      // newline-free producer cannot grow the buffer past it.
      if (this.#pendingBytes + byteLength(tail) > this.#limits.maxEventBytes) {
        this.#pending = '';
        this.#pendingBytes = 0;
        throw new ProtocolError({
          code: 'invalid_event_frame',
          message:
            `an unterminated line exceeded maxEventBytes ${this.#limits.maxEventBytes}; ` +
            'the producer is not terminating frames with a newline',
        });
      }
      this.#pending += tail;
      this.#pendingBytes += byteLength(tail);
    }
    return lines;
  }

  /**
   * The stream closed. Report truncation rather than losing the tail quietly.
   *
   * Two distinct faults are caught here and they are different bugs:
   *
   *  - bytes buffered with no trailing newline, meaning the producer stopped
   *    mid-frame (a killed worker, a closed socket);
   *  - an incomplete UTF-8 sequence, which the streaming decoder is still
   *    holding. Flushing it either throws (fatal) or would emit U+FFFD, and
   *    both mean the last frame did not arrive intact.
   *
   * @throws {ProtocolError} `invalid_event_frame` when the stream ended
   * mid-frame. A caller MUST NOT read a truncated tail as if it were a frame,
   * and MUST NOT report the run as successfully completed on this path.
   */
  end(): void {
    let flushed: string;
    try {
      // No `stream` flag: this is the flush, and it is where an incomplete
      // trailing sequence becomes an error rather than a replacement char.
      flushed = this.#utf8.decode();
    } catch {
      this.#pending = '';
      this.#pendingBytes = 0;
      throw new ProtocolError({
        code: 'invalid_event_frame',
        message: 'the stream ended in the middle of a UTF-8 sequence',
      });
    }
    const held = this.#pending.length + flushed.length;
    if (held > 0) {
      this.#pending = '';
      this.#pendingBytes = 0;
      throw new ProtocolError({
        code: 'invalid_event_frame',
        message: `the stream ended with ${held} byte(s) of an unterminated frame`,
      });
    }
  }

  /** Bytes currently held for an incomplete line. Diagnostics, not control flow. */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }
}

/**
 * Parse one line into a JSON value.
 *
 * Split from the decoder on purpose, and the split is the "framing is
 * independent of schemas" rule made mechanical: the decoder decides where a
 * frame ENDS, this decides whether it is VALID, and a test can therefore
 * exercise each without the other. A parse failure becomes a `ProtocolError`
 * rather than a bare `SyntaxError`, because the only error type this layer
 * documents is `ProtocolError` and a caller written to catch it would
 * otherwise propagate a `SyntaxError` into the transport loop.
 */
export function parseNdjsonLine(line: string): JsonValue {
  try {
    return JSON.parse(line) as JsonValue;
  } catch (error) {
    throw new ProtocolError({
      code: 'invalid_event_frame',
      message: `frame is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
    });
  }
}

/**
 * Encode one value as exactly one NDJSON line.
 *
 * Delegates to the protocol's own `encodeNdjson` rather than restating
 * `JSON.stringify(value) + '\n'`, because the protocol owns the framing
 * contract and a second implementation of it is a second thing to keep honest.
 * `JSON.stringify` cannot emit a bare newline, so the line cannot contain one.
 */
export function encodeNdjsonLine(value: JsonValue, limits: ProtocolLimits = LINE_CODEC_LIMITS): string {
  return encodeNdjson(value, limits);
}
