"use client";

import { RefObject, useLayoutEffect, useState } from "react";

/**
 * Compute the viewport-pixel position for an element-anchored floating
 * toolbar. The toolbar is positioned above the element by default and
 * flips below when the element is too close to the top edge.
 *
 * The returned coordinates are in viewport (CSS) pixels, the same
 * coordinate system that `getBoundingClientRect()` reports. Callers
 * that render the toolbar outside the canvas's `transform: scale`
 * stacking context (e.g. via a portal at the document root) should
 * pass these through directly without applying any anti-scale
 * transform — the portal container has no zoom ancestor, so applying
 * one would visually enlarge the toolbar at zoom < 1.
 *
 * The hook re-evaluates on element resize, viewport resize, and on
 * each animation frame while mounted (to track imperative canvas
 * pan/zoom updates that happen outside React's render loop).
 */
export interface FloatingToolbarPosition {
  /** Viewport-pixel X of the toolbar's left edge. */
  left: number;
  /** Viewport-pixel Y of the toolbar's top edge. */
  top: number;
  /** Whether the toolbar should appear below the element. */
  below: boolean;
}

const TOOLBAR_HEIGHT_PX = 48;
const TOOLBAR_WIDTH_PX = 360;
const VIEWPORT_MARGIN_PX = 8;

function computePosition(target: HTMLElement): FloatingToolbarPosition | null {
  const rect = target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : rect.right + TOOLBAR_WIDTH_PX;
  const centerX = rect.left + rect.width / 2;
  let left = centerX - TOOLBAR_WIDTH_PX / 2;
  left = Math.max(VIEWPORT_MARGIN_PX, Math.min(left, viewportWidth - TOOLBAR_WIDTH_PX - VIEWPORT_MARGIN_PX));

  // Default above the element; flip below if there isn't room.
  let top = rect.top - TOOLBAR_HEIGHT_PX - VIEWPORT_MARGIN_PX;
  const below = top < VIEWPORT_MARGIN_PX;
  if (below) {
    top = rect.bottom + VIEWPORT_MARGIN_PX;
  }

  return { left, top, below };
}

export function useFloatingElementToolbarPosition(
  targetRef: RefObject<HTMLElement | null>,
): FloatingToolbarPosition | null {
  const [position, setPosition] = useState<FloatingToolbarPosition | null>(() => {
    const target = targetRef.current;
    return target ? computePosition(target) : null;
  });

  useLayoutEffect(() => {
    const target = targetRef.current;
    if (!target) {
      setPosition(null);
      return;
    }

    let lastLeft = -Infinity;
    let lastTop = -Infinity;
    let lastBelow: boolean | null = null;

    const refresh = () => {
      const next = computePosition(target);
      if (!next) {
        if (lastLeft !== -Infinity) {
          setPosition(null);
          lastLeft = -Infinity;
        }
        return;
      }
      if (
        Math.abs(next.left - lastLeft) < 0.5
        && Math.abs(next.top - lastTop) < 0.5
        && next.below === lastBelow
      ) {
        return;
      }
      lastLeft = next.left;
      lastTop = next.top;
      lastBelow = next.below;
      setPosition(next);
    };

    refresh();

    // ResizeObserver catches element size changes from drag/resize.
    const ro = new ResizeObserver(refresh);
    ro.observe(target);

    // Window resize affects viewport clamping.
    window.addEventListener("resize", refresh);

    // The canvas pan/zoom state is mutated outside React. Poll once per
    // animation frame while the toolbar is mounted so the toolbar stays
    // glued to the element during gestures. The early-return guard above
    // skips setState when nothing changed, so the per-frame cost is one
    // getBoundingClientRect + a few comparisons.
    let rafId: number | null = window.requestAnimationFrame(function tick() {
      refresh();
      rafId = window.requestAnimationFrame(tick);
    });

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener("resize", refresh);
    };
  }, [targetRef]);

  return position;
}