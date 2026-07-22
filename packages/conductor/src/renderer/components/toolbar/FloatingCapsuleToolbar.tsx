"use client";

import React, { RefObject } from "react";
import { createPortal } from "react-dom";
import {
  FloatingToolbarPosition,
  useFloatingElementToolbarPosition,
} from "./useFloatingElementToolbarPosition";

interface FloatingCapsuleToolbarProps {
  /**
   * Ref to the element whose selection toolbar should float above.
   * The toolbar positions itself relative to this element's bounding
   * rect and follows it during canvas pan/zoom and element drag/resize.
   */
  hostRef: RefObject<HTMLElement | null>;
  /** Children — usually the existing CapsuleToolbar contents. */
  children: React.ReactNode;
  /**
   * Stop mouse-down so clicks on the toolbar don't deselect the host
   * element. Defaults to a no-op-prevention handler. Pass-through to
   * the underlying CapsuleToolbar via onMouseDown.
   */
  onMouseDown?: (event: React.MouseEvent) => void;
}

/**
 * Render the selection toolbar as a portal that lives at the document
 * root, outside the canvas's `transform: scale` stacking context. This
 * keeps the toolbar above every canvas element regardless of the host
 * element's z-index, so it cannot be obscured by other elements.
 *
 * The portal container is intentionally transparent — the visual shell
 * (capsule background, border, padding) is owned by the children so
 * they can compose with existing CapsuleToolbar instances without
 * nesting two shells.
 *
 * Note: the portal lives directly under <body>, so it is NOT inside
 * the canvas's `transform: scale(zoom)` ancestor. Buttons render at
 * their natural CSS size; do NOT add an anti-scale transform here —
 * doing so would visually enlarge the toolbar at zoom < 1 and shrink
 * it at zoom > 1, since `getBoundingClientRect()` already returns the
 * post-zoom viewport coordinates.
 */
export const FloatingCapsuleToolbar: React.FC<FloatingCapsuleToolbarProps> = ({
  hostRef,
  children,
  onMouseDown,
}) => {
  const position = useFloatingElementToolbarPosition(hostRef);

  if (typeof document === "undefined") return null;
  if (!position) return null;

  return createPortal(
    <div
      data-floating-element-toolbar
      onMouseDown={(event) => {
        event.stopPropagation();
        onMouseDown?.(event);
      }}
      style={containerStyle(position)}
    >
      {children}
    </div>,
    document.body,
  );
};

function containerStyle(position: FloatingToolbarPosition): React.CSSProperties {
  return {
    position: "fixed",
    left: position.left,
    top: position.top,
    // z-index above canvas_capture overlays (which sit at 10000) and
    // above FloatingTextToolbar (100/101). Picking 200000 makes the
    // "always on top" guarantee explicit and easy to find.
    zIndex: 200000,
    pointerEvents: "auto",
    // Allow dropdowns (color picker, CapsuleMoreMenu) to spill outside.
    overflow: "visible",
    background: "transparent",
    border: "none",
  };
}