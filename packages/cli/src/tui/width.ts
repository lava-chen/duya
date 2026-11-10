/**
 * Visible-width and line-breaking primitives for the TUI.
 *
 * ## Why this exists instead of `String.length`
 *
 * A terminal cell is not a JS character. `'\u4f60'.length === 1` but the
 * character occupies two cells, and an emoji outside the BMP occupies two
 * cells across a surrogate pair whose `.length` is also 2. Padding computed
 * from `.length` is wrong for every CJK input, and the editor's cursor lands
 * to the left of the glyph it belongs to.
 *
 * ## Why the width function is blessed's
 *
 * `visibleWidth` delegates to `blessed/lib/unicode.js`, the same table blessed
 * uses to lay out every cell it draws. See `terminal/cell-width.ts` for why an
 * external width table is deliberately not used: two tables disagreeing at an
 * ambiguous-width boundary is exactly how a cursor drifts off its glyph.
 *
 * ## What this module is NOT
 *
 * It does not parse blessed tags. Every string it is handed is plain text: the
 * editor's buffer and the transcript's already-tagged lines. Tag parsing is
 * blessed's job, and mixing the two is how width bugs are invented.
 */

import { strWidth as cellStrWidth, charWidth as cellCharWidth } from './terminal/cell-width.js';

/** Visible cell width of a plain-text string. */
export function visibleWidth(text: string): number {
  if (text.length === 0) return 0;
  return cellStrWidth(text);
}

/** Visible cell width of one code point. */
export function codePointWidth(cp: string): number {
  if (cp.length === 0) return 0;
  return cellCharWidth(cp, 0);
}

/**
 * A line-wrapping result: the display lines, and where the cursor sits in them.
 *
 * `rows` is one-based because it addresses a terminal row, which is one-based;
 * `col` is zero-based because it addresses a cell offset within that row.
 */
export interface WrappedText {
  readonly rows: readonly string[];
  readonly cursorRow: number;
  readonly cursorCol: number;
}

/** Width to fall back to when a box reports a nonsensical width. */
const MIN_WRAP_WIDTH = 1;

/**
 * Wrap plain text to `width` visible cells, and report where `cursorIndex`
 * lands in the result.
 *
 * ## Break rules
 *
 * - A CJK sentence breaks between ideographs, which is normal and expected
 *   there, and never INSIDE one: the loop iterates code points, so a surrogate
 *   pair is never divided.
 * - A Latin word breaks at a space, and the space itself is dropped at the
 *   break so the next line does not start indented.
 * - A single token wider than `width` (a long URL, a long CJK run with no
 *   spaces) breaks mid-token rather than overflowing or looping forever.
 *
 * An empty input yields one empty row rather than zero rows, because an editor
 * with no text still has a row to put a cursor on.
 */
export function wrapWithCursor(text: string, width: number, cursorIndex: number): WrappedText {
  const { rows, cursorRow, cursorCol } = wrapWithSource(text, width, cursorIndex);
  return { rows, cursorRow, cursorCol };
}

/** Code-point boundaries of each painted row in the original, unmodified draft. */
export interface SourceWrappedText extends WrappedText {
  readonly sourceOffsets: readonly (readonly number[])[];
}

/** Keep source positions through word wrapping, including discarded break spaces. */
export function wrapWithSource(text: string, width: number, cursorIndex: number): SourceWrappedText {
  const limit = Math.max(MIN_WRAP_WIDTH, Math.floor(width));
  const rows: string[] = [];
  const sourceOffsets: number[][] = [];
  let paragraphStart = 0;
  const emit = (row: readonly { text: string; offset: number }[], emptyOffset: number): void => {
    rows.push(row.map((cell) => cell.text).join(''));
    sourceOffsets.push(row.length === 0 ? [emptyOffset]
      : [...row.map((cell) => cell.offset), row[row.length - 1]!.offset + 1]);
  };

  for (const paragraph of text.split('\n')) {
    const codePoints = Array.from(paragraph);
    let row: Array<{ text: string; offset: number }> = [];
    let rowWidth = 0;
    let breakAt = -1;
    for (let i = 0; i < codePoints.length; i += 1) {
      const cp = codePoints[i]!;
      const cpWidth = codePointWidth(cp);
      if (rowWidth + cpWidth > limit && row.length > 0) {
        const head = breakAt > 0 ? row.slice(0, breakAt) : row;
        const tail = breakAt > 0 ? row.slice(breakAt).filter((cell) => cell.text !== ' ') : [];
        emit(head, paragraphStart + i);
        row = tail;
        rowWidth = visibleWidth(row.map((cell) => cell.text).join(''));
        breakAt = -1;
      }
      row.push({ text: cp, offset: paragraphStart + i });
      rowWidth += cpWidth;
      if (cp === ' ' && row.length > 1) breakAt = row.length - 1;
    }
    emit(row, paragraphStart + codePoints.length);
    paragraphStart += codePoints.length + 1;
  }

  const requested = Number.isFinite(cursorIndex) ? Math.max(0, Math.min(Array.from(text).length, cursorIndex)) : 0;
  let distance = Number.POSITIVE_INFINITY;
  let cursorRow = 1;
  let cursorCol = 0;
  sourceOffsets.forEach((offsets, rowIndex) => {
    const cells = Array.from(rows[rowIndex]!);
    let column = 0;
    offsets.forEach((offset, index) => {
      const nextDistance = Math.abs(offset - requested);
      if (nextDistance < distance) {
        distance = nextDistance;
        cursorRow = rowIndex + 1;
        cursorCol = column;
      }
      if (index < cells.length) column += codePointWidth(cells[index]!);
    });
  });
  return { rows, cursorRow, cursorCol, sourceOffsets };
}

/**
 * Cap `text` to `maxLines`, appending a count of what was dropped.
 *
 * Used for tool results, which are routinely megabytes of JSON: a TUI that
 * renders all of it costs more per line than the line is worth to a reader.
 */
export function capLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  const dropped = lines.length - maxLines;
  return `${lines.slice(0, maxLines).join('\n')}\n… (${dropped} more line${dropped === 1 ? '' : 's'})`;
}

/**
 * Truncate to `maxWidth` visible cells, marking the cut with `…`.
 *
 * Width-aware on purpose: slicing by `.length` would cut a double-width
 * character in half and leave the terminal one cell short.
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(text) <= maxWidth) return text;
  const budget = Math.max(0, maxWidth - 1);
  let width = 0;
  let out = '';
  for (const cp of text) {
    const w = codePointWidth(cp);
    if (width + w > budget) break;
    out += cp;
    width += w;
  }
  return `${out}…`;
}
