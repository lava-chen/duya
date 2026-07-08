/**
 * Flow layout — flexbox-style wrap.
 *
 * Places elements left-to-right with a gap. When the next element
 * would overflow the viewport width, wraps to the next row. Within
 * each row, aligns elements by `rowAlign`.
 *
 * Pure function. Coordinates: grid units.
 */
import type { LayoutElement, LayoutResult } from './types';

export interface FlowOptions {
  viewport: { width: number };
  /** Grid units between elements (both horizontal and vertical). */
  gap: number;
  rowAlign: 'start' | 'center' | 'end';
  preserveLocked: boolean;
}

function isLocked(el: LayoutElement): boolean {
  return (el.metadata as { locked?: boolean }).locked === true;
}

export function flowLayout(
  elements: ReadonlyArray<LayoutElement>,
  options: FlowOptions,
): LayoutResult[] {
  if (elements.length === 0) return [];

  const results: LayoutResult[] = [];

  // Separate locked from free.
  const freeElements: LayoutElement[] = [];
  for (const el of elements) {
    if (options.preserveLocked && isLocked(el)) {
      results.push({ id: el.id, position: { ...el.position } });
    } else {
      freeElements.push(el);
    }
  }

  let cursorX = 0;
  let cursorY = 0;
  let rowStartIdx = 0;
  let rowMaxBottom = 0;

  for (let i = 0; i < freeElements.length; i++) {
    const el = freeElements[i];
    const w = el.position.w;
    const h = el.position.h;

    // Check if this element fits on the current row.
    if (cursorX + w > options.viewport.width && cursorX > 0) {
      // Wrap: align the previous row, then move to next row.
      alignRow(results, rowStartIdx, i, options);
      cursorX = 0;
      cursorY = rowMaxBottom + options.gap;
      rowStartIdx = i;
      rowMaxBottom = cursorY + h;
    }

    results.push({
      id: el.id,
      position: { ...el.position, x: cursorX, y: cursorY, w, h },
    });

    rowMaxBottom = Math.max(rowMaxBottom, cursorY + h);
    cursorX += w + options.gap;
  }

  // Align the last row.
  alignRow(results, rowStartIdx, freeElements.length, options);

  return results;
}

function alignRow(
  results: LayoutResult[],
  startIdx: number,
  endIdx: number,
  options: FlowOptions,
): void {
  if (options.rowAlign === 'start' || startIdx >= endIdx) return;

  // Compute row width (sum of element widths + gaps).
  let rowWidth = 0;
  for (let i = startIdx; i < endIdx; i++) {
    rowWidth += results[i].position.w;
    if (i < endIdx - 1) rowWidth += options.gap;
  }
  const offset = options.rowAlign === 'center'
    ? (options.viewport.width - rowWidth) / 2
    : (options.viewport.width - rowWidth); // end

  if (offset <= 0) return;
  for (let i = startIdx; i < endIdx; i++) {
    results[i].position.x += offset;
  }
}
