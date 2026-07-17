"use client";

import React, { useEffect, useRef, useState } from "react";
import { DotsThree } from "@phosphor-icons/react";
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
  /** Set false for a toolbar already positioned in viewport pixels. */
  zoomAware?: boolean;
  /** Set false when a parent already owns positioning. */
  positioned?: boolean;
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
  zoomAware = true,
  positioned = true,
  children,
  onMouseDown,
}) => {
  const zoom = useConductorStore((state) => state.canvasZoom);
  const invZoom = zoomAware ? 1 / (zoom > 0 ? zoom : 1) : 1;

  const style: React.CSSProperties = {
    position: positioned ? "absolute" : "relative",
    display: "flex",
    alignItems: "center",
    gap: 4,
    minHeight: 40,
    padding: "4px 6px",
    background: "var(--command-menu-bg)",
    border: "1px solid var(--command-menu-border)",
    borderRadius: 11,
    boxShadow: "none",
    color: "var(--text-primary)",
    fontSize: 12,
    whiteSpace: "nowrap",
    pointerEvents: "auto",
    zIndex: 30,
    transformOrigin: "top center",
  };

  if (!positioned) {
    style.transform = undefined;
  } else if (left !== undefined && top !== undefined) {
    // Free positioning (used by selection-following toolbars).
    style.left = left * invZoom;
    style.top = top * invZoom;
    style.transform = `scale(${invZoom})`;
    style.transformOrigin = "top left";
  } else if (centerX) {
    // Element-anchored positioning (default).
    style.top = (top ?? -topOffset) * invZoom;
    style.left = "50%";
    style.transform = `translateX(-50%) scale(${invZoom})`;
  } else {
    style.top = (top ?? -topOffset) * invZoom;
    style.left = 0;
    style.transform = `scale(${invZoom})`;
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
  width: 30,
  height: 30,
  borderRadius: 7,
  border: "none",
  background: "transparent",
  color: "var(--text-primary)",
  cursor: "pointer",
  transition: "background var(--motion-duration-micro) var(--motion-smooth)",
};

export const CAPSULE_BTN_ACTIVE: React.CSSProperties = {
  background: "var(--canvas-tool-accent)",
  color: "#fff",
};

export const CAPSULE_DIVIDER: React.CSSProperties = {
  width: 1,
  height: 22,
  background: "var(--command-menu-border)",
  margin: "0 2px",
};

export const CAPSULE_CONTROL_BASE: React.CSSProperties = {
  height: 30,
  border: "1px solid var(--command-menu-border)",
  borderRadius: 7,
  padding: "0 7px",
  color: "var(--text-primary)",
  background: "var(--command-menu-bg)",
  fontSize: 12,
  outline: "none",
};

export interface CapsuleMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
}

interface CapsuleMoreMenuProps {
  items: CapsuleMenuItem[];
  title?: string;
  align?: "left" | "right";
}

export function CapsuleMoreMenu({
  items,
  title = "More actions",
  align = "right",
}: CapsuleMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutsidePress = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const timer = window.setTimeout(() => document.addEventListener("mousedown", handleOutsidePress), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", handleOutsidePress);
    };
  }, [open]);

  return (
    <div ref={menuRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((current) => !current)}
        style={{
          ...CAPSULE_BTN_BASE,
          ...(open ? CAPSULE_BTN_ACTIVE : {}),
        }}
      >
        <DotsThree size={18} weight="bold" />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            bottom: 36,
            [align]: -4,
            minWidth: 148,
            padding: 4,
            background: "var(--command-menu-bg)",
            border: "1px solid var(--command-menu-border)",
            borderRadius: 10,
            boxShadow: "0 12px 28px rgba(0,0,0,0.22)",
            zIndex: 40,
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                item.onSelect();
                setOpen(false);
              }}
              style={{
                display: "block",
                width: "100%",
                padding: "7px 10px",
                border: "none",
                borderRadius: 7,
                background: "transparent",
                color: item.tone === "danger" ? "var(--error)" : "var(--text-primary)",
                textAlign: "left",
                fontSize: 12,
                cursor: item.disabled ? "not-allowed" : "pointer",
                opacity: item.disabled ? 0.45 : 1,
              }}
              onMouseEnter={(event) => {
                if (!item.disabled) event.currentTarget.style.background = "var(--surface-hover)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = "transparent";
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Apply hover background to a non-active capsule button. */
export function capsuleHoverStyle(isActive: boolean): React.CSSProperties {
  return isActive ? CAPSULE_BTN_ACTIVE : {};
}
