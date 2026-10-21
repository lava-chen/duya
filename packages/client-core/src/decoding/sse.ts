/**
 * Pure incremental parser for SSE framing. The caller supplies byte chunks and
 * decides how to read, cancel, resume, or reconnect its stream.
 *
 * Streaming TextDecoder mode preserves characters split across chunks, including
 * multi-byte UTF-8 sequences. Only complete frames are dispatched.
 */

/** One dispatched SSE frame. */
export interface SseFrame {
  /** The `id:` field, or `null` when the frame carried none. */
  readonly id: string | null;
  /** The `event:` field. `message` is the SSE default when the field is absent. */
  readonly event: string;
  /** `data:` lines joined with `\n`, per the SSE specification. */
  readonly data: string;
}

const DEFAULT_EVENT = 'message';

/**
 * Incremental SSE decoder. Feed it byte chunks; get back whole frames.
 *
 * A frame is only dispatched once its terminating blank line has arrived, so a
 * frame split across any number of chunks is held rather than half-parsed. A
 * trailing partial frame at end of stream is discarded: an event without its
 * terminator is an incomplete event, and presenting half
 * of it as fact is exactly the kind of guess this client must not make.
 */
export class SseFrameDecoder {
  readonly #text = new TextDecoder('utf-8');
  /** A `\r` that ended a chunk, kept until the next chunk decides if it was half a CRLF. */
  #carriedCarriageReturn = false;
  #buffer = '';

  /** Decode one chunk into the frames it completed. */
  push(chunk: Uint8Array): readonly SseFrame[] {
    const decoded = this.#text.decode(chunk, { stream: true });
    let text = decoded;
    if (this.#carriedCarriageReturn) {
      text = `\r${text}`;
      this.#carriedCarriageReturn = false;
    }
    if (text.endsWith('\r')) {
      text = text.slice(0, -1);
      this.#carriedCarriageReturn = true;
    }
    this.#buffer += normalizeLineEndings(text);
    return this.#drain();
  }

  /** Release the decoder. Any unterminated trailing frame is discarded. */
  end(): void {
    this.#buffer = '';
    this.#carriedCarriageReturn = false;
  }

  #drain(): readonly SseFrame[] {
    const frames: SseFrame[] = [];
    for (;;) {
      const boundary = this.#buffer.indexOf('\n\n');
      if (boundary === -1) break;
      const block = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      const frame = parseBlock(block);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }
}

/**
 * Collapse CRLF and lone CR to LF before frames are split.
 *
 * A payload byte of 0x0D cannot appear inside an SSE `data:` line — a JSON
 * string carries it escaped — so rewriting CR here cannot corrupt content.
 */
function normalizeLineEndings(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

function parseBlock(block: string): SseFrame | null {
  let id: string | null = null;
  let event: string | null = null;
  const data: string[] = [];

  for (const line of block.split('\n')) {
    // A blank line ends the block (already stripped) and a leading colon marks
    // a comment: the Host's `: keep-alive` heartbeat is exactly that.
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
  }

  // A block with no recognised field is not an event. Dispatching it would let a
  // stray comment or an unknown field turn into a rendered frame.
  if (event === null && id === null && data.length === 0) return null;
  return { id, event: event ?? DEFAULT_EVENT, data: data.join('\n') };
}
