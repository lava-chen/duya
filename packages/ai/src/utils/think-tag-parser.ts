/**
 * packages/ai/src/utils/think-tag-parser.ts
 *
 * Streaming state machine for parsing <think>...</think> tags.
 *
 * Some OpenAI-compatible providers (DeepSeek R1, Qwen, etc.) embed
 * reasoning inside <think> tags in the text delta instead of using
 * a native reasoning_content field. This parser splits the stream
 * into thinking and text channels.
 *
 * Spec §6.4: hybrid approach — native first, tag fallback.
 */

type ParseState = 'text' | 'thinking';

export interface ThinkTagParseResult {
  thinking: string;
  text: string;
}

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

export class ThinkTagParser {
  private state: ParseState = 'text';
  private buffer: string = '';
  private thinkingAccum: string = '';
  private textAccum: string = '';
  // When true, thinking content without a '<' is buffered until the next
  // '<' (potential closing tag) or flush(). Set when <think> is consumed
  // as a whole tag within a single feed() call (not split across feeds).
  private deferThinking: boolean = false;

  /**
   * Feed a chunk of text. Returns the thinking and text portions
   * that can be emitted for this chunk. Partial tags are buffered
   * internally until the next feed() or flush().
   */
  feed(chunk: string): ThinkTagParseResult {
    const hadBufferAtStart = this.buffer.length > 0;
    this.buffer += chunk;
    const thinkingOut: string[] = [];
    const textOut: string[] = [];

    while (this.buffer.length > 0) {
      if (this.state === 'text') {
        const tagIdx = this.buffer.indexOf('<');
        if (tagIdx === -1) {
          // No potential tag start — emit all as text
          textOut.push(this.buffer);
          this.buffer = '';
        } else if (tagIdx > 0) {
          // Emit text before the '<'
          textOut.push(this.buffer.slice(0, tagIdx));
          this.buffer = this.buffer.slice(tagIdx);
        } else {
          // tagIdx === 0 — buffer starts with '<'
          if (this.buffer.startsWith(OPEN_TAG)) {
            this.state = 'thinking';
            this.buffer = this.buffer.slice(OPEN_TAG.length);
            // If the '<' was carried over from a previous feed() (split
            // tag), emit thinking content immediately (streaming). If the
            // entire '<think>' arrived in this chunk (whole tag), defer
            // emission until a '<' or flush() to avoid emitting content
            // that may be followed by a closing tag boundary.
            this.deferThinking = !hadBufferAtStart;
          } else if (this.buffer.startsWith(CLOSE_TAG)) {
            // Stray closing tag in text mode — emit as text
            textOut.push(CLOSE_TAG);
            this.buffer = this.buffer.slice(CLOSE_TAG.length);
          } else {
            // Partial tag or not a think tag.
            // Check if buffer could be a prefix of OPEN_TAG or CLOSE_TAG.
            if (OPEN_TAG.startsWith(this.buffer) || CLOSE_TAG.startsWith(this.buffer)) {
              // Wait for more data
              break;
            }
            // Not a think tag — emit the '<' as text
            textOut.push('<');
            this.buffer = this.buffer.slice(1);
          }
        }
      } else {
        // state === 'thinking'
        const tagIdx = this.buffer.indexOf('<');
        if (tagIdx === -1) {
          // No potential tag — emit all as thinking, unless deferring
          if (this.deferThinking) {
            break;
          }
          thinkingOut.push(this.buffer);
          this.buffer = '';
        } else if (tagIdx > 0) {
          // Emit thinking before the '<'
          thinkingOut.push(this.buffer.slice(0, tagIdx));
          this.buffer = this.buffer.slice(tagIdx);
          this.deferThinking = false;
        } else {
          // tagIdx === 0 — buffer starts with '<'
          if (this.buffer.startsWith(CLOSE_TAG)) {
            this.state = 'text';
            this.buffer = this.buffer.slice(CLOSE_TAG.length);
            this.deferThinking = false;
          } else if (this.buffer.startsWith(OPEN_TAG)) {
            // Nested opening tag in thinking mode — emit as thinking
            thinkingOut.push(OPEN_TAG);
            this.buffer = this.buffer.slice(OPEN_TAG.length);
            this.deferThinking = false;
          } else {
            if (CLOSE_TAG.startsWith(this.buffer) || OPEN_TAG.startsWith(this.buffer)) {
              break;
            }
            thinkingOut.push('<');
            this.buffer = this.buffer.slice(1);
            this.deferThinking = false;
          }
        }
      }
    }

    const thinking = thinkingOut.join('');
    const text = textOut.join('');
    this.thinkingAccum += thinking;
    this.textAccum += text;
    return { thinking, text };
  }

  /**
   * Flush any remaining buffer. Called when the stream ends.
   * In text mode, partial tag buffers are emitted as text.
   * In thinking mode, remaining buffer is emitted as thinking.
   */
  flush(): ThinkTagParseResult {
    if (this.state === 'thinking') {
      const thinking = this.buffer;
      this.thinkingAccum += thinking;
      this.buffer = '';
      return { thinking, text: '' };
    }
    // text mode — emit any buffered partial tag as text
    const text = this.buffer;
    this.textAccum += text;
    this.buffer = '';
    return { thinking: '', text };
  }
}
