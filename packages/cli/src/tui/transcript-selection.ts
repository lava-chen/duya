/** Character selection for the visible fullscreen transcript. */

import type { SpanTagView } from './markdown/inline.js';
import { spansToTags } from './markdown/inline.js';
import { escapeTags } from './markdown/escape.js';
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

export interface CenteredTranscriptButton {
  readonly line: string;
  readonly column: number;
  readonly width: number;
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

/** Overlay a centered inverse-video button on a transcript row. */
export function centeredTranscriptButton(
  spans: readonly StyledSpan[],
  totalWidth: number,
  label: string,
  tagView: SpanTagView,
  selection?: { readonly start: number; readonly end: number },
): CenteredTranscriptButton | undefined {
  if (totalWidth <= 0) return undefined;
  const buttonText = truncateButtonText(` ${label} `, totalWidth);
  const buttonWidth = visibleWidth(buttonText);
  if (buttonWidth <= 0) return undefined;
  const column = Math.floor((totalWidth - buttonWidth) / 2);
  const end = column + buttonWidth;
  const before: StyledSpan[] = [];
  const after: StyledSpan[] = [];
  const append = (target: StyledSpan[], span: StyledSpan, point: string): void => {
    const last = target[target.length - 1];
    if (last !== undefined && sameSpanStyle(last, span)) {
      target[target.length - 1] = { ...last, text: last.text + point };
    } else {
      target.push({ ...span, text: point });
    }
  };
  let afterStart: number | undefined;
  let cell = 0;
  let zeroWidthDestination: 'before' | 'after' | undefined;
  for (const span of spans) {
    for (const point of span.text) {
      const width = codePointWidth(point);
      if (width === 0) {
        const destination = zeroWidthDestination;
        if (destination === 'before') append(before, span, point);
        else if (destination === 'after') append(after, span, point);
        continue;
      }
      const start = cell;
      cell += width;
      if (cell <= column) {
        append(before, span, point);
        zeroWidthDestination = 'before';
      } else if (start >= end && start < totalWidth) {
        afterStart ??= start;
        append(after, span, point);
        zeroWidthDestination = 'after';
      } else {
        zeroWidthDestination = undefined;
      }
    }
  }

  const beforeWidth = before.reduce((width, span) => width + visibleWidth(span.text), 0);
  const beforeRange = selection === undefined
    ? undefined
    : { start: Math.max(0, selection.start), end: Math.min(column, selection.end) };
  const beforeText = beforeRange !== undefined && beforeRange.end > beforeRange.start
    ? paintTranscriptSelection(before, beforeRange.start, beforeRange.end, tagView)
    : spansToTags(before, tagView);
  const afterRange = selection === undefined || afterStart === undefined
    ? undefined
    : {
        start: Math.max(0, selection.start - afterStart),
        end: Math.max(0, Math.min(cell, selection.end) - afterStart),
      };
  const afterText = afterRange !== undefined && afterRange.end > afterRange.start
    ? paintTranscriptSelection(after, afterRange.start, afterRange.end, tagView)
    : spansToTags(after, tagView);
  const rightGap = afterStart === undefined ? 0 : Math.max(0, afterStart - end);
  return {
    line: `${beforeText}${' '.repeat(Math.max(0, column - beforeWidth))}{inverse}${escapeTags(buttonText)}{/inverse}${' '.repeat(rightGap)}${afterText}`,
    column,
    width: buttonWidth,
  };
}

function truncateButtonText(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  let result = '';
  let used = 0;
  for (const point of text) {
    const next = codePointWidth(point);
    if (used + next > width) break;
    result += point;
    used += next;
  }
  return result;
}

function sameSpanStyle(left: StyledSpan, right: StyledSpan): boolean {
  return left.linkId === right.linkId
    && JSON.stringify(left.fg) === JSON.stringify(right.fg)
    && JSON.stringify(left.bg) === JSON.stringify(right.bg)
    && JSON.stringify(left.attrs) === JSON.stringify(right.attrs);
}
