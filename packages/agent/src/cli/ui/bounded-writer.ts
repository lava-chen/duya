/**
 * A bounded output writer for the TUI, and the escape-safety rule it enforces.
 *
 * ## What it is for
 *
 * A render burst can produce a large frame, and an unbounded `stdout.write` of
 * that frame is one giant blocking syscall to the tty. Coalescing into ~256KB
 * chunks keeps the writes to a size the pty layer handles without stalling the
 * writer.
 *
 * ## Why the chunk boundary is not `size`
 *
 * A chunk boundary that lands inside an escape sequence splits one control
 * sequence across two writes. Depending on the terminal that can render as a
 * literal `[2J` in the user's scrollback, a stray colour change, or a stuck
 * mode. So a cut point is only valid at a position that is not inside a
 * sequence, and `findSafeCut` is where that decision lives.
 *
 * ## The rule, precisely
 *
 * Find the last ESC (0x1b) in the buffer and test whether the sequence starting
 * there is complete:
 *
 * - `ESC [` begins a CSI. Its final byte is the first byte in 0x40..0x7E after
 *   the introducer, so parameters and intermediates leave it unterminated.
 * - `ESC ]` begins an OSC, terminated by BEL or by ST (`ESC \`).
 * - anything else after a single ESC is self-terminating.
 *
 * If the last sequence is incomplete, cut BEFORE that ESC. The held-back tail
 * goes to the next chunk, where it is no longer at risk.
 */

import { Writable } from 'stream';

const ESC = 0x1b;
const BEL = 0x07;

/** Default cap on a single flush. */
export const DEFAULT_WRITE_BUFFER_BYTES = 256 * 1024;

/**
 * The largest prefix of `buffer` that can be written without splitting an
 * escape sequence or a UTF-8 character, capped at `max` bytes.
 *
 * The scan runs over `[0, min(max, length))` — the whole candidate prefix,
 * NOT just the last `max` bytes of the buffer. Searching only the tail would
 * miss a sequence that BEGINS before the window and ends inside it, and
 * cutting at `max` would then split it. That is not a corner case: `\x1b[2;1m`
 * is six bytes, so a `max` of 5 has to look back past its own start to find
 * it.
 *
 * Two things are protected, because they break the same way — a byte that
 * starts one thing landing in the middle of another:
 *
 * 1. Escape sequences. The last ESC in the prefix is tested for completeness
 *    and, if it is still open, the cut moves back to before it.
 * 2. UTF-8 boundaries. A cap of 7 bytes lands inside a 3-byte CJK code point
 *    often enough to matter for a TUI that claims East-Asian support, so the
 *    cut backs off to the nearest lead byte.
 */
export function findSafeCut(buffer: Buffer, max: number): number {
  const limit = Math.min(Math.max(0, max), buffer.length);

  for (let i = limit - 1; i >= 0; i -= 1) {
    if (buffer[i] !== ESC) continue;
    return sequenceComplete(buffer, i, limit) ? limit : i;
  }

  return utf8BoundaryBackedOff(buffer, limit);
}

/**
 * Move a byte offset back to the nearest UTF-8 lead byte.
 *
 * A continuation byte is 10xxxxxx. Any offset pointing at one is inside a
 * code point, so the cut moves back until it does not.
 */
function utf8BoundaryBackedOff(buffer: Buffer, cut: number): number {
  let at = cut;
  while (at > 0 && ((buffer[at] as number) & 0xc0) === 0x80) at -= 1;
  return at;
}

/**
 * Whether the escape sequence starting at `start` is fully contained in
 * `[start, limit)`.
 *
 * `limit` rather than the buffer length, because the question is whether the
 * cut splits it — bytes after the cut are irrelevant.
 */
function sequenceComplete(buffer: Buffer, start: number, limit: number): boolean {
  const introducer = buffer[start + 1];
  // An ESC with nothing after it inside the prefix is still open: the rest
  // has not arrived yet.
  if (introducer === undefined) return false;

  if (introducer === 0x5b /* [ */) {
    for (let i = start + 2; i < limit; i += 1) {
      const b = buffer[i] as number;
      // Final byte of a CSI.
      if (b >= 0x40 && b <= 0x7e) return true;
      // Parameter and intermediate bytes continue the sequence. Anything
      // else is not a sequence we recognise; treat it as terminated so a
      // malformed byte cannot pin the buffer forever.
      if (b < 0x20 || b > 0x3f) return true;
    }
    return false;
  }

  if (introducer === 0x5d /* ] */) {
    for (let i = start + 2; i < limit; i += 1) {
      if (buffer[i] === BEL) return true;
      // ST: ESC backslash.
      if (buffer[i] === ESC && buffer[i + 1] === 0x5c) return true;
    }
    return false;
  }

  // Any other ESC-introduced sequence is treated as complete. Blessed emits
  // ESC-prefixed pairs for cursor moves and these are the common case.
  return true;
}

export interface EscapeSafeWriterOptions {
  /** Where the bytes actually go. */
  readonly sink: NodeJS.WritableStream;
  /** Bytes buffered before a flush. */
  readonly highWaterMark?: number;
  /** True while bytes are held back for an incomplete sequence. */
  readonly onHeld?: (held: number) => void;
}

/**
 * A `Writable` that coalesces output and never cuts an escape sequence.
 *
 * Implements the stream surface blessed's `Program` reads: `write`, `end`,
 * `isTTY`, `columns`, `rows`, and the `resize` event.
 */
export class EscapeSafeWriter extends Writable {
  private readonly sink: NodeJS.WritableStream;
  private readonly cap: number;
  private readonly onHeld?: (held: number) => void;
  private pending: Buffer = Buffer.alloc(0);

  constructor(options: EscapeSafeWriterOptions) {
    // Blessed never pushes to this stream itself; it only writes to it. High
    // levels here keep Node from re-entering the write path for each frame.
    super({ decodeStrings: false, highWaterMark: Number.MAX_SAFE_INTEGER });
    this.sink = options.sink;
    this.cap = options.highWaterMark ?? DEFAULT_WRITE_BUFFER_BYTES;
    this.onHeld = options.onHeld;
  }

  /** Bytes currently held back. */
  get heldBytes(): number {
    return this.pending.length;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.pending = this.pending.length === 0 ? bytes : Buffer.concat([this.pending, bytes]);
    this.drain();
    callback();
  }

  private drain(): void {
    while (this.pending.length > 0) {
      const cut = findSafeCut(this.pending, this.cap);
      if (cut <= 0) {
        // The buffer holds an incomplete sequence and is not yet worth
        // flushing. Wait for the bytes that complete it.
        this.onHeld?.(this.pending.length);
        return;
      }
      const out = this.pending.subarray(0, cut);
      this.pending = this.pending.subarray(cut);
      this.sink.write(out);
    }
  }

  /** Push everything held, sequence-safety notwithstanding. For teardown. */
  flush(): void {
    if (this.pending.length === 0) return;
    const out = this.pending;
    this.pending = Buffer.alloc(0);
    this.sink.write(out);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.flush();
    callback();
  }
}
