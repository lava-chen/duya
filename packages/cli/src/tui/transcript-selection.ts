/** Character selection for the visible fullscreen transcript. */

import type { SpanTagView } from './markdown/inline.js';
import { spansToTags } from './markdown/inline.js';
import { codePointWidth, visibleWidth } from './width.js';
import type { StyledSpan } from './core/span.js';

export interface TranscriptPoint {
  readonly row: number;
  readonly column: number;
}

export interface TranscriptSelection {
  readonly start: TranscriptPoint;
  /** Exclusive end, including the cell under the drag endpoint. */
  readonly end: TranscriptPoint;
}

/** Order two inclusive drag endpoints into a half-open selection range. */
export function transcriptSelection(anchor: TranscriptPoint, focus: TranscriptPoint): TranscriptSelection | undefined {
  if (anchor.row === focus.row && anchor.column === focus.column) return undefined;
  const anchorFirst = anchor.row < focus.row || (anchor.row === focus.row && anchor.column < focus.column);
  const first = anchorFirst ? anchor : focus;
  const last = anchorFirst ? focus : anchor;
  return {
    start: first,
    end: { row: last.row, column: last.column + 1 },
  };
}

/** Return the selected columns on one rendered row, clipped to its text. */
export function transcriptSelectionColumns(
  spans: readonly StyledSpan[],
  row: number,
  selection: TranscriptSelection,
  maxColumn?: number,
): { readonly start: number; readonly end: number } | undefined {
  if (row < selection.start.row || row > selection.end.row) return undefined;
  const lineWidth = spans.reduce((width, span) => width + visibleWidth(span.text), 0);
  const start = row === selection.start.row ? selection.start.column : 0;
  const end = row === selection.end.row ? selection.end.column : Math.min(lineWidth, maxColumn ?? lineWidth);
  const clippedStart = Math.max(0, Math.min(lineWidth, start));
  const clippedEnd = Math.max(clippedStart, Math.min(lineWidth, end));
  return clippedEnd > clippedStart ? { start: clippedStart, end: clippedEnd } : undefined;
}

/** Paint a cell range in inverse video while preserving each span's style. */
export function paintTranscriptSelection(
  spans: readonly StyledSpan[],
  start: number,
  end: number,
  tagView: SpanTagView,
): string {
  if (end <= start) return spansToTags(spans, tagView);
  let column = 0;
  let previousSelected = false;
  const out: string[] = [];
  for (const span of spans) {
    let run = '';
    let runSelected: boolean | undefined;
    const flush = (): void => {
      if (run === '') return;
      const tagged = spansToTags([{ ...span, text: run }], tagView);
      out.push(runSelected ? `{inverse}${tagged}{/inverse}` : tagged);
      run = '';
    };
    for (const point of span.text) {
      const width = codePointWidth(point);
      const selected: boolean = width === 0
        ? previousSelected
        : column < end && column + width > start;
      if (runSelected !== undefined && selected !== runSelected) flush();
      runSelected = selected;
      run += point;
      if (width > 0) {
        column += width;
        previousSelected = selected;
      }
    }
    flush();
  }
  return out.join('');
}

/** Read selected text from the same styled rows that are visible on screen. */
export function selectedTranscriptText(
  rows: readonly (readonly StyledSpan[])[],
  selection: TranscriptSelection,
  maxColumn?: number,
): string | undefined {
  const lines: string[] = [];
  const lastRow = Math.min(rows.length - 1, selection.end.row);
  for (let row = selection.start.row; row <= lastRow; row += 1) {
    const spans = rows[row] ?? [];
    const columns = transcriptSelectionColumns(spans, row, selection, maxColumn);
    if (columns === undefined) {
      lines.push('');
      continue;
    }
    let column = 0;
    let previousSelected = false;
    let text = '';
    for (const span of spans) {
      for (const point of span.text) {
        const width = codePointWidth(point);
        const selected: boolean = width === 0
          ? previousSelected
          : column < columns.end && column + width > columns.start;
        if (selected) text += point;
        if (width > 0) {
          column += width;
          previousSelected = selected;
        }
      }
    }
    lines.push(text.trimEnd());
  }
  const text = lines.join('\n');
  return text.length === 0 ? undefined : text;
}
