/**
 * The layout tree's parity contract (render-unification P0, step 2).
 *
 * Two properties are pinned, and they are the whole point of the module:
 *
 * 1. PARITY — `regionBoxes` produces the same transcript/composer/status
 *    boxes the patch arithmetic (`layoutRegion` + TUIApp's `composerBottom`/
 *    popupRows feeding `bottom`) produces today, across a sweep of terminal
 *    sizes, popup states and composer heights. A shadow computation that
 *    disagrees with what it shadows is worse than no shadow at all.
 * 2. ADJACENCY — the stack never overlaps and never leaves a hole: the
 *    transcript's bottom edge meets the popup's (or composer's) top edge,
 *    and the status row owns the last row exactly.
 */

import { describe, expect, it } from 'vitest';

import { layoutRegion } from '../geometry.js';
import { regionBoxes, type RegionLayoutInput } from '../layout-tree.js';

function groundTruth(input: RegionLayoutInput) {
  const options = {
    size: { rows: input.rows, columns: input.columns },
    statusRows: input.statusRows,
    overlayWidth: '70%',
  } as const;
  const popupRows = Math.min(input.popupRows, Math.max(0, input.rows - input.statusRows - input.composerHeight));
  const composerBottom = Math.min(input.statusRows + popupRows, Math.max(0, input.rows - 1));
  const transcript = layoutRegion(
    'transcript',
    { bottom: input.composerHeight + input.statusRows + popupRows },
    options,
    true,
  ).metrics;
  const composer = layoutRegion('input', { height: input.composerHeight, bottom: composerBottom }, options, true).metrics;
  const status = layoutRegion('status', { height: input.statusRows, bottom: 0 }, options, true).metrics;
  const completion = popupRows > 0
    ? layoutRegion('completion', { height: popupRows, bottom: input.statusRows }, options, true).metrics
    : null;
  return { transcript, composer, status, completion };
}

function inputs(): readonly RegionLayoutInput[] {
  const cases: RegionLayoutInput[] = [];
  for (const rows of [8, 12, 24, 40, 60]) {
    for (const composerHeight of [3, 5, 8]) {
      for (const popupRows of [0, 3, 7]) {
        cases.push({
          rows, columns: 140, statusRows: 1, composerHeight, popupRows,
          overlayRows: 0, overlayWidth: 0,
        });
      }
    }
  }
  return cases;
}

describe('regionBoxes parity with the patch arithmetic', () => {
  it('matches layoutRegion for transcript, composer and status across the feasible sweep', () => {
    for (const input of inputs()) {
      // Feasible domain: the dock fits with one transcript row to spare.
      // Below it the patch arithmetic overflows negative tops while the tree
      // compresses — a documented divergence, decided at step 3.
      const dock = input.composerHeight + input.statusRows + input.popupRows;
      if (input.rows < dock + 1) continue;
      const tree = regionBoxes(input);
      const truth = groundTruth(input);
      expect(
        { top: tree.transcript.top, height: tree.transcript.height },
        `rows=${input.rows} composer=${input.composerHeight} popup=${input.popupRows}`,
      ).toEqual({ top: truth.transcript.top, height: truth.transcript.height });
      expect({ top: tree.composer.top, height: tree.composer.height }).toEqual({
        top: truth.composer.top, height: truth.composer.height,
      });
      expect({ top: tree.status.top, height: tree.status.height }).toEqual({
        top: truth.status.top, height: truth.status.height,
      });
    }
  });

  it('matches the completion box while open, and closes when popupRows is 0', () => {
    for (const input of inputs().filter((item) => item.popupRows > 0)) {
      const dock = input.composerHeight + input.statusRows + input.popupRows;
      if (input.rows < dock + 1) continue; // feasible domain only (see the sweep above)
      const tree = regionBoxes(input);
      const truth = groundTruth(input);
      expect(tree.completion, `rows=${input.rows} popup=${input.popupRows}`).toEqual({
        top: truth.completion!.top,
        left: truth.completion!.left,
        width: truth.completion!.width,
        height: truth.completion!.height,
      });
    }
    const closed = regionBoxes({ rows: 40, columns: 140, statusRows: 1, composerHeight: 3, popupRows: 0, overlayRows: 0, overlayWidth: 0 });
    expect(closed.completion).toBeNull();
  });
});

describe('regionBoxes adjacency', () => {
  it('never overlaps and never leaves a hole in the docked stack', () => {
    for (const input of inputs()) {
      const dock = input.composerHeight + input.statusRows + input.popupRows;
      if (input.rows < dock + 1) continue; // feasible domain (compression is pinned separately)
      const tree = regionBoxes(input);
      // Top to bottom: transcript, COMPOSER, popup (when open), status.
      expect(tree.transcript.top + tree.transcript.height, `rows=${input.rows}`).toBe(tree.composer.top);
      expect(tree.composer.top + tree.composer.height).toBe(tree.completion?.top ?? tree.status.top);
      if (tree.completion !== null) {
        expect(tree.completion.top + tree.completion.height).toBe(tree.status.top);
      }
      expect(tree.status.top + tree.status.height).toBe(input.rows);
    }
  });

  it('gives the transcript at least one row even on a terminal shorter than the dock', () => {
    const tree = regionBoxes({ rows: 4, columns: 80, statusRows: 1, composerHeight: 8, popupRows: 3, overlayRows: 0, overlayWidth: 0 });
    expect(tree.transcript.height).toBe(1);
    expect(tree.status.top + tree.status.height).toBe(4);
  });

  it('compresses the dock bottom-up on an infeasible terminal — a pinned divergence', () => {
    // Below the feasible domain the tree COMPRESSES, bottom-up: the popup
    // gives way first (transient chrome), then the composer, while the
    // status row and the transcript's single row stand — where the patch
    // arithmetic would slide boxes into negative tops. Which behaviour tiny
    // terminals keep is decided at step 3; this pin makes the choice visible.
    const tree = regionBoxes({ rows: 8, columns: 80, statusRows: 1, composerHeight: 8, popupRows: 3, overlayRows: 0, overlayWidth: 0 });
    expect(tree.transcript).toEqual({ top: 0, left: 0, width: 80, height: 1 });
    expect(tree.composer.height).toBe(3); // 8 compressed to the remaining space
    expect(tree.composer.top + tree.composer.height).toBe(tree.completion!.top);
    expect(tree.completion!.top + tree.completion!.height).toBe(tree.status.top);
    expect(tree.status.top + tree.status.height).toBe(8);
  });

  it('centres the overlay by the same formulas geometry uses', () => {
    const tree = regionBoxes({ rows: 40, columns: 140, statusRows: 1, composerHeight: 3, popupRows: 0, overlayRows: 11, overlayWidth: 98 });
    expect(tree.overlay).toEqual({ top: Math.round((40 - 11) / 2), left: Math.floor((140 - 98) / 2), width: 98, height: 11 });
    const hidden = regionBoxes({ rows: 40, columns: 140, statusRows: 1, composerHeight: 3, popupRows: 0, overlayRows: 0, overlayWidth: 0 });
    expect(hidden.overlay).toBeNull();
  });
});
