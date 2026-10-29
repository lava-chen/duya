import { codePointWidth, visibleWidth, wrapWithCursor } from './width.js';

/** Default maximum number of rendered input rows before the composer scrolls. */
export const DEFAULT_COMPOSER_MAX_ROWS = 8;

/** The top and bottom rules consume one terminal row each. */
export const COMPOSER_BORDER_ROWS = 2;

/** Keep two terminal rows available for status and activity indicators. */
export const COMPOSER_RESERVED_STATUS_ROWS = 2;

/**
 * A draft prefix drawn in the composer's prompt column.
 *
 * The prefix is part of the draft the user typed, so the layout takes the
 * text and the caret the editor holds and draws the prefix where a prompt
 * belongs: the text that follows it starts after the prompt column, and the
 * caret shifts left by the code points the prefix covers.
 */
export interface ComposerPrefix {
  /** The glyph the prompt column holds: `!` or `!!`. */
  readonly glyph: string;
  /** The prompt column's text: the glyph, padded to the column's width. */
  readonly prompt: string;
  /** Code points of the draft the prompt stands for. */
  readonly stripped: number;
}

export interface ComposerLayoutOptions {
  readonly columns: number;
  readonly terminalRows: number;
  readonly maxRows?: number;
  /** Use the Unicode prompt and border glyphs when supported by the caller. */
  readonly unicode?: boolean;
  /**
   * The shell prefix the draft opens with, when it has one.
   *
   * The prefix replaces the chevron in the prompt column, so a draft that
   * runs a command says so before it is sent — the way codex draws its shell
   * prompt.
   */
  readonly shellPrefix?: ComposerPrefix;
  /**
   * The next prompt predicted for the last turn.
   *
   * It is drawn in the composer's first body row while the editor is empty,
   * so it reads as a hint rather than as text the user typed.
   */
  readonly placeholder?: string;
}

export interface ComposerLayout {
  /** Fully clipped terminal rows, including borders when there is room. */
  readonly lines: readonly string[];
  /** 1-based row of the cursor within `lines`. */
  readonly cursorRow: number;
  /** 1-based terminal cell column of the cursor. */
  readonly cursorColumn: number;
  /** Number of visible editable rows, excluding the borders. */
  readonly bodyRows: number;
  /** 0-based index of the first visible wrapped text row. */
  readonly firstVisibleRow: number;
  /** True when the first body row carries the placeholder instead of text. */
  readonly hasPlaceholder: boolean;
}

/**
 * Lay out a bounded, cursor-aware composer without depending on a UI runtime.
 *
 * The body gets at most `maxRows` rows and roughly half the terminal height,
 * after reserving two rows for status/activity and two for the rules. The
 * cursor-driven window scrolls both down and back up as the caret moves.
 *
 * For terminals shorter than three rows, rules are omitted so at least one
 * editable row remains visible and the result never exceeds the terminal.
 * Cursor row/column are 1-based terminal coordinates; `firstVisibleRow` is a
 * 0-based offset into the complete wrapped body.
 */
export function buildComposerLayout(
  text: string,
  cursor: number,
  options: ComposerLayoutOptions,
): ComposerLayout {
  const columns = positiveDimension(options.columns);
  const terminalRows = positiveDimension(options.terminalRows);
  const maxRows = positiveDimension(options.maxRows ?? DEFAULT_COMPOSER_MAX_ROWS);
  const unicode = options.unicode ?? true;
  const unicodePrompt = '❯ ';
  const prefix = options.shellPrefix;
  // The prefix belongs to the prompt column, not to the text: the body is the
  // draft after it, and the caret moves left by the code points it covered.
  const body = prefix === undefined ? text : stripCodePoints(text, prefix.stripped);
  const caret = prefix === undefined ? cursor : cursor - prefix.stripped;
  const prompt = prefix?.prompt
    ?? (unicode && visibleWidth(unicodePrompt) <= columns ? unicodePrompt : '> ');
  const continuation = '  ';
  const contentWidth = Math.max(1, columns - visibleWidth(prompt));

  const wrapped = wrapTextWithCursor(body, contentWidth, caret);
  const hasBorders = terminalRows >= 3;
  const bodyBudget = hasBorders
    ? Math.max(
        1,
        Math.min(
          maxRows,
          Math.floor(
            (terminalRows - COMPOSER_BORDER_ROWS - COMPOSER_RESERVED_STATUS_ROWS) / 2,
          ),
        ),
      )
    : terminalRows;
  const bodyRows = Math.max(1, Math.min(bodyBudget, wrapped.rows.length));
  const maxFirstVisibleRow = Math.max(0, wrapped.rows.length - bodyRows);
  const firstVisibleRow = Math.max(
    0,
    Math.min(wrapped.cursorRow - bodyRows, maxFirstVisibleRow),
  );
  const visibleBody = wrapped.rows.slice(firstVisibleRow, firstVisibleRow + bodyRows);

  const bodyLines = visibleBody.map((line, index) => {
    const rowPrompt = index === 0 && firstVisibleRow === 0 ? prompt : continuation;
    return clipToColumns(`${rowPrompt}${line}`, columns);
  });

  // The placeholder takes the first body row only while the editor is empty:
  // a composer that holds text shows the text, never the hint.
  const placeholder = text.length === 0 ? (options.placeholder ?? '').trim() : '';
  const hasPlaceholder = placeholder.length > 0;
  const paintedBody = hasPlaceholder
    ? bodyLines.map((line, index) => (index === 0 ? clipToColumns(`${prompt}${placeholder}`, columns) : line))
    : bodyLines;

  const border = makeBorder(columns, unicode);
  const lines = hasBorders ? [border, ...paintedBody, border] : paintedBody;
  const cursorVisibleRow = wrapped.cursorRow - firstVisibleRow;
  const cursorPrefix = cursorVisibleRow === 1 && firstVisibleRow === 0
    ? prompt
    : continuation;
  const cursorPrefixWidth = Math.min(columns, visibleWidth(cursorPrefix));
  const cursorColumn = clamp(
    cursorPrefixWidth + wrapped.cursorCol + 1,
    1,
    columns,
  );
  const cursorRow = (hasBorders ? 1 : 0) + cursorVisibleRow;

  return { lines, cursorRow, cursorColumn, bodyRows, firstVisibleRow, hasPlaceholder };
}

/** Drop the first `count` code points of a draft. */
function stripCodePoints(text: string, count: number): string {
  if (count <= 0) return text;
  return Array.from(text).slice(count).join('');
}

/** Split on hard newlines and keep the editor's code-point cursor index global. */
function wrapTextWithCursor(
  text: string,
  width: number,
  cursor: number,
): { readonly rows: string[]; readonly cursorRow: number; readonly cursorCol: number } {
  const paragraphs = text.split('\n');
  const requestedCursor = Number.isFinite(cursor) ? Math.floor(cursor) : 0;
  const cursorIndex = clamp(requestedCursor, 0, Array.from(text).length);
  const rows: string[] = [];
  let cursorRow = 1;
  let cursorCol = 0;
  let offset = 0;
  let cursorPlaced = false;

  for (const paragraph of paragraphs) {
    const paragraphLength = Array.from(paragraph).length;
    const paragraphCursor = cursorIndex - offset;
    const result = wrapWithCursor(
      paragraph,
      width,
      paragraphCursor >= 0 && paragraphCursor <= paragraphLength
        ? paragraphCursor
        : Number.MAX_SAFE_INTEGER,
    );

    if (!cursorPlaced && paragraphCursor >= 0 && paragraphCursor <= paragraphLength) {
      cursorRow = rows.length + result.cursorRow;
      cursorCol = result.cursorCol;
      cursorPlaced = true;
    }
    rows.push(...result.rows);
    offset += paragraphLength + 1;
  }

  return { rows, cursorRow, cursorCol };
}

function makeBorder(columns: number, unicode: boolean): string {
  const glyph = unicode && visibleWidth('─') === 1 ? '─' : '-';
  return glyph.repeat(columns);
}

function clipToColumns(line: string, columns: number): string {
  if (visibleWidth(line) <= columns) return line;
  let clipped = '';
  let width = 0;
  for (const codePoint of line) {
    const nextWidth = Math.max(0, codePointWidth(codePoint));
    if (width + nextWidth > columns) break;
    clipped += codePoint;
    width += nextWidth;
  }
  return clipped;
}

function positiveDimension(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
