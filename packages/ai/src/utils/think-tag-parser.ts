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

// MiniMax emits reasoning wrapped in <thinking>...</thinking>, while
// DeepSeek/Qwen use <think>...</think>. Support both so callers don't
// need to know which provider produced the stream.
const OPEN_TAGS = ['<think>', '<thinking>'];
const CLOSE_TAGS = ['</think>', '</thinking>'];

function findMatchingPrefix(buffer: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (buffer.startsWith(candidate)) {
      return candidate;
    }
  }
  return null;
}

function anyCandidateStartsWith(buffer: string, candidates: string[]): boolean {
  for (const candidate of candidates) {
    if (candidate.startsWith(buffer)) {
      return true;
    }
  }
  return false;
}

export class ThinkTagParser {
  private state: ParseState = 'text';
  private buffer: string = '';
  private thinkingAccum: string = '';
  private textAccum: string = '';
  // When true, thinking content without a '<' is buffered until the next
  // '<' (potential closing tag) or flush(). Set when an opening tag is
  // consumed as a whole tag within a single feed() call (not split across
  // feeds).
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
          const openTag = findMatchingPrefix(this.buffer, OPEN_TAGS);
          if (openTag) {
            this.state = 'thinking';
            this.buffer = this.buffer.slice(openTag.length);
            // If the '<' was carried over from a previous feed() (split
            // tag), emit thinking content immediately (streaming). If the
            // entire opening tag arrived in this chunk (whole tag), defer
            // emission until a '<' or flush() to avoid emitting content
            // that may be followed by a closing tag boundary.
            this.deferThinking = !hadBufferAtStart;
            continue;
          }
          const closeTag = findMatchingPrefix(this.buffer, CLOSE_TAGS);
          if (closeTag) {
            // Stray closing tag in text mode — emit as text
            textOut.push(closeTag);
            this.buffer = this.buffer.slice(closeTag.length);
            continue;
          }
          // Partial tag or not a think tag.
          // Check if buffer could be a prefix of any known tag.
          if (anyCandidateStartsWith(this.buffer, [...OPEN_TAGS, ...CLOSE_TAGS])) {
            // Wait for more data
            break;
          }
          // Not a think tag — emit the '<' as text
          textOut.push('<');
          this.buffer = this.buffer.slice(1);
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
          const closeTag = findMatchingPrefix(this.buffer, CLOSE_TAGS);
          if (closeTag) {
            this.state = 'text';
            this.buffer = this.buffer.slice(closeTag.length);
            this.deferThinking = false;
            continue;
          }
          const openTag = findMatchingPrefix(this.buffer, OPEN_TAGS);
          if (openTag) {
            // Nested opening tag in thinking mode — emit as thinking
            thinkingOut.push(openTag);
            this.buffer = this.buffer.slice(openTag.length);
            this.deferThinking = false;
            continue;
          }
          if (anyCandidateStartsWith(this.buffer, [...OPEN_TAGS, ...CLOSE_TAGS])) {
            break;
          }
          thinkingOut.push('<');
          this.buffer = this.buffer.slice(1);
          this.deferThinking = false;
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
