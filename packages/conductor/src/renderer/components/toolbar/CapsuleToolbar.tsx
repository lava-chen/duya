"use client";

import React from "react";
import { useConductorStore } from "../../stores/conductor-store";

/**
 * Shared capsule-shaped floating toolbar container.
 *
 * Owns only the visual shell (capsule shape, shadow, dark background),
 * the zoom-aware positioning above an element, and the anti-scale
 * transform so children render at natural size regardless of canvas zoom.
 *
 * Children are the caller's buttons. Callers control visibility by
 * mounting/unmounting this component.
 */
export interface CapsuleToolbarProps {
  /** Offset above the element's top edge, in CSS px (pre-zoom). */
  topOffset?: number;
  /** Center horizontally relative to the element. Default true. */
  centerX?: boolean;
  /** Explicit left position (pre-zoom). When provided, overrides centerX. */
  left?: number;
  /** Explicit top position (pre-zoom). When provided, overrides topOffset. */
  top?: number;
  /** Children buttons. */
  children: React.ReactNode;
  /** Stop mouse down so clicks on the toolbar don't deselect elements. */
  onMouseDown?: (e: React.MouseEvent) => void;
}

const DEFAULT_TOP_OFFSET = 52;

export const CapsuleToolbar: React.FC<CapsuleToolbarProps> = ({
  topOffset = DEFAULT_TOP_OFFSET,
  centerX = true,
  left,
  top,
  children,
  onMouseDown,
}) => {
  const zoom = useConductorStore((state) => state.canvasZoom);
  const invZoom = 1 / (zoom > 0 ? zoom : 1);

  const style: React.CSSProperties = {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    gap: 2,
    padding: "5px 8px",
    background: "rgba(40, 44, 52, 0.98)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 24,
    boxShadow: "0 8px 24px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.2)",
    pointerEvents: "auto",
    zIndex: 30,
    transformOrigin: "top center",
  };

  if (left !== undefined && top !== undefined) {
    // Free positioning (used by selection-following toolbars).
    style.left = left * invZoom;
    style.top = top * invZoom;
    style.transform = `scale(${invZoom})`;
    style.transformOrigin = "top left";
  } else {
    // Element-anchored positioning (default).
    style.top = (top ?? -topOffset) * invZoom;
    if (centerX) {
      style.left = "50%";
      style.transform = `translateX(-50%) scale(${invZoom})`;
    } else {
      style.left = 0;
      style.transform = `scale(${invZoom})`;
    }
  }

  return (
    <div
      style={style}
      onMouseDown={(e) => {
        e.stopPropagation();
        onMouseDown?.(e);
      }}
    >
      {children}
    </div>
  );
};

/**
 * Shared button styles for use inside a CapsuleToolbar. CapsuleToolbar
 * intentionally does not impose button styling so callers can mix
 * icon buttons, text chips, and color swatches freely.
 */
export const CAPSULE_BTN_BASE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: "50%",
  border: "none",
  background: "transparent",
  color: "rgba(255,255,255,0.85)",
  cursor: "pointer",
  transition: "background var(--motion-duration-micro) var(--motion-smooth)",
};

export const CAPSULE_BTN_ACTIVE: React.CSSProperties = {
  background: "var(--conductor-accent)",
  color: "#fff",
};

export const CAPSULE_DIVIDER: React.CSSProperties = {
  width: 1,
  height: 16,
  background: "rgba(255,255,255,0.12)",
  margin: "0 4px",
};

/** Apply hover background to a non-active capsule button. */
export function capsuleHoverStyle(isActive: boolean): React.CSSProperties {
  return isActive ? CAPSULE_BTN_ACTIVE : {};
}
