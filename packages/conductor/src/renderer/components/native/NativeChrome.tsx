"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasElement, CanvasPosition } from "../..//types/conductor";
import { useConductorStore } from "../..//stores/conductor-store";
import { canvasTransformState } from "../CanvasArea";
import { GRID_PX } from "../../domain/canvas/units";
import { PencilIcon, TrashIcon, CaretDownIcon } from "@/components/icons";
import { executeAction } from "../../ipc/conductor-ipc";
import { useStyleUpdate } from "../StylePanel";
import { STICKY_COLORS, STICKY_COLOR_KEYS, type StickyColorKey } from "./sticky-colors";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import {
  CapsuleToolbar,
  CAPSULE_BTN_BASE,
  CAPSULE_BTN_ACTIVE,
  CAPSULE_DIVIDER,
} from "../toolbar/CapsuleToolbar";
import { TextSelectionToolbar } from "./TextSelectionToolbar";

type HandleDirection = "nw" | "ne" | "se" | "sw";

const HANDLE_SIZE = 8;
const MIN_SIZE_GRID = 1;

type StickyShape = "rect" | "diamond" | "ellipse";

const SHAPES: { value: StickyShape; labelKey: TranslationKey; icon: React.ReactNode }[] = [
  {
    value: "rect",
    labelKey: "conductor.toolbar.shapeRect",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ display: "block" }}>
        <rect x="2.5" y="3.5" width="11" height="9" rx="2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    value: "diamond",
    labelKey: "conductor.toolbar.shapeDiamond",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ display: "block" }}>
        <rect
          x="2.5"
          y="3.5"
          width="11"
          height="9"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.5"
          transform="rotate(45 8 8)"
        />
      </svg>
    ),
  },
  {
    value: "ellipse",
    labelKey: "conductor.toolbar.shapeEllipse",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ display: "block" }}>
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
];

const BORDER_STYLES: { value: "none" | "solid" | "dashed" | "dotted"; labelKey: TranslationKey }[] = [
  { value: "none", labelKey: "conductor.toolbar.borderNone" },
  { value: "solid", labelKey: "conductor.toolbar.borderSolid" },
  { value: "dashed", labelKey: "conductor.toolbar.borderDashed" },
  { value: "dotted", labelKey: "conductor.toolbar.borderDotted" },
];

function StickySelectionToolbar({
  element,
  onEdit,
  onDelete,
}: {
  element: CanvasElement;
  onEdit: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const apply = useStyleUpdate(element);
  const [colorOpen, setColorOpen] = useState(false);
  const colorMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!colorOpen) return;
    const handle = (e: MouseEvent) => {
      if (!colorMenuRef.current?.contains(e.target as Node)) {
        setColorOpen(false);
      }
    };
    window.setTimeout(() => document.addEventListener("mousedown", handle), 0);
    return () => document.removeEventListener("mousedown", handle);
  }, [colorOpen]);

  const shape = (element.config.shape as StickyShape) || "rect";
  const bgColor = element.config.bgColor as string | undefined;
  const legacyColorKey = ((element.config.color as string) || "yellow") as StickyColorKey;
  const currentBg = bgColor ?? STICKY_COLORS[legacyColorKey]?.bg ?? STICKY_COLORS.yellow.bg;

  const borderStyleCfg = element.config.borderStyle as
    | { color?: string; width?: number; style?: "solid" | "dashed" | "dotted" }
    | undefined;
  const borderKey: "none" | "solid" | "dashed" | "dotted" =
    !borderStyleCfg || !borderStyleCfg.width ? "none" : borderStyleCfg.style ?? "solid";

  const setShape = (value: StickyShape) => apply({ shape: value });
  const setBorder = (value: "none" | "solid" | "dashed" | "dotted") => {
    if (value === "none") {
      apply({ borderStyle: { width: 0, style: "solid", color: "transparent" } });
    } else {
      const width = borderStyleCfg?.width && borderStyleCfg.width > 0 ? borderStyleCfg.width : 2;
      const color =
        borderStyleCfg?.color && borderStyleCfg.color !== "transparent"
          ? borderStyleCfg.color
          : "#333333";
      apply({ borderStyle: { width, style: value, color } });
    }
  };
  const setBgColor = (hex: string) => {
    apply({ bgColor: hex });
    setColorOpen(false);
  };

  return (
    <CapsuleToolbar>
      {SHAPES.map((s) => (
        <button
          key={s.value}
          type="button"
          title={t(s.labelKey)}
          onClick={() => setShape(s.value)}
          style={{
            ...CAPSULE_BTN_BASE,
            ...(shape === s.value ? CAPSULE_BTN_ACTIVE : {}),
          }}
          onMouseEnter={(e) => {
            if (shape !== s.value) e.currentTarget.style.background = "rgba(255,255,255,0.1)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background =
              shape === s.value ? (CAPSULE_BTN_ACTIVE.background as string) : "transparent";
          }}
        >
          {s.icon}
        </button>
      ))}

      <div style={CAPSULE_DIVIDER} />

      <div style={{ position: "relative" }} ref={colorMenuRef}>
        <button
          type="button"
          title={t("conductor.toolbar.fill")}
          onClick={() => setColorOpen((v: boolean) => !v)}
          style={{
            ...CAPSULE_BTN_BASE,
            width: "auto",
            padding: "0 6px",
            borderRadius: 14,
            gap: 2,
          }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: currentBg,
              border: "1px solid rgba(255,255,255,0.25)",
              display: "inline-block",
            }}
          />
          <CaretDownIcon size={10} color="rgba(255,255,255,0.6)" />
        </button>
        {colorOpen && (
          <div
            style={{
              position: "absolute",
              bottom: 36,
              left: "50%",
              transform: "translateX(-50%)",
              display: "grid",
              gridTemplateColumns: "repeat(3, 28px)",
              gap: 6,
              padding: 10,
              background: "rgba(40, 44, 52, 0.98)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 12,
              boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
              zIndex: 30,
            }}
          >
            {STICKY_COLOR_KEYS.map((key) => {
              const hex = STICKY_COLORS[key].bg;
              const active = currentBg === hex;
              return (
                <button
                  key={key}
                  type="button"
                  title={key}
                  onClick={() => setBgColor(hex)}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    border: active ? "2px solid #fff" : "1px solid rgba(255,255,255,0.2)",
                    padding: 0,
                    background: hex,
                    cursor: "pointer",
                    boxShadow: active ? "0 0 0 1px var(--conductor-accent)" : undefined,
                  }}
                />
              );
            })}
          </div>
        )}
      </div>

      <div style={CAPSULE_DIVIDER} />

      {BORDER_STYLES.map((b) => {
        const active = borderKey === b.value;
        return (
          <button
            key={b.value}
            type="button"
            title={t(b.labelKey)}
            onClick={() => setBorder(b.value)}
            style={{
              height: 24,
              padding: "0 8px",
              borderRadius: 12,
              border: "none",
              background: active ? "var(--conductor-accent)" : "transparent",
              color: active ? "#fff" : "rgba(255,255,255,0.85)",
              fontSize: 11,
              fontWeight: 500,
              cursor: "pointer",
              transition: "background var(--motion-duration-micro) var(--motion-smooth)",
            }}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.background = "rgba(255,255,255,0.1)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = active ? "var(--conductor-accent)" : "transparent";
            }}
          >
            {t(b.labelKey)}
          </button>
        );
      })}

      <div style={CAPSULE_DIVIDER} />

      <button
        type="button"
        title={t("conductor.toolbar.edit")}
        onClick={onEdit}
        style={CAPSULE_BTN_BASE}
        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.1)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <PencilIcon size={16} />
      </button>
      <button
        type="button"
        title={t("conductor.toolbar.delete")}
        onClick={onDelete}
        style={CAPSULE_BTN_BASE}
        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.1)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <TrashIcon size={16} />
      </button>
    </CapsuleToolbar>
  );
}

interface NativeChromeProps {
  element: CanvasElement;
  children: React.ReactNode;
  onPositionChange?: (id: string, position: CanvasPosition) => void;
}

export const NativeChrome: React.FC<NativeChromeProps> = ({ element, children, onPositionChange }) => {
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const selectedElementIds = useConductorStore((state) => state.selectedElementIds);
  const setSelectedElementId = useConductorStore((state) => state.setSelectedElementId);
  const editingElementId = useConductorStore((state) => state.editingElementId);
  const setEditingElementId = useConductorStore((state) => state.setEditingElementId);
  const updateElement = useConductorStore((state) => state.updateElement);
  const removeElement = useConductorStore((state) => state.removeElement);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);

  const isSelected = selectedElementId === element.id || selectedElementIds.includes(element.id);
  const isEditing = editingElementId === element.id;

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    removeElement(element.id);
    if (activeCanvasId) {
      executeAction({
        action: "element.delete",
        elementId: element.id,
        canvasId: activeCanvasId,
      }).catch(() => {});
    }
  }, [activeCanvasId, element.id, removeElement]);

  const resizeRef = useRef<{
    dir: HandleDirection;
    startMouseX: number;
    startMouseY: number;
    origW: number;
    origH: number;
    origX: number;
    origY: number;
    origZIndex: number;
    origRotation: number;
    resizeMode: string;
    rafId: number | null;
    lastMouseX: number;
    lastMouseY: number;
  } | null>(null);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedElementId(element.id);
  }, [element.id, setSelectedElementId]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingElementId(element.id);
  }, [element.id, setEditingElementId]);

  const handleResizeStart = useCallback((e: React.MouseEvent, dir: HandleDirection) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      dir,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      origW: element.position.w,
      origH: element.position.h,
      origX: element.position.x,
      origY: element.position.y,
      origZIndex: element.position.zIndex,
      origRotation: element.position.rotation ?? 0,
      resizeMode: (element.metadata?.resizeMode as string) ?? 'free',
      rafId: null,
      lastMouseX: e.clientX,
      lastMouseY: e.clientY,
    };
  }, [element.position, element.metadata]);

  useEffect(() => {
    const flushResizeFrame = () => {
      const r = resizeRef.current;
      if (!r) return;
      r.rafId = null;

      const zoom = canvasTransformState.zoom || 1;
      const dx = (r.lastMouseX - r.startMouseX) / zoom;
      const dy = (r.lastMouseY - r.startMouseY) / zoom;
      // Use float grid units for smooth live resize; snap on commit.
      const dw = dx / GRID_PX;
      const dh = dy / GRID_PX;

      let newW = r.origW;
      let newH = r.origH;
      let newX = r.origX;
      let newY = r.origY;

      switch (r.dir as HandleDirection | "n" | "e" | "s" | "w") {
        case "e":
          newW = Math.max(MIN_SIZE_GRID, r.origW + dw);
          break;
        case "w":
          newW = Math.max(MIN_SIZE_GRID, r.origW - dw);
          newX = r.origX + r.origW - newW;
          break;
        case "s":
          newH = Math.max(MIN_SIZE_GRID, r.origH + dh);
          break;
        case "n":
          newH = Math.max(MIN_SIZE_GRID, r.origH - dh);
          newY = r.origY + r.origH - newH;
          break;
        case "ne":
          newW = Math.max(MIN_SIZE_GRID, r.origW + dw);
          newH = Math.max(MIN_SIZE_GRID, r.origH - dh);
          newY = r.origY + r.origH - newH;
          break;
        case "nw":
          newW = Math.max(MIN_SIZE_GRID, r.origW - dw);
          newH = Math.max(MIN_SIZE_GRID, r.origH - dh);
          newX = r.origX + r.origW - newW;
          newY = r.origY + r.origH - newH;
          break;
        case "se":
          newW = Math.max(MIN_SIZE_GRID, r.origW + dw);
          newH = Math.max(MIN_SIZE_GRID, r.origH + dh);
          break;
        case "sw":
          newW = Math.max(MIN_SIZE_GRID, r.origW - dw);
          newH = Math.max(MIN_SIZE_GRID, r.origH + dh);
          newX = r.origX + r.origW - newW;
          break;
      }

      // Aspect-ratio lock for resizeMode='ratio' (Shift toggles free).
      const shiftHeld = (window.event as MouseEvent | null)?.shiftKey ?? false;
      if (r.resizeMode === 'ratio' && !shiftHeld && (r.dir === 'nw' || r.dir === 'ne' || r.dir === 'se' || r.dir === 'sw')) {
        const origRatio = r.origW / r.origH;
        const newRatio = newW / newH;
        if (Math.abs(newRatio - origRatio) > 0.001) {
          // Adjust the smaller dimension to preserve ratio.
          if (newW / origRatio <= newH) {
            newH = newW / origRatio;
          } else {
            newW = newH * origRatio;
          }
          // For nw/sw: y was computed from origH - newH; recompute.
          if (r.dir === 'nw' || r.dir === 'sw') {
            newY = r.origY + r.origH - newH;
          }
          // For nw/ne: x was computed from origW - newW; recompute.
          if (r.dir === 'nw' || r.dir === 'ne') {
            newX = r.origX + r.origW - newW;
          }
        }
      }

      updateElement(element.id, {
        position: {
          x: newX,
          y: newY,
          w: newW,
          h: newH,
          zIndex: r.origZIndex,
          rotation: r.origRotation,
        },
      });
    };

    const handleGlobalMouseMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      r.lastMouseX = e.clientX;
      r.lastMouseY = e.clientY;
      if (r.rafId === null) {
        r.rafId = window.requestAnimationFrame(flushResizeFrame);
      }
    };

    const handleGlobalMouseUp = () => {
      const r = resizeRef.current;
      if (!r) return;
      if (r.rafId !== null) {
        window.cancelAnimationFrame(r.rafId);
        flushResizeFrame();
      }
      // Snap final size/position to whole grid units on commit so the
      // layout stays tidy after a smooth live resize.
      const el = useConductorStore.getState().elements.find((e) => e.id === element.id);
      let finalPosition: CanvasPosition | undefined;
      if (el) {
        const snappedW = Math.max(MIN_SIZE_GRID, Math.round(el.position.w));
        const snappedH = Math.max(MIN_SIZE_GRID, Math.round(el.position.h));
        const snappedX = Math.round(el.position.x);
        const snappedY = Math.round(el.position.y);
        finalPosition = { ...el.position, x: snappedX, y: snappedY, w: snappedW, h: snappedH };
        updateElement(element.id, { position: finalPosition });
      }
      resizeRef.current = null;
      if (finalPosition) {
        onPositionChange?.(element.id, finalPosition);
      }
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [element.id, onPositionChange, updateElement]);

  const handleStyle: React.CSSProperties = {
    position: "absolute",
    width: 8,
    height: 8,
    background: "var(--canvas-bg, #fff)",
    border: "1px solid var(--conductor-accent)",
    borderRadius: 2,
    zIndex: 10,
    pointerEvents: "auto",
    boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
    transition: "transform var(--motion-duration-micro) var(--motion-spring)",
  };

  return (
    <div
      className="native-chrome"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        outline: isSelected ? "2px solid var(--conductor-accent)" : "none",
        outlineOffset: isSelected ? 2 : 0,
        borderRadius: "var(--radius-element)",
        cursor: isEditing ? "text" : "default",
        boxShadow: isSelected ? "0 0 0 4px var(--conductor-accent-soft)" : "none",
        transition: "outline var(--motion-duration-micro) var(--motion-smooth), box-shadow var(--motion-duration-micro) var(--motion-smooth)",
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {children}

      {isSelected && !isEditing && element.elementKind === "native/sticky" && (
        <StickySelectionToolbar
          element={element}
          onEdit={() => setEditingElementId(element.id)}
          onDelete={handleDelete}
        />
      )}

      {isSelected && !isEditing && element.elementKind === "native/text" && (
        <TextSelectionToolbar element={element} />
      )}

      {isSelected && !isEditing && element.metadata?.resizeMode !== 'fixed' && (
        <>
          <div
            data-resize-handle="nw"
            className="conductor-resize-handle nw"
            style={{ ...handleStyle, top: -4, left: -4, cursor: "nwse-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "nw")}
          />
          <div
            data-resize-handle="ne"
            className="conductor-resize-handle ne"
            style={{ ...handleStyle, top: -4, right: -4, cursor: "nesw-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "ne")}
          />
          <div
            data-resize-handle="se"
            className="conductor-resize-handle se"
            style={{ ...handleStyle, bottom: -4, right: -4, cursor: "nwse-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "se")}
          />
          <div
            data-resize-handle="sw"
            className="conductor-resize-handle sw"
            style={{ ...handleStyle, bottom: -4, left: -4, cursor: "nesw-resize" }}
            onMouseDown={(e) => handleResizeStart(e, "sw")}
          />
        </>
      )}
    </div>
  );
};
