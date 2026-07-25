/**
 * Unit tests for findEmptySpace — the new "fully empty rectangle,
 * closest to canvas center" algorithm that replaces bin-pack for the
 * canvas_find_empty_space tool (plan 239).
 */
import { describe, expect, it } from 'vitest';
import { findEmptySpace } from './findEmptySpace';

const CANVAS = { width: 40, height: 30 };

describe('findEmptySpace', () => {
  it('returns the centered placement on an empty canvas', () => {
    const result = findEmptySpace(
      [],
      { w: 4, h: 3 },
      { viewport: CANVAS },
    );
    expect(result).not.toBeNull();
    // Canvas center is (20, 15); the 4x3 rectangle should center there.
    expect(result!.x).toBeCloseTo(18, 5);
    expect(result!.y).toBeCloseTo(13.5, 5);
    expect(result!.w).toBe(4);
    expect(result!.h).toBe(3);
    expect(result!.score).toBe(0);
  });

  it('returns a rectangle that does NOT overlap any obstacle', () => {
    const obstacles = [
      { x: 0, y: 0, w: 6, h: 6 },
      { x: 10, y: 0, w: 6, h: 6 },
      { x: 20, y: 0, w: 6, h: 6 },
      { x: 30, y: 0, w: 6, h: 6 },
      { x: 0, y: 12, w: 6, h: 6 },
      { x: 10, y: 12, w: 6, h: 6 },
      { x: 20, y: 12, w: 6, h: 6 },
      { x: 30, y: 12, w: 6, h: 6 },
    ];
    const result = findEmptySpace(
      obstacles,
      { w: 3, h: 3 },
      { viewport: CANVAS },
    );
    expect(result).not.toBeNull();
    // Verify the chosen rectangle does not overlap any obstacle.
    const rect = { x: result!.x, y: result!.y, w: result!.w, h: result!.h };
    for (const obs of obstacles) {
      const overlaps = !(
        rect.x + rect.w <= obs.x ||
        rect.x >= obs.x + obs.w ||
        rect.y + rect.h <= obs.y ||
        rect.y >= obs.y + obs.h
      );
      expect(overlaps, `rect ${JSON.stringify(rect)} overlaps obstacle ${JSON.stringify(obs)}`).toBe(false);
    }
  });

  it('prefers the placement closest to canvas center when multiple are valid', () => {
    // Scatter obstacles so the centered region is open.
    const obstacles = [
      { x: 0, y: 0, w: 5, h: 5 }, // top-left
      { x: 35, y: 0, w: 5, h: 5 }, // top-right
      { x: 0, y: 25, w: 5, h: 5 }, // bottom-left
      { x: 35, y: 25, w: 5, h: 5 }, // bottom-right
    ];
    const result = findEmptySpace(
      obstacles,
      { w: 4, h: 4 },
      { viewport: CANVAS },
    );
    expect(result).not.toBeNull();
    // Center of canvas is (20, 15); for a 4x4 rectangle the center
    // should sit as close to that as possible.
    const centerX = result!.x + 2;
    const centerY = result!.y + 2;
    expect(Math.abs(centerX - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(centerY - 15)).toBeLessThanOrEqual(1);
  });

  it('honors gap padding — returned rectangle stays clear of obstacles', () => {
    const obstacles = [{ x: 18, y: 13, w: 4, h: 4 }]; // dead-center 4x4
    // Asking for a 4x4 with a gap of 0.25 around each obstacle inflates
    // it to 4.5x4.5 centered at (20, 15) → covers (17.75, 12.75) to
    // (22.25, 17.25). A 4x4 rectangle whose any point overlaps that
    // region is invalid.
    const result = findEmptySpace(
      obstacles,
      { w: 4, h: 4 },
      { viewport: CANVAS, gap: 0.25 },
    );
    expect(result).not.toBeNull();
    const padded = { x: 17.75, y: 12.75, w: 4.5, h: 4.5 };
    const rect = { x: result!.x, y: result!.y, w: result!.w, h: result!.h };
    const overlaps = !(
      rect.x + rect.w <= padded.x ||
      rect.x >= padded.x + padded.w ||
      rect.y + rect.h <= padded.y ||
      rect.y >= padded.y + padded.h
    );
    expect(overlaps).toBe(false);
  });

  it('returns null when no fully empty placement fits at the requested size', () => {
    // Cover the entire canvas with a small gap on every side.
    const obstacles = [{ x: 0, y: 0, w: 40, h: 30 }];
    const result = findEmptySpace(
      obstacles,
      { w: 3, h: 3 },
      { viewport: CANVAS },
    );
    expect(result).toBeNull();
  });

  it('returns null when the requested size exceeds the viewport', () => {
    const result = findEmptySpace(
      [],
      { w: 50, h: 3 },
      { viewport: CANVAS },
    );
    expect(result).toBeNull();
  });

  it('clamps the placement inside the viewport (no overflow)', () => {
    const result = findEmptySpace(
      [],
      { w: 1, h: 1 },
      { viewport: CANVAS },
    );
    expect(result).not.toBeNull();
    expect(result!.x).toBeGreaterThanOrEqual(0);
    expect(result!.y).toBeGreaterThanOrEqual(0);
    expect(result!.x + result!.w).toBeLessThanOrEqual(CANVAS.width + 1e-9);
    expect(result!.y + result!.h).toBeLessThanOrEqual(CANVAS.height + 1e-9);
  });

  it('ignores obstacles with non-positive area (defensive)', () => {
    // A zero-width obstacle should not block any placement.
    const result = findEmptySpace(
      [
        { x: 10, y: 10, w: 0, h: 0 },
        { x: 12, y: 12, w: -1, h: 4 },
      ],
      { w: 3, h: 3 },
      { viewport: CANVAS },
    );
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(18.5, 5);
    expect(result!.y).toBeCloseTo(13.5, 5);
  });

  it('returns null on invalid inputs', () => {
    expect(findEmptySpace([], { w: 0, h: 3 }, { viewport: CANVAS })).toBeNull();
    expect(findEmptySpace([], { w: -1, h: 3 }, { viewport: CANVAS })).toBeNull();
    expect(
      findEmptySpace([], { w: 3, h: 3 }, { viewport: { width: NaN, height: 30 } }),
    ).toBeNull();
  });
});
