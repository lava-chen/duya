import { describe, expect, it } from "vitest";

import {
  canvasRectToScreen,
  clipRectToViewport,
  computeFitTransform,
  isRectFullyVisible,
  regionToCanvasPx,
  screenPointToCanvas,
} from "../region-fit";

/**
 * Coordinate-contract tests for agent-initiated canvas captures.
 *
 * The contract under test: an agent captures the SAME coordinates it
 * draws with. Element positions are canvas grid units (1 unit = 80px);
 * a capture region in grid units must land on exactly that canvas area,
 * regardless of where the user's viewport currently is.
 */

describe("regionToCanvasPx", () => {
  it("multiplies grid-unit regions by GRID_PX (80)", () => {
    expect(regionToCanvasPx({ x: 26, y: 22, w: 6, h: 4 })).toEqual({
      x: 2080,
      y: 1760,
      w: 480,
      h: 320,
    });
  });

  it("passes raw canvas pixels through for unit 'px'", () => {
    const region = { x: 100, y: 50, w: 300, h: 200 };
    expect(regionToCanvasPx(region, "px")).toEqual(region);
  });
});

describe("canvasRectToScreen / screenPointToCanvas", () => {
  const t = { panX: -400, panY: -200, zoom: 1.25 };

  it("applies the translate-then-scale transform", () => {
    // Screen = pan + zoom * canvas
    expect(canvasRectToScreen({ x: 100, y: 60, w: 80, h: 40 }, t)).toEqual({
      x: -400 + 1.25 * 100,
      y: -200 + 1.25 * 60,
      w: 1.25 * 80,
      h: 1.25 * 40,
    });
  });

  it("round-trips a point back into canvas space", () => {
    const canvas = { x: 1234, y: -567 };
    const screen = canvasRectToScreen({ ...canvas, w: 1, h: 1 }, t);
    const back = screenPointToCanvas(screen.x, screen.y, t);
    expect(back.x).toBeCloseTo(canvas.x);
    expect(back.y).toBeCloseTo(canvas.y);
  });

  it("keeps negative canvas coordinates invertible (infinite canvas)", () => {
    const back = screenPointToCanvas(-5000, -5000, { panX: 0, panY: 0, zoom: 0.5 });
    expect(back).toEqual({ x: -10000, y: -10000 });
  });
});

describe("isRectFullyVisible / clipRectToViewport", () => {
  const vw = 1200;
  const vh = 800;

  it("treats edge-aligned rects as fully visible", () => {
    expect(isRectFullyVisible({ x: 0, y: 0, w: vw, h: vh }, vw, vh)).toBe(true);
  });

  it("rejects rects hanging off any edge", () => {
    expect(isRectFullyVisible({ x: -1, y: 0, w: 100, h: 100 }, vw, vh)).toBe(false);
    expect(isRectFullyVisible({ x: 0, y: 0, w: vw + 1, h: 100 }, vw, vh)).toBe(false);
  });

  it("clips partial overlap to the visible intersection", () => {
    expect(
      clipRectToViewport({ x: -50, y: -50, w: 200, h: 200 }, vw, vh),
    ).toEqual({ x: 0, y: 0, w: 150, h: 150 });
  });

  it("returns null when there is no intersection", () => {
    expect(
      clipRectToViewport({ x: -300, y: 100, w: 200, h: 100 }, vw, vh),
    ).toBeNull();
  });
});

describe("computeFitTransform", () => {
  const viewportW = 1200;
  const viewportH = 800;

  it("pans without zooming when the region already fits at current zoom", () => {
    // 480x320 canvas px fits inside 1200x800 at zoom 1 — off-screen only
    // because of pan. The fit must keep zoom and re-center the region.
    const { transform, screenRect } = computeFitTransform(
      { x: 2080, y: 1760, w: 480, h: 320 },
      viewportW,
      viewportH,
      { panX: 0, panY: 0, zoom: 1 },
    );

    expect(transform.zoom).toBe(1);
    expect(screenRect).toEqual({ x: 360, y: 240, w: 480, h: 320 });
    expect(isRectFullyVisible(screenRect, viewportW, viewportH)).toBe(true);
  });

  it("shrinks the zoom just enough to frame an oversized region", () => {
    const { transform, screenRect } = computeFitTransform(
      { x: 0, y: 0, w: 3000, h: 2000 },
      viewportW,
      viewportH,
      { panX: 0, panY: 0, zoom: 1 },
    );

    // (1200 - 48) / 3000 = 0.384 ; (800 - 48) / 2000 = 0.376 → min wins
    expect(transform.zoom).toBeCloseTo(0.376);
    expect(screenRect.w).toBeCloseTo(3000 * 0.376);
    expect(screenRect.h).toBeCloseTo(2000 * 0.376);
    expect(isRectFullyVisible(screenRect, viewportW, viewportH)).toBe(true);
  });

  it("clamps at the zoom floor for gigantic regions (overflow reported, not hidden)", () => {
    const { transform, screenRect } = computeFitTransform(
      { x: 0, y: 0, w: 10000, h: 10000 },
      viewportW,
      viewportH,
      { panX: 0, panY: 0, zoom: 1 },
    );

    expect(transform.zoom).toBe(0.2);
    expect(isRectFullyVisible(screenRect, viewportW, viewportH)).toBe(false);
  });

  it("never magnifies past the current zoom for small regions", () => {
    const { transform } = computeFitTransform(
      { x: 5000, y: 5000, w: 10, h: 10 },
      viewportW,
      viewportH,
      { panX: 0, panY: 0, zoom: 0.5 },
    );

    expect(transform.zoom).toBe(0.5);
  });
});
