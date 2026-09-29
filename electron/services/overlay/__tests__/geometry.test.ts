import { describe, expect, it } from 'vitest';

import { OVERLAY_VISIBLE_ELEMENT_LIMIT, selectVisibleOverlayElements } from '../geometry.js';

function element(
  x: number,
  y: number,
  w: number,
  h: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    controlType: 'Button',
    rect: { x, y, w, h },
    interactive: true,
    ...overrides,
  };
}

describe('selectVisibleOverlayElements', () => {
  it('keeps precise targets and removes duplicate or enclosing bounds', () => {
    const input = [
      element(0, 0, 900, 700),
      element(0, 0, 500, 400),
      element(20, 20, 80, 32),
      element(20, 20, 80, 32, { name: 'duplicate' }),
      element(140, 20, 90, 32),
    ];

    const selected = selectVisibleOverlayElements(input, { x: 0, y: 0, width: 1000, height: 800 });

    expect(selected).toHaveLength(2);
    expect(selected[0]).toMatchObject({ rect: { x: 20, y: 20, w: 80, h: 32 }, overlayIndex: 3 });
    expect(selected[1]).toMatchObject({ rect: { x: 140, y: 20, w: 90, h: 32 }, overlayIndex: 5 });
  });

  it('drops unusable and non-interactive controls', () => {
    const selected = selectVisibleOverlayElements([
      element(0, 0, 80, 32, { interactive: false }),
      element(90, 0, 80, 32, { controlType: 'Pane' }),
      element(180, 0, 0, 32),
      element(270, 0, 80, 32),
    ], { x: 0, y: 0, width: 1000, height: 800 });

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ overlayIndex: 4 });
  });

  it('caps the visible target count while preserving original numbering', () => {
    const input = Array.from({ length: OVERLAY_VISIBLE_ELEMENT_LIMIT + 5 }, (_, index) =>
      element((index % 10) * 40, Math.floor(index / 10) * 40, 16, 16),
    );

    const selected = selectVisibleOverlayElements(input, { x: 0, y: 0, width: 1000, height: 800 });

    expect(selected).toHaveLength(OVERLAY_VISIBLE_ELEMENT_LIMIT);
    expect(selected[0]).toMatchObject({ overlayIndex: 1 });
    expect(selected.at(-1)).toMatchObject({ overlayIndex: OVERLAY_VISIBLE_ELEMENT_LIMIT });
  });

  it('drops rects outside the target display (iconic / off-screen positions)', () => {
    const selected = selectVisibleOverlayElements([
      // A minimized window's elements sit at the iconic position.
      element(-25600, -25600, 200, 40),
      // Fully outside the right/bottom edges.
      element(1100, 0, 80, 32),
      element(0, 900, 80, 32),
      // Intersecting the display edge stays.
      element(980, 10, 80, 32),
      element(0, 0, 80, 32),
    ], { x: 0, y: 0, width: 1000, height: 800 });

    expect(selected).toHaveLength(2);
    expect(selected[0]).toMatchObject({ overlayIndex: 4 });
    expect(selected[1]).toMatchObject({ overlayIndex: 5 });
  });

  it('handles a display with a non-zero origin (secondary monitor)', () => {
    const selected = selectVisibleOverlayElements([
      element(1200, 100, 80, 32),
      element(0, 0, 80, 32), // on the primary display, not this one
    ], { x: 1000, y: 0, width: 1000, height: 800 });

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ overlayIndex: 1 });
  });
});
