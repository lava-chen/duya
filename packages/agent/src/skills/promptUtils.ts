/**
 * String utilities adapted from claude-code-haha
 * Width-aware truncation for proper CJK/emoji handling
 */

/**
 * Get the display width of a string (accounts for CJK characters being 2 columns)
 */
export function stringWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    // CJK characters: 0x4E00-0x9FFF, 0x3000-0x303F, 0xFF00-0xFFEF
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      width += 2;
    } else if (code > 0xffff) {
      // Emoji and other double-width characters
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Simple grapheme segmenter (for basic emoji handling)
 * Returns an array of { segment: string } objects
 */
function graphemeSegments(text: string): Array<{ segment: string }> {
  const result: Array<{ segment: string }> = [];
  let current = '';
  let surrogatePair = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const code = char?.codePointAt(0);

    if (code === undefined) continue;

    // Check for high surrogate (for emoji outside BMP)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      surrogatePair = true;
      current += char;
      continue;
    }

    // Low surrogate
    if (surrogatePair && code >= 0xdc00 && code <= 0xdfff) {
      current += char;
      result.push({ segment: current });
      current = '';
      surrogatePair = false;
      continue;
    }

    // Regular character
    if (surrogatePair) {
      // Orphan low surrogate, push what we have
      result.push({ segment: current });
      current = '';
      surrogatePair = false;
    }
    result.push({ segment: char });
  }

  // Handle any remaining
  if (current) {
    result.push({ segment: current });
  }

  return result;
}

/**
 * Truncates a string to fit within a maximum display width.
 * Appends '…' when truncation occurs.
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth <= 1) return '…';

  let width = 0;
  let result = '';
  for (const { segment } of graphemeSegments(text)) {
    const segWidth = stringWidth(segment);
    if (width + segWidth > maxWidth - 1) break;
    result += segment;
    width += segWidth;
  }
  return result + '…';
}

/**
 * Truncates a string to fit within a maximum display width, without appending an ellipsis.
 */
export function truncateToWidthNoEllipsis(
  text: string,
  maxWidth: number,
): string {
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth <= 0) return '';

  let width = 0;
  let result = '';
  for (const { segment } of graphemeSegments(text)) {
    const segWidth = stringWidth(segment);
    if (width + segWidth > maxWidth) break;
    result += segment;
    width += segWidth;
  }
  return result;
}

/**
 * Truncates from the start of a string, keeping the tail end.
 * Prepends '…' when truncation occurs.
 */
export function truncateStartToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth <= 1) return '…';

  const segments = graphemeSegments(text);
  let width = 0;
  let startIdx = segments.length;

  for (let i = segments.length - 1; i >= 0; i--) {
    const segWidth = stringWidth(segments[i]!.segment);
    if (width + segWidth > maxWidth - 1) break;
    width += segWidth;
    startIdx = i;
  }

  return '…' + segments.slice(startIdx).map(s => s.segment).join('');
}

/**
 * Truncates a string to fit within a maximum display width.
 * Appends '…' when truncation occurs.
 * @param str The string to truncate
 * @param maxWidth Maximum display width in terminal columns
 * @param singleLine If true, also truncates at the first newline
 */
export function truncate(
  str: string,
  maxWidth: number,
  singleLine = false,
): string {
  let result = str;

  if (singleLine) {
    const firstNewline = str.indexOf('\n');
    if (firstNewline !== -1) {
      result = str.substring(0, firstNewline);
      if (stringWidth(result) + 1 > maxWidth) {
        return truncateToWidth(result, maxWidth);
      }
      return `${result}…`;
    }
  }

  if (stringWidth(result) <= maxWidth) {
    return result;
  }
  return truncateToWidth(result, maxWidth);
}
