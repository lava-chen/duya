/**
 * The capacity bar: the shape the footer, `/context` and the usage window all
 * draw.
 *
 * The properties worth pinning are the ones a reader would notice going wrong:
 * the bar never changes length for a given cell count (a bar that resizes drags
 * the row around), it never round-trips to "empty" while the number beside it
 * says something is used, and every glyph occupies exactly one terminal column.
 */

import { describe, expect, it } from 'vitest';

import {
  CAPACITY_EMPTY,
  CAPACITY_FILLED,
  capacityBar,
  capacityBarCellsForWidth,
  capacityFilledCells,
} from '../capacity-bar.js';
import { visibleWidth } from '../width.js';

describe('capacityBar', () => {
  it('fills the rounded share of the cells', () => {
    expect(capacityBar(0, 8)).toBe('▱▱▱▱▱▱▱▱');
    expect(capacityBar(0.5, 8)).toBe('▰▰▰▰▱▱▱▱');
    expect(capacityBar(0.25, 8)).toBe('▰▰▱▱▱▱▱▱');
    expect(capacityBar(1, 8)).toBe('▰▰▰▰▰▰▰▰');
  });

  it('keeps the length fixed, whatever the ratio', () => {
    for (const ratio of [0, 0.01, 0.33, 0.5, 0.87, 1]) {
      expect(visibleWidth(capacityBar(ratio, 8))).toBe(8);
    }
  });

  it('fills nothing when nobody measured the occupancy', () => {
    expect(capacityBar(null, 8)).toBe('▱▱▱▱▱▱▱▱');
    expect(capacityBar(Number.NaN, 8)).toBe('▱▱▱▱▱▱▱▱');
  });

  it('never shows an empty bar for a non-zero ratio', () => {
    // 1% of eight cells rounds to zero, and an all-empty bar next to `1%` reads
    // as a broken widget. Rounding UP is the safe direction: under-reporting
    // occupancy is how a session walks into a compaction it did not expect.
    expect(capacityFilledCells(0.001, 8)).toBe(1);
    expect(capacityFilledCells(0.01, 24)).toBe(1);
    expect(capacityBar(0.001, 8)).toBe('▰▱▱▱▱▱▱▱');
  });

  it('clamps a ratio that escapes 0–1', () => {
    expect(capacityBar(-3, 8)).toBe('▱▱▱▱▱▱▱▱');
    expect(capacityBar(4, 8)).toBe('▰▰▰▰▰▰▰▰');
  });

  it('renders nothing for a zero-width bar', () => {
    expect(capacityBar(0.5, 0)).toBe('');
    expect(capacityBar(0.5, -4)).toBe('');
  });

  it('uses one cell per glyph in the width table the TUI lays out with', () => {
    // `⚡` measured 1 here and drew 2 in Windows Terminal, which pushed the
    // footer's last column off-screen. Any glyph added to this bar has to pass
    // this assertion first.
    expect(visibleWidth(CAPACITY_FILLED)).toBe(1);
    expect(visibleWidth(CAPACITY_EMPTY)).toBe(1);
  });
});

describe('capacityBarCellsForWidth', () => {
  it('steps down as the terminal narrows', () => {
    expect(capacityBarCellsForWidth(120)).toBe(6);
    expect(capacityBarCellsForWidth(96)).toBe(6);
    expect(capacityBarCellsForWidth(95)).toBe(5);
    expect(capacityBarCellsForWidth(80)).toBe(5);
    expect(capacityBarCellsForWidth(79)).toBe(4);
    expect(capacityBarCellsForWidth(64)).toBe(4);
  });

  it('keeps the footer bar small even on a wide terminal', () => {
    // The bar shares its line with the counters, the rate and the model name,
    // which is flush right. Growing it with the window would push the model off
    // the row it was moved to the right edge of.
    expect(capacityBarCellsForWidth(400)).toBeLessThanOrEqual(6);
  });

  it('asks for no bar at all when there is no room', () => {
    expect(capacityBarCellsForWidth(63)).toBe(0);
    expect(capacityBarCellsForWidth(20)).toBe(0);
    expect(capacityBarCellsForWidth(Number.NaN)).toBe(0);
  });
});
