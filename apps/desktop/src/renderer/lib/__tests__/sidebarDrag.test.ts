import { describe, expect, it } from "vitest";

import {
  COLLAPSED_ROW_HEIGHT,
  restrictVerticalDragWithinContainer,
} from "../sidebarDrag";

// Plain-object rect factory. The real dnd-kit modifier receives
// `DOMRect`s, but in the node test environment `DOMRect` isn't
// available globally — what we actually need is the shape, so we
// build minimal plain objects with the same fields the modifier
// reads (top/bottom/height).
function rect(top: number, height: number) {
  return { top, bottom: top + height, height };
}

function call(args: Parameters<typeof restrictVerticalDragWithinContainer>[0]) {
  // Cast to `never` because dnd-kit's Modifier type expects a long
  // list of fields we don't actually use; the modifier only reads
  // `transform`, `draggingNodeRect`, `containerNodeRect`, and
  // `activeNodeRect`.
  return restrictVerticalDragWithinContainer(args as never);
}

describe("sidebarDrag", () => {
  describe("COLLAPSED_ROW_HEIGHT", () => {
    it("is a positive integer small enough for compact sidebar rows", () => {
      expect(COLLAPSED_ROW_HEIGHT).toBeGreaterThan(0);
      expect(COLLAPSED_ROW_HEIGHT).toBeLessThanOrEqual(64);
    });
  });

  describe("restrictVerticalDragWithinContainer", () => {
    it("zeros horizontal motion so the dragged row stays in its column", () => {
      const result = call({
        transform: { x: 200, y: 30, scaleX: 1, scaleY: 1 },
        activeNodeRect: rect(100, 32),
        containerNodeRect: rect(0, 600),
        draggingNodeRect: rect(130, 32),
      } as never);
      expect(result.x).toBe(0);
    });

    it("clamps the vertical drag so the dragged row stays inside the container", () => {
      // Container 0..600, drag height 32 → max top 568. Active
      // node starts at 500, raw transform.y = 200 → desired top
      // 700, clamped to 568 → relative y = 568 - 500 = 68.
      const result = call({
        transform: { x: 0, y: 200, scaleX: 1, scaleY: 1 },
        activeNodeRect: rect(500, 32),
        containerNodeRect: rect(0, 600),
        draggingNodeRect: rect(700, 32),
      } as never);
      expect(result.y).toBe(68);
    });

    it("clamps the top so the row can't leave the upper edge either", () => {
      const result = call({
        transform: { x: 0, y: -500, scaleX: 1, scaleY: 1 },
        activeNodeRect: rect(100, 32),
        containerNodeRect: rect(0, 600),
        draggingNodeRect: rect(-400, 32),
      } as never);
      // 100 + -500 = -400 → clamped to 0 → relative y = 0 - 100 = -100.
      expect(result.y).toBe(-100);
    });

    it("falls back to a zero-x transform when the modifier can't read the rects", () => {
      const result = call({
        transform: { x: 99, y: 0, scaleX: 1, scaleY: 1 },
        activeNodeRect: null,
        containerNodeRect: null,
        draggingNodeRect: null,
      } as never);
      expect(result.x).toBe(0);
    });

    it("preserves the rest of the input transform fields (scaleX/scaleY)", () => {
      const result = call({
        transform: { x: 50, y: 10, scaleX: 1, scaleY: 1 },
        activeNodeRect: rect(100, 32),
        containerNodeRect: rect(0, 600),
        draggingNodeRect: rect(110, 32),
      } as never);
      expect(result.scaleX).toBe(1);
      expect(result.scaleY).toBe(1);
    });
  });
});