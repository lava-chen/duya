/**
 * Markdown → Signal text + `textStyle` ranges.
 *
 * Signal has no markup in the message body: styling is a side channel of
 * `start:length:STYLE` ranges where offsets are **UTF-16 code units** (the same
 * unit JavaScript string indices use, so `text.length` and `String#slice` are
 * directly usable). Sending `**bold**` verbatim shows the asterisks, which is
 * why every outbound text is converted first.
 *
 * Supported styles: BOLD, ITALIC, STRIKETHROUGH, MONOSPACE.
 */

export type SignalStyle = 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE';

export interface SignalFormatting {
  text: string;
  /** `start:length:STYLE`, sorted by start offset. */
  textStyle: string[];
}

interface Marker {
  token: string;
  style: SignalStyle;
}

/** Longest tokens first so `**` is not read as two `*`. */
const MARKERS: readonly Marker[] = [
  { token: '**', style: 'BOLD' },
  { token: '__', style: 'BOLD' },
  { token: '~~', style: 'STRIKETHROUGH' },
  { token: '```', style: 'MONOSPACE' },
  { token: '`', style: 'MONOSPACE' },
  { token: '*', style: 'ITALIC' },
  { token: '_', style: 'ITALIC' },
];

/** Line-level normalisation that needs no offsets. */
function normalizeLines(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    // ATX headings → bold line keeps the emphasis that markdown implied.
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    // Task list items.
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '• ')
    // Unordered bullets.
    .replace(/^\s*[-*+]\s+/gm, '• ');
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

export function markdownToSignal(input: string): SignalFormatting {
  const source = normalizeLines(input ?? '');
  const textStyle: string[] = [];
  let output = '';
  let index = 0;

  while (index < source.length) {
    const marker = MARKERS.find((m) => source.startsWith(m.token, index));
    if (!marker) {
      output += source[index];
      index += 1;
      continue;
    }

    const contentStart = index + marker.token.length;
    const close = source.indexOf(marker.token, contentStart);
    // Unpaired marker (a literal asterisk, `snake_case`) stays as-is.
    if (close <= contentStart) {
      output += marker.token;
      index = contentStart;
      continue;
    }

    // `_` is only emphasis at a word boundary; `get_user_name` must not turn
    // into italics around "user".
    if (marker.token.startsWith('_')) {
      const before = source[index - 1];
      const after = source[close + marker.token.length];
      if (isWordChar(before) || isWordChar(after)) {
        output += marker.token;
        index = contentStart;
        continue;
      }
    }

    const inner = source.slice(contentStart, close);
    if (!inner.trim()) {
      output += marker.token;
      index = contentStart;
      continue;
    }

    const start = output.length;
    output += inner;
    textStyle.push(`${start}:${inner.length}:${marker.style}`);
    index = close + marker.token.length;
  }

  return { text: output, textStyle };
}

/**
 * Signal allows 8000 characters per message. Splitting happens on the **raw**
 * markdown and each chunk is converted independently — converting first and
 * splitting the rendered text afterwards would silently drop every style range.
 */
export function splitSignalMessage(input: string, maxLength = 8000): SignalFormatting[] {
  const whole = markdownToSignal(input);
  if (whole.text.length <= maxLength) return [whole];

  const chunks: SignalFormatting[] = [];
  let buffer: string[] = [];
  let bufferLength = 0;

  for (const paragraph of (input ?? '').split(/\n{2,}/)) {
    const renderedLength = markdownToSignal(paragraph).text.length;

    if (buffer.length > 0 && bufferLength + 2 + renderedLength > maxLength) {
      chunks.push(markdownToSignal(buffer.join('\n\n')));
      buffer = [];
      bufferLength = 0;
    }

    buffer.push(paragraph);
    bufferLength += renderedLength + (buffer.length > 1 ? 2 : 0);
  }

  if (buffer.length > 0) chunks.push(markdownToSignal(buffer.join('\n\n')));

  // A single paragraph can still exceed the limit; hard-slice it as a last
  // resort (styling is recomputed per slice by re-formatting the plain text).
  const output: SignalFormatting[] = [];
  for (const chunk of chunks) {
    if (chunk.text.length <= maxLength) {
      output.push(chunk);
      continue;
    }
    for (let offset = 0; offset < chunk.text.length; offset += maxLength) {
      const slice = chunk.text.slice(offset, offset + maxLength);
      output.push({ text: slice, textStyle: [] });
    }
  }

  return output;
}
