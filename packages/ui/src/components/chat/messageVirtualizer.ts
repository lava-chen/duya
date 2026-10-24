/**
 * messageVirtualizer.ts — the row layout behind the transcript list.
 *
 * A session can hold tens of thousands of messages. The list used to mount a
 * React component, a DOM node and an IntersectionObserver for EVERY one of
 * them, which is what made opening a 10 000 message session take 30-40
 * seconds: the observers alone were 10 000 objects, and the rows were in the
 * DOM whether or not anybody could see them.
 *
 * This module owns the part of that problem the browser cannot solve on its
 * own:
 *
 *   - where every row starts (its offset),
 *   - how tall a row is until it has been measured in the DOM,
 *   - and which rows have to be mounted for the current scroll position.
 *
 * The scroll height stays stable because the caller replaces the rows that
 * are NOT mounted with a spacer whose height is the sum of the heights they
 * stand for. The offsets and the spacers are computed from the same numbers,
 * so the layout the user scrolls through is self-consistent: a row always
 * sits exactly at its offset, and jumping to an offset lands on that row.
 */

/** One row of the transcript, as the virtualizer sees it. */
export interface VirtualRow {
  /** Stable identity of the row — the message id. */
  id: string;
  /** Height used until the row has been measured in the DOM. */
  estimatedHeight: number;
}

/** A contiguous range of rows. */
export interface VirtualWindow {
  /** First row of the range (inclusive). */
  start: number;
  /** Last row of the range (inclusive); -1 when the list is empty. */
  end: number;
}

/** The result of measuring a row in the DOM. */
export interface MeasuredHeight {
  /** Index of the row in the current row list. */
  index: number;
  /** Height difference against the height the layout used before. */
  delta: number;
}

/**
 * One entry of the rendered row list.
 *
 * The rows are a FLAT list on purpose: a row keeps the key of its message,
 * so a window that shifts re-uses the DOM nodes of the rows that stay
 * mounted instead of remounting them.
 */
export type RowItem =
  | { kind: 'spacer'; key: string; height: number }
  | { kind: 'row'; index: number };

/** A row never has zero height — the offsets have to stay strictly increasing. */
const MIN_ROW_HEIGHT = 1;

/** First index whose value is >= target. */
function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** First index whose value is > target. */
function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The variable-height row layout of the transcript.
 *
 * The layout is measured, not guessed: a row that has been rendered reports
 * its real height, and that height replaces the estimate. Rows that have
 * never been rendered keep their estimate, so the scroll height of a long
 * transcript is an approximation that gets more accurate the further the user
 * scrolls.
 */
export class MessageVirtualizer {
  private ids: string[] = [];
  private heights: number[] = [];
  /** offsets[i] is the top of row i; offsets[count] is the total height. */
  private offsets: number[] = [0];
  private indexById = new Map<string, number>();
  private measuredHeights = new Map<string, number>();
  private offsetsDirty = false;

  get rowCount(): number {
    return this.ids.length;
  }

  /**
   * Replace the row list. Measured heights are keyed by row id, so a row
   * that was already measured keeps its real height across a rebuild — a
   * streaming update rebuilds the tail of the transcript on every tick, and
   * the settled rows must not fall back to their estimate.
   */
  setRows(rows: readonly VirtualRow[]): void {
    const count = rows.length;
    const ids = new Array<string>(count);
    const heights = new Array<number>(count);
    const indexById = new Map<string, number>();
    const measuredHeights = new Map<string, number>();

    for (let index = 0; index < count; index += 1) {
      const row = rows[index];
      ids[index] = row.id;
      const measured = this.measuredHeights.get(row.id);
      if (measured !== undefined) {
        heights[index] = measured;
        measuredHeights.set(row.id, measured);
      } else {
        heights[index] = Math.max(MIN_ROW_HEIGHT, row.estimatedHeight);
      }
      indexById.set(row.id, index);
    }

    this.ids = ids;
    this.heights = heights;
    this.indexById = indexById;
    this.measuredHeights = measuredHeights;
    this.offsetsDirty = true;
  }

  /** Index of a row, or -1 when the row is not in the list. */
  indexOf(id: string): number {
    const index = this.indexById.get(id);
    return index === undefined ? -1 : index;
  }

  /** Id of a row, or null when the index is out of range. */
  idAt(index: number): string | null {
    return this.ids[index] ?? null;
  }

  /** Height the layout uses for a row (measured when known). */
  heightOf(index: number): number {
    return this.heights[index] ?? 0;
  }

  /** Top of a row. */
  offsetOf(index: number): number {
    this.ensureOffsets();
    if (index <= 0) return 0;
    return this.offsets[Math.min(index, this.offsets.length - 1)];
  }

  /** Height of the whole list. */
  totalHeight(): number {
    this.ensureOffsets();
    return this.offsets[this.offsets.length - 1];
  }

  /**
   * Record the real height of a row.
   *
   * Returns null when the height did not change — a row that is measured
   * again with the same height must not trigger a re-render. A one pixel
   * difference is treated as "the same": the row is laid out in whole
   * pixels, and the jitter of a re-measure must not move the rows below it.
   */
  measure(id: string, height: number): MeasuredHeight | null {
    const index = this.indexById.get(id);
    if (index === undefined) return null;
    if (!Number.isFinite(height) || height <= 0) return null;

    const rounded = Math.ceil(height);
    const previous = this.heights[index];
    if (Math.abs(previous - rounded) <= 1) return null;

    this.measuredHeights.set(id, rounded);
    this.heights[index] = rounded;
    this.offsetsDirty = true;
    return { index, delta: rounded - previous };
  }

  /**
   * The rows that have to be mounted for a scroll position: everything the
   * viewport can show, plus `overscanPx` of context on both sides.
   */
  windowFor(scrollTop: number, viewportHeight: number, overscanPx: number): VirtualWindow {
    const count = this.ids.length;
    if (count === 0) return { start: 0, end: -1 };

    this.ensureOffsets();
    const top = Math.max(0, scrollTop - overscanPx);
    const bottom = scrollTop + Math.max(0, viewportHeight) + overscanPx;

    // The first row whose bottom is below `top` is the first row that can
    // still be seen; the last row whose top is above `bottom` is the last.
    let start = upperBound(this.offsets, top) - 1;
    if (start < 0) start = 0;
    if (start > count - 1) start = count - 1;

    let end = lowerBound(this.offsets, bottom) - 1;
    if (end > count - 1) end = count - 1;
    if (end < start) end = start;

    return { start, end };
  }

  /** The row that contains a scroll offset — the reading position. */
  indexAt(scrollTop: number): number {
    const count = this.ids.length;
    if (count === 0) return -1;

    this.ensureOffsets();
    const index = upperBound(this.offsets, Math.max(0, scrollTop)) - 1;
    return Math.min(count - 1, Math.max(0, index));
  }

  private ensureOffsets(): void {
    if (!this.offsetsDirty) return;
    const count = this.heights.length;
    const offsets = new Array<number>(count + 1);
    offsets[0] = 0;
    for (let index = 0; index < count; index += 1) {
      offsets[index + 1] = offsets[index] + this.heights[index];
    }
    this.offsets = offsets;
    this.offsetsDirty = false;
  }
}

/**
 * Turn the mounted ranges into the items the list renders: the rows
 * themselves, separated by spacers that stand in for the rows that are not
 * mounted. The spacer heights come from the same offsets the rows use, so
 * the scroll height describes the whole transcript while the DOM only holds
 * the visible part of it.
 */
export function planRowItems(
  layout: MessageVirtualizer,
  windows: readonly VirtualWindow[],
  rowCount: number,
): RowItem[] {
  if (rowCount <= 0) return [];

  const ranges = windows
    .map((window) => ({
      start: Math.max(0, window.start),
      end: Math.min(rowCount - 1, window.end),
    }))
    .filter((window) => window.end >= window.start)
    .sort((left, right) => left.start - right.start);

  const merged: VirtualWindow[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }

  const items: RowItem[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) {
      items.push({
        kind: 'spacer',
        key: `spacer-${cursor}`,
        height: layout.offsetOf(range.start) - layout.offsetOf(cursor),
      });
    }
    for (let index = range.start; index <= range.end; index += 1) {
      items.push({ kind: 'row', index });
    }
    cursor = range.end + 1;
  }
  if (cursor < rowCount) {
    items.push({
      kind: 'spacer',
      key: `spacer-${cursor}`,
      height: layout.totalHeight() - layout.offsetOf(cursor),
    });
  }
  return items;
}
