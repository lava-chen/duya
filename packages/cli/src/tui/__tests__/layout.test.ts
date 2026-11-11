/**
 * The layout distributor's contract (render-unification P0 groundwork).
 *
 * The invariant worth pinning: the sizes sum EXACTLY to the total whenever
 * the total can hold the minimums — rounding is allocated, never dropped,
 * because a dropped cell is a visibly missing last row. On top of that: basis
 * is a preference, not a promise (shrink takes it away, grow fills past it),
 * `'flex'` spells "take the leftover", and min/max are the hard walls.
 */

import { describe, expect, it } from 'vitest';

import { distributeLayout, type LayoutSlot } from '../core/layout.js';

const sum = (sizes: readonly number[]): number => sizes.reduce((total, size) => total + size, 0);

describe('distributeLayout', () => {
  it('splits exactly, with the remainder allocated to the first grower', () => {
    const slots: readonly LayoutSlot[] = [{ basis: 'flex' }, { basis: 10 }, { basis: 'flex', grow: 3 }];
    const sizes = distributeLayout(slots, 25);
    expect(sum(sizes)).toBe(25);
    expect(sizes[1]).toBe(10);
    // leftover 15 split 1:3 → 3.75/11.25 → floor 3 + 11 = 14, remainder 1 to the first grower
    expect(sizes[0]).toBe(4);
    expect(sizes[2]).toBe(11);
  });

  it('shrinks under deficit, weighted, and never below min', () => {
    const slots: readonly LayoutSlot[] = [{ basis: 20, min: 5 }, { basis: 20, min: 2, shrink: 3 }];
    const sizes = distributeLayout(slots, 30); // deficit 10
    expect(sum(sizes)).toBe(30);
    // 1:3 weights over 10 rows of deficit: floor 2 + 7 = 9, and the rounding
    // remainder goes to the FIRST shrinker (allocated, not dropped).
    expect(sizes[0]).toBe(20 - 3);
    expect(sizes[1]).toBe(20 - 7);
  });

  it('min is a hard wall even when the shrink wants to go further', () => {
    const slots: readonly LayoutSlot[] = [{ basis: 20, min: 19 }, { basis: 10 }];
    const sizes = distributeLayout(slots, 20); // deficit 10, but slot 0 may only lose 1
    expect(sizes[0]).toBe(19);
    expect(sizes[1]).toBe(1);
  });

  it('a slot with shrink 0 never shrinks', () => {
    const slots: readonly LayoutSlot[] = [{ basis: 15, shrink: 0 }, { basis: 15 }];
    const sizes = distributeLayout(slots, 22); // deficit 8, all of it on slot 1
    expect(sizes[0]).toBe(15);
    expect(sizes[1]).toBe(7);
  });

  it('caps growth at max and moves the rest to the next grower', () => {
    const slots: readonly LayoutSlot[] = [
      { basis: 0, grow: 1, max: 4 },
      { basis: 0, grow: 1 },
    ];
    const sizes = distributeLayout(slots, 20);
    expect(sizes[0]).toBe(4);
    expect(sizes[1]).toBe(16);
  });

  it("treats 'flex' as basis 0 with grow 1", () => {
    const sizes = distributeLayout([{ basis: 'flex' }, { basis: 6 }], 10);
    expect(sizes).toEqual([4, 6]);
  });

  it('keeps the sum exact across a sweep of feasible totals', () => {
    const slots: readonly LayoutSlot[] = [
      { basis: 'flex', min: 3 },
      { basis: 12, min: 2, max: 16 },
      { basis: 'flex', grow: 2, min: 1 },
    ];
    for (let total = 6; total <= 60; total += 1) { // 6 = Σ min, the feasible floor
      const sizes = distributeLayout(slots, total);
      expect(sum(sizes), `total=${total}`).toBe(total);
    }
  });

  it('answers an empty row with no sizes and an over-constrained row with the mins', () => {
    expect(distributeLayout([], 10)).toEqual([]);
    const sizes = distributeLayout([{ basis: 10, min: 4 }, { basis: 10, min: 4 }], 5);
    expect(sizes).toEqual([4, 4]); // mins win; the overflow is the caller's to see
  });
});
