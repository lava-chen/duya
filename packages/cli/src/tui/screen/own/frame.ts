import { visibleWidth } from '../../width.js';
import { renderMarkup } from './markup.js';
import { layoutRegion, screenRegions, type GeometryOptions, type RegionLayout } from './geometry.js';
import { spanStyleParameters } from '../../terminal/ansi.js';
import { backgroundParameterFor, colorFromTagBody, type SpanColor } from '../../core/color.js';
import type { SceneLine, StyledSpan } from '../../core/span.js';
import type { RegionPatch, SurfaceRegion } from '../types.js';

interface Cell {
  text: string;
  style: string;
  width: number;
  continuation: boolean;
}

export interface SurfaceFrame {
  readonly rows: readonly string[];
  readonly keys: readonly string[];
}

function blankCell(): Cell {
  return { text: ' ', style: '', width: 1, continuation: false };
}

function emptyGrid(rows: number, columns: number): Cell[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => blankCell()),
  );
}

function clearCell(row: Cell[], column: number): void {
  if (column < 0 || column >= row.length) return;
  const current = row[column];
  if (current === undefined) return;
  if (current.continuation) {
    if (column > 0) row[column - 1] = blankCell();
    row[column] = blankCell();
    return;
  }
  if (current.width > 1 && column + 1 < row.length) row[column + 1] = blankCell();
  row[column] = blankCell();
}

function putCell(grid: Cell[][], rowIndex: number, column: number, text: string, style: string): void {
  const row = grid[rowIndex];
  if (row === undefined || rowIndex < 0 || column < 0 || column >= row.length) return;
  const width = Math.max(1, visibleWidth(text));
  if (column + width > row.length) return;
  for (let offset = 0; offset < width; offset += 1) clearCell(row, column + offset);
  row[column] = { text, style, width, continuation: false };
  for (let offset = 1; offset < width; offset += 1) {
    row[column + offset] = { text: '', style, width: 0, continuation: true };
  }
}

/**
 * Draw one logical markup line, wrapping onto following rows when it is wider
 * than the region.
 *
 * blessed wraps inside its element (`_clines`) and this renderer has to match
 * it: without wrapping a notice wider than the pane is silently cut at the
 * right edge, so text that blessed shows in full simply vanishes. Wrapping is
 * a PAINT concern only — `content()` still reports the logical lines the caller
 * handed over, which is why this does not touch the patch.
 *
 * Returns how many rows were consumed so the caller can advance the cursor.
 */
function drawMarkupLine(
  grid: Cell[][],
  row: number,
  column: number,
  maxWidth: number,
  line: string,
  maxRows: number,
): number {
  // Content is one logical row. Control bytes are not printable terminal text.
  const safe = line.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const rendered = renderMarkup(safe);
  if (maxRows <= 0) return 0;
  const sgr = /\u001b\[([0-9;]*)m/g;
  let cursor = 0;
  let writeRow = row;
  let writeColumn = column;
  let rowsUsed = 1;
  let style = '';
  const stopColumn = column + maxWidth;
  const emit = (text: string): void => {
    for (const glyph of Array.from(text)) {
      const width = visibleWidth(glyph);
      if (width === 0) {
        // A zero-width glyph (a combining mark) belongs to the cell before it.
        // Dropping it would decompose accented text into two visible glyphs.
        const previous = grid[writeRow]?.[writeColumn - 1];
        if (previous !== undefined && !previous.continuation) previous.text += glyph;
        continue;
      }
      if (writeColumn + width > stopColumn) {
        // Out of columns: continue on the next row, keeping the current style.
        if (rowsUsed >= maxRows) return;
        writeRow += 1;
        writeColumn = column;
        rowsUsed += 1;
      }
      putCell(grid, writeRow, writeColumn, glyph, style);
      writeColumn += width;
    }
  };
  let match = sgr.exec(rendered);
  while (match !== null) {
    emit(rendered.slice(cursor, match.index));
    style = match[1] ?? '';
    cursor = match.index + match[0].length;
    match = sgr.exec(rendered);
  }
  emit(rendered.slice(cursor));
  return rowsUsed;
}

/**
 * Draw one line of spans, with the same wrapping rules as the markup path.
 *
 * This is the same algorithm without the SGR parsing: a span already carries its
 * style, so there is nothing to scan, no escape bytes to strip and no chance of a
 * malformed sequence reaching a cell. The style string it stores is
 * `spanStyleParameters`, the SAME function `spansToAnsi` uses — which is why a
 * cell painted from spans and a cell painted from tags compare equal, and why
 * the parity test between the two paths is a real check.
 */
function drawSpanLine(
  grid: Cell[][],
  row: number,
  column: number,
  maxWidth: number,
  spans: readonly StyledSpan[],
  maxRows: number,
): number {
  if (maxRows <= 0) return 0;
  let writeRow = row;
  let writeColumn = column;
  let rowsUsed = 1;
  const stopColumn = column + maxWidth;

  const emit = (text: string, style: string): void => {
    for (const glyph of Array.from(text)) {
      const width = visibleWidth(glyph);
      if (width === 0) {
        const previous = grid[writeRow]?.[writeColumn - 1];
        if (previous !== undefined && !previous.continuation) previous.text += glyph;
        continue;
      }
      if (writeColumn + width > stopColumn) {
        // Wrap onto the next row, keeping the span's style across the fold.
        if (rowsUsed >= maxRows) return;
        writeRow += 1;
        writeColumn = column;
        rowsUsed += 1;
      }
      putCell(grid, writeRow, writeColumn, glyph, style);
      writeColumn += width;
    }
  };

  for (const span of spans) {
    // Content is one logical row: control bytes are not printable text. Same
    // filter as the markup path, applied per span because that is the unit that
    // carries the text here.
    const text = span.text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
    if (text === '') continue;
    emit(text, spanStyleParameters(span));
  }
  return rowsUsed;
}

/** Draw one line in whichever representation it arrived in. */
function drawLine(
  grid: Cell[][],
  row: number,
  column: number,
  maxWidth: number,
  line: SceneLine,
  maxRows: number,
): number {
  return typeof line === 'string'
    ? drawMarkupLine(grid, row, column, maxWidth, line, maxRows)
    : drawSpanLine(grid, row, column, maxWidth, line, maxRows);
}

function borderSgr(color: string): string {
  const key = color.toLowerCase().replace(/-fg$/, '').replace(/[- ]/g, '');
  const named: Readonly<Record<string, string>> = {
    black: '30',
    red: '31',
    green: '32',
    yellow: '33',
    blue: '34',
    magenta: '35',
    cyan: '36',
    white: '37',
    gray: '90',
    grey: '90',
    lightgray: '37',
    lightgrey: '37',
    brightblack: '90',
    brightred: '91',
    brightgreen: '92',
    brightyellow: '93',
    brightblue: '94',
    brightmagenta: '95',
    brightcyan: '96',
    brightwhite: '97',
  };
  const found = named[key];
  if (found !== undefined) return found;
  if (/^\d{1,3}$/.test(key)) {
    const index = Number(key);
    if (index >= 0 && index <= 255) return '38;5;' + index;
  }
  return '37';
}

/**
 * The SGR parameter for a region's background fill.
 *
 * The fill is named the way the palette names it — a blessed tag body such as
 * `236-bg` — so the theme decides the colour and the renderer only decides
 * how to paint it. An unknown body paints no fill at all: a band that
 * silently vanished would be worse than one that never existed.
 */
function backgroundSgr(body: string | undefined): string {
  if (body === undefined) return '';
  const color = colorFromTagBody(body, 'bg');
  return color === undefined ? '' : backgroundParameterFor(color);
}

/** The colour behind a region's fill, for the spans that sit on it. */
function backgroundColor(body: string | undefined): SpanColor | undefined {
  return body === undefined ? undefined : colorFromTagBody(body, 'bg');
}

/**
 * Put a line on the region's fill.
 *
 * A tagged line is wrapped in the fill's tag; a span line gets the fill as
 * its background unless it already carries one. Both keep the fill UNDER the
 * text: the band is the cell behind the text, never the text colour.
 */
function withBackground(line: SceneLine, body: string, color: SpanColor): SceneLine {
  if (typeof line === 'string') return `{${body}}${line}{/${body}}`;
  return line.map((span) => (span.bg === undefined ? { ...span, bg: color } : span));
}

function drawBorder(grid: Cell[][], layout: RegionLayout, unicodeBox: boolean): void {
  const { metrics, borderStyle } = layout;
  if (borderStyle === 'none') return;
  const left = metrics.left;
  const top = metrics.top;
  const right = left + metrics.width - 1;
  const bottom = top + metrics.height - 1;
  // The band belongs to the rules too: a rule drawn in the effort colour but
  // on the default background would cut the composer's fill in half.
  const fill = backgroundSgr(layout.background);
  const color = fill === '' ? borderSgr(layout.borderColor) : `${borderSgr(layout.borderColor)};${fill}`;
  const horizontal = unicodeBox ? '─' : '-';
  for (let x = left; x <= right; x += 1) {
    putCell(grid, top, x, horizontal, color);
    if (bottom !== top) putCell(grid, bottom, x, horizontal, color);
  }
  if (borderStyle === 'composer') return;
  const vertical = unicodeBox ? '│' : '|';
  for (let y = top + 1; y < bottom; y += 1) {
    putCell(grid, y, left, vertical, color);
    if (right !== left) putCell(grid, y, right, vertical, color);
  }
  putCell(grid, top, left, unicodeBox ? '┌' : '+', color);
  putCell(grid, top, right, unicodeBox ? '┐' : '+', color);
  putCell(grid, bottom, left, unicodeBox ? '└' : '+', color);
  putCell(grid, bottom, right, unicodeBox ? '┘' : '+', color);
}

function drawRegion(grid: Cell[][], layout: RegionLayout, unicodeBox: boolean): void {
  if (layout.hidden) return;
  const { metrics } = layout;
  const left = Math.max(0, metrics.left);
  const top = Math.max(0, metrics.top);
  const right = Math.min(grid[0]?.length ?? 0, metrics.left + metrics.width);
  const bottom = Math.min(grid.length, metrics.top + metrics.height);
  // The fill goes down FIRST, across the whole rectangle: the band is the
  // region, and the text is drawn on top of it.
  const fill = backgroundSgr(layout.background);
  const fillColor = backgroundColor(layout.background);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) putCell(grid, y, x, ' ', fill);
  }
  drawBorder(grid, layout, unicodeBox);
  const contentLeft = metrics.left + metrics.innerLeft;
  const contentTop = metrics.top + metrics.innerTop;
  // One logical line can occupy several physical rows when it wraps, so the
  // cursor advances by what the last line CONSUMED rather than by index.
  let cursorRow = 0;
  for (const line of layout.lines) {
    if (cursorRow >= layout.contentHeight) break;
    const painted = fillColor === undefined ? line : withBackground(line, layout.background ?? '', fillColor);
    cursorRow += drawLine(
      grid,
      contentTop + cursorRow,
      contentLeft,
      layout.contentWidth,
      painted,
      layout.contentHeight - cursorRow,
    );
  }
}

function rowKey(row: readonly Cell[]): string {
  return row.map((cell) =>
    cell.style + '\u0001' + cell.text + '\u0001' + (cell.continuation ? '1' : '0'),
  ).join('\u0000');
}

/**
 * Whether a cell's SGR parameters ask for a background.
 *
 * A background parameter is either the `48;…` family or one of the eight
 * background codes (40–47) and their bright variants (100–107). The check
 * exists because a cell's style is an opaque parameter list, and this is the
 * one question the painter asks about it.
 */
function hasBackground(style: string): boolean {
  if (style === '') return false;
  for (const part of style.split(';')) {
    if (part === '48' || part.startsWith('48;')) return true;
    const code = Number(part);
    if (Number.isInteger(code) && ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))) return true;
  }
  return false;
}

function renderRow(row: readonly Cell[]): string {
  let last = -1;
  for (let index = row.length - 1; index >= 0; index -= 1) {
    const cell = row[index];
    // A cell that carries a BACKGROUND is content even when its text is a
    // space: that is how a filled band reaches the edge of the row. Trimming
    // it would cut the band's last columns off and leave the composer a frame
    // rather than a surface.
    if (cell !== undefined && !cell.continuation && (cell.text !== ' ' || hasBackground(cell.style))) {
      last = index + Math.max(1, cell.width) - 1;
      break;
    }
  }
  let output = '';
  let activeStyle = '';
  for (let index = 0; index <= last; index += 1) {
    const cell = row[index];
    if (cell === undefined || cell.continuation) continue;
    if (cell.style !== activeStyle) {
      if (activeStyle !== '') output += '\u001b[m';
      if (cell.style !== '') output += '\u001b[' + cell.style + 'm';
      activeStyle = cell.style;
    }
    output += cell.text;
  }
  if (activeStyle !== '') output += '\u001b[m';
  return output;
}

export function composeFrame(
  patches: ReadonlyMap<SurfaceRegion, RegionPatch>,
  attached: ReadonlySet<SurfaceRegion>,
  options: GeometryOptions,
  laidOut: boolean,
): { frame: SurfaceFrame; layouts: ReadonlyMap<SurfaceRegion, RegionLayout> } {
  const columns = Math.max(1, Math.floor(options.size.columns || 80));
  const rows = Math.max(1, Math.floor(options.size.rows || 24));
  const grid = emptyGrid(rows, columns);
  const layouts = new Map<SurfaceRegion, RegionLayout>();
  for (const region of screenRegions()) {
    if (!attached.has(region)) continue;
    const layout = layoutRegion(region, patches.get(region), options, laidOut);
    layouts.set(region, layout);
    drawRegion(grid, layout, options.unicodeBox !== false);
  }
  return {
    frame: {
      rows: grid.map(renderRow),
      keys: grid.map(rowKey),
    },
    layouts,
  };
}

export function changedRows(previous: SurfaceFrame | null, next: SurfaceFrame): string {
  let output = '';
  for (let row = 0; row < next.rows.length; row += 1) {
    if (previous?.keys[row] === next.keys[row]) continue;
    output += '\u001b[' + (row + 1) + ';1H\u001b[2K' + (next.rows[row] ?? '');
  }
  return output;
}
