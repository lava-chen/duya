/**
 * @vitest-environment jsdom
 *
 * Tests for the transcript row virtualizer.
 *
 * The list mounts only the rows around the viewport; the rows it does not
 * mount are replaced by a spacer whose height is the sum of the heights they
 * stand for. These tests pin the three properties that make that safe:
 *
 *   - the window covers the viewport (plus the overscan) and nothing else,
 *   - the scroll height stays the sum of the row heights, and
 *   - a row that is measured keeps its real height across a rebuild, and a
 *     row that is not measured still occupies its estimated space.
 */
import { describe, expect, it } from 'vitest';
import { MessageVirtualizer, planRowItems } from '../messageVirtualizer';

function rows(count: number, height = 100): { id: string; estimatedHeight: number }[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    estimatedHeight: height,
  }));
}

describe('MessageVirtualizer', () => {
  it('mounts only the rows the viewport can show', () => {
    const layout = new MessageVirtualizer();
    layout.setRows(rows(10_000));

    const window = layout.windowFor(5_000, 800, 600);

    // 5 000px of scroll offset with 100px rows: the window starts at the row
    // that contains 4 400px (the overscan) and ends after the row that
    // reaches 6 400px.
    expect(window.start).toBe(44);
    expect(window.end).toBe(63);
    // The whole transcript is NOT mounted.
    expect(window.end - window.start + 1).toBeLessThan(100);
  });

  it('keeps the scroll height equal to the sum of the row heights', () => {
    const layout = new MessageVirtualizer();
    layout.setRows(rows(1_000));

    expect(layout.totalHeight()).toBe(100_000);
    expect(layout.offsetOf(0)).toBe(0);
    expect(layout.offsetOf(10)).toBe(1_000);
  });

  it('replaces a measured height with the real one and reports the delta', () => {
    const layout = new MessageVirtualizer();
    layout.setRows(rows(10, 100));

    const change = layout.measure('row-3', 250);

    expect(change).toEqual({ index: 3, delta: 150 });
    expect(layout.heightOf(3)).toBe(250);
    expect(layout.totalHeight()).toBe(1_150);
    // The rows below the measured row move down by the delta.
    expect(layout.offsetOf(4)).toBe(550);
  });

  it('ignores a measurement that does not change the height', () => {
    const layout = new MessageVirtualizer();
    layout.setRows(rows(10, 100));

    expect(layout.measure('row-3', 100)).toBeNull();
    expect(layout.measure('row-3', 100.4)).toBeNull();
    expect(layout.heightOf(3)).toBe(100);
  });

  it('keeps the measured height of a row across a rebuild', () => {
    const layout = new MessageVirtualizer();
    layout.setRows(rows(10, 100));
    layout.measure('row-3', 250);

    // A rebuild with the same rows (what a streaming tick does to the tail
    // of the transcript) must not throw the measurement away.
    layout.setRows(rows(10, 100));

    expect(layout.heightOf(3)).toBe(250);
    expect(layout.totalHeight()).toBe(1_150);
  });

  it('drops the measurements of rows that are gone', () => {
    const layout = new MessageVirtualizer();
    layout.setRows(rows(10, 100));
    layout.measure('row-3', 250);

    layout.setRows([
      { id: 'other-0', estimatedHeight: 100 },
      { id: 'other-1', estimatedHeight: 100 },
    ]);

    expect(layout.rowCount).toBe(2);
    expect(layout.heightOf(0)).toBe(100);
    expect(layout.totalHeight()).toBe(200);
  });

  it('finds the row that holds a scroll offset', () => {
    const layout = new MessageVirtualizer();
    layout.setRows(rows(10, 100));

    expect(layout.indexAt(0)).toBe(0);
    expect(layout.indexAt(99)).toBe(0);
    expect(layout.indexAt(100)).toBe(1);
    expect(layout.indexAt(999)).toBe(9);
  });
});

describe('planRowItems', () => {
  it('spans the whole list with spacers around the mounted rows', () => {
    const layout = new MessageVirtualizer();
    layout.setRows(rows(1_000, 100));

    const items = planRowItems(layout, [{ start: 100, end: 120 }], 1_000);

    expect(items[0]).toEqual({ kind: 'spacer', key: 'spacer-0', height: 10_000 });
    expect(items[1]).toEqual({ kind: 'row', index: 100 });
    expect(items.at(-2)).toEqual({ kind: 'row', index: 120 });
    expect(items.at(-1)).toEqual({ kind: 'spacer', key: 'spacer-121', height: 87_900 });
    // The spacers carry the rows that are not mounted, so the rendered
    // height is still the height of the whole transcript.
    const rendered = items.reduce((total, item) => (
      total + (item.kind === 'spacer' ? item.height : 100)
    ), 0);
    expect(rendered).toBe(layout.totalHeight());
  });

  it('merges overlapping windows into one mounted range', () => {
    const layout = new MessageVirtualizer();
    layout.setRows(rows(100, 100));

    const items = planRowItems(
      layout,
      [{ start: 10, end: 30 }, { start: 20, end: 40 }],
      100,
    );

    expect(items[0]).toEqual({ kind: 'spacer', key: 'spacer-0', height: 1_000 });
    expect(items.filter((item) => item.kind === 'row')).toHaveLength(31);
    expect(items.at(-1)).toEqual({ kind: 'spacer', key: 'spacer-41', height: 5_900 });
  });

  it('keeps a trailing window separate from the visible one', () => {
    const layout = new MessageVirtualizer();
    layout.setRows(rows(100, 100));

    const items = planRowItems(
      layout,
      [{ start: 0, end: 5 }, { start: 92, end: 99 }],
      100,
    );

    expect(items.filter((item) => item.kind === 'row')).toHaveLength(14);
    expect(items.find((item) => item.kind === 'spacer')).toEqual({
      kind: 'spacer',
      key: 'spacer-6',
      height: 8_600,
    });
  });

  it('keeps the key of a mounted row stable when the window shifts', () => {
    const layout = new MessageVirtualizer();
    layout.setRows(rows(1_000, 100));

    const before = planRowItems(layout, [{ start: 100, end: 120 }], 1_000);
    const after = planRowItems(layout, [{ start: 101, end: 121 }], 1_000);

    // The row that stays mounted keeps its identity, so React re-uses its
    // DOM node instead of remounting the row.
    const beforeRows = before.filter((item) => item.kind === 'row');
    const afterRows = after.filter((item) => item.kind === 'row');
    const afterIndexes = new Set(
      afterRows.filter((item) => item.kind === 'row').map((item) => (item as { index: number }).index),
    );
    const shared = beforeRows.filter((item) => afterIndexes.has((item as { index: number }).index));
    expect(shared).toHaveLength(20);
  });

  it('renders nothing for an empty transcript', () => {
    const layout = new MessageVirtualizer();
    layout.setRows([]);

    expect(planRowItems(layout, [{ start: 0, end: 0 }], 0)).toEqual([]);
  });
});
