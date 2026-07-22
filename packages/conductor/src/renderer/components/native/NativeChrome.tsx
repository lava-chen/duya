"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasElement, CanvasPosition } from "../..//types/conductor";
import { useConductorStore } from "../..//stores/conductor-store";
import { canvasTransformState } from "../CanvasArea";
import { GRID_PX } from "../../domain/canvas/units";
import { quantizeResizeDelta } from "../../domain/canvas/resize-snap";
import { PencilIcon, CaretDownIcon } from "@/components/icons";
import { createNativeElement, executeAction } from "../../ipc/conductor-ipc";
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
import {
  ElementUtilityActions,
  type ElementUtilityActionsProps,
} from "../toolbar/ElementUtilityActions";
import { FloatingCapsuleToolbar } from "../toolbar/FloatingCapsuleToolbar";
import { useElementLock } from "../toolbar/useElementLock";
import { getNativeElementCapabilities, type NativeElementCapabilities } from "./native-element-capabilities";

type HandleDirection = "nw" | "ne" | "se" | "sw" | "n" | "e" | "s" | "w";

// Screen-pixel target size. The canvas zoom is inverted at render time so
// handles remain easy to grab at both overview and detail zoom levels.
const HANDLE_SIZE = 12;
const MIN_SIZE_GRID = 1;
const DUPLICATE_OFFSET_GRID = 0.5;

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
  onDuplicate,
  onRotate,
  onBringToFront,
  onSendToBack,
  onDismiss,
  locked,
  onToggleLock,
}: {
  element: CanvasElement;
  onEdit: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onDuplicate: () => void;
  onRotate: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDismiss: () => void;
  locked: boolean;
  onToggleLock: () => void;
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
    <CapsuleToolbar positioned={false} zoomAware={false}>
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
            if (shape !== s.value) e.currentTarget.style.background = "var(--surface-hover)";
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
              border: "1px solid var(--command-menu-border)",
              display: "inline-block",
            }}
          />
          <CaretDownIcon size={10} color="var(--text-tertiary)" />
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
              background: "var(--command-menu-bg)",
              border: "1px solid var(--command-menu-border)",
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
                    border: active ? "2px solid var(--text-primary)" : "1px solid var(--command-menu-border)",
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
              whiteSpace: "nowrap",
              borderRadius: 12,
              border: "none",
              background: active ? "var(--canvas-tool-accent)" : "transparent",
              color: active ? "#fff" : "var(--text-primary)",
              fontSize: 11,
              fontWeight: 500,
              cursor: "pointer",
              transition: "background var(--motion-duration-micro) var(--motion-smooth)",
            }}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.background = "var(--surface-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = active ? "var(--canvas-tool-accent)" : "transparent";
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
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <PencilIcon size={16} />
      </button>
      <ElementUtilityActions
        onDuplicate={onDuplicate}
        onRotate={onRotate}
        onBringToFront={onBringToFront}
        onSendToBack={onSendToBack}
        onDismiss={onDismiss}
        onDelete={onDelete}
        deleteTitle={t("conductor.toolbar.delete")}
        locked={locked}
        onToggleLock={onToggleLock}
      />
    </CapsuleToolbar>
  );
}

type ShapePreset = "filled" | "outline" | "dashed";

const DEFAULT_SHAPE_COLOR = "#F4B566";
const SHAPE_COLORS = [
  "#FFFFFF", "#D9E1E8", "#A7B4C2", "#7E8B98",
  "#4EA4E6", "#8E83EC", "#AB60D5", "#CF69D1",
  "#55C4BD", "#75B5AC", "#C3B194", "#D99694",
  "#E77986", DEFAULT_SHAPE_COLOR, "#FFD262",
] as const;

function shapePresetConfig(preset: ShapePreset, color: string): Record<string, unknown> {
  return {
    shapePreset: preset,
    shapeColor: color,
    bgColor: preset === "filled" ? color : "transparent",
    borderStyle: {
      color,
      width: preset === "filled" ? 1 : 2,
      style: preset === "dashed" ? "dashed" : "solid",
    },
  };
}

const SHAPE_PRESET_KEY: Record<ShapePreset, TranslationKey> = {
  filled: "conductor.shape.filled",
  outline: "conductor.shape.outline",
  dashed: "conductor.shape.transparentDashed",
};

function ShapeSelectionToolbar({
  element,
  onEdit,
  onDelete,
  onDuplicate,
  onRotate,
  onBringToFront,
  onSendToBack,
  onDismiss,
  locked,
  onToggleLock,
}: {
  element: CanvasElement;
  onEdit: () => void;
  onDelete: (event: React.MouseEvent) => void;
  onDuplicate: () => void;
  onRotate: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDismiss: () => void;
  locked: boolean;
  onToggleLock: () => void;
}) {
  const { t } = useTranslation();
  const apply = useStyleUpdate(element);
  const activePreset = (element.config.shapePreset as ShapePreset | undefined) ?? "filled";
  const [colorOpen, setColorOpen] = useState(false);
  const colorMenuRef = useRef<HTMLDivElement>(null);
  const borderStyle = element.config.borderStyle as { color?: string } | undefined;
  const shapeColor = (element.config.shapeColor as string | undefined)
    ?? borderStyle?.color
    ?? (element.config.bgColor as string | undefined)
    ?? DEFAULT_SHAPE_COLOR;

  useEffect(() => {
    if (!colorOpen) return;
    const handleOutsidePress = (event: MouseEvent) => {
      if (!colorMenuRef.current?.contains(event.target as Node)) {
        setColorOpen(false);
      }
    };
    window.setTimeout(() => document.addEventListener("mousedown", handleOutsidePress), 0);
    return () => document.removeEventListener("mousedown", handleOutsidePress);
  }, [colorOpen]);

  return (
    <CapsuleToolbar positioned={false} zoomAware={false}>
      {(["filled", "outline", "dashed"] as ShapePreset[]).map((preset) => {
        const active = activePreset === preset;
        return (
          <button
            key={preset}
            type="button"
            title={t(SHAPE_PRESET_KEY[preset])}
            onClick={() => apply(shapePresetConfig(preset, shapeColor))}
            style={{ ...CAPSULE_BTN_BASE, ...(active ? CAPSULE_BTN_ACTIVE : {}) }}
          >
            <span
              style={{
                width: 16,
                height: 13,
                borderRadius: 3,
                border: `2px ${preset === "dashed" ? "dashed" : "solid"} ${active ? "#fff" : "var(--text-primary)"}`,
                background: preset === "filled" ? (active ? "#fff" : "#F4B566") : "transparent",
              }}
            />
          </button>
        );
      })}
      <div style={CAPSULE_DIVIDER} />
      <div style={{ position: "relative" }} ref={colorMenuRef}>
        <button
          type="button"
          title={t("conductor.shape.shapeColor")}
          aria-haspopup="menu"
          aria-expanded={colorOpen}
          onClick={() => setColorOpen((open) => !open)}
          style={{ ...CAPSULE_BTN_BASE, width: 30 }}
        >
          <span
            style={{
              width: 17,
              height: 17,
              borderRadius: "50%",
              background: shapeColor,
              border: "1px solid var(--command-menu-border)",
            }}
          />
        </button>
        {colorOpen && (
          <div
            role="menu"
            style={{
              position: "absolute",
              bottom: 36,
              left: "50%",
              transform: "translateX(-50%)",
              display: "grid",
              gridTemplateColumns: "repeat(4, 28px)",
              gap: 6,
              padding: 10,
              background: "var(--command-menu-bg)",
              border: "1px solid var(--command-menu-border)",
              borderRadius: 12,
              boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
              zIndex: 40,
            }}
          >
            {SHAPE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                title={color}
                onClick={() => {
                  apply(shapePresetConfig(activePreset, color));
                  setColorOpen(false);
                }}
                style={{
                  width: 28,
                  height: 28,
                  padding: 0,
                  borderRadius: "50%",
                  border: shapeColor === color ? "2px solid var(--text-primary)" : "1px solid var(--command-menu-border)",
                  background: color,
                  cursor: "pointer",
                  boxShadow: shapeColor === color ? "0 0 0 1px var(--canvas-tool-accent)" : undefined,
                }}
              />
            ))}
          </div>
        )}
      </div>
      <div style={CAPSULE_DIVIDER} />
      <button type="button" title={t("conductor.shape.editText")} onClick={onEdit} style={CAPSULE_BTN_BASE}><PencilIcon size={16} /></button>
      <ElementUtilityActions
        onDuplicate={onDuplicate}
        onRotate={onRotate}
        onBringToFront={onBringToFront}
        onSendToBack={onSendToBack}
        onDismiss={onDismiss}
        onDelete={onDelete}
        deleteTitle={t("conductor.shape.deleteShape")}
        locked={locked}
        onToggleLock={onToggleLock}
      />
    </CapsuleToolbar>
  );
}

interface NativeChromeProps {
  element: CanvasElement;
  capabilities?: NativeElementCapabilities;
  children: React.ReactNode;
  onPositionChange?: (id: string, position: CanvasPosition) => void;
}

export const NativeChrome: React.FC<NativeChromeProps> = ({ element, capabilities: declaredCapabilities, children, onPositionChange }) => {
  const capabilities = declaredCapabilities ?? getNativeElementCapabilities(element);
  const { locked, toggleLocked } = useElementLock(element);
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const selectedElementIds = useConductorStore((state) => state.selectedElementIds);
  const setSelectedElementId = useConductorStore((state) => state.setSelectedElementId);
  const editingElementId = useConductorStore((state) => state.editingElementId);
  const setEditingElementId = useConductorStore((state) => state.setEditingElementId);
  const updateElement = useConductorStore((state) => state.updateElement);
  const removeElement = useConductorStore((state) => state.removeElement);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const elements = useConductorStore((state) => state.elements);
  const setUiError = useConductorStore((state) => state.setUiError);
  const canvasZoom = useConductorStore((state) => state.canvasZoom);

  const isSelected = selectedElementIds.includes(element.id);
  const isEditing = editingElementId === element.id;
  const usesIntrinsicHeight = capabilities.resizeHandles === "horizontal";
  const isMultiSelect = selectedElementIds.length > 1;
  const isSingleSelected = isSelected && !isMultiSelect;
  // Element controls are intentionally exclusive to a single selection.
  // MultiSelectBar owns the bulk actions, so rendering one capsule and one
  // set of resize handles per selected element would create overlapping UI.
  const showSingleElementControls = isSingleSelected && !isEditing;
  const isDiagramShape = capabilities.selectionToolbar === "shape";
  const diagramShape = element.config.shape as string | undefined;
  const selectionRadius = isDiagramShape
    ? diagramShape === "ellipse"
      ? "50%"
      : diagramShape === "rounded"
        ? 12
        : 0
    : 6;

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

  const persistPosition = useCallback((position: CanvasPosition, failureLabel: string) => {
    updateElement(element.id, { position });
    if (!activeCanvasId) return;
    void executeAction({
      action: "element.update",
      elementId: element.id,
      canvasId: activeCanvasId,
      position,
    }).catch((error) => {
      setUiError(`${failureLabel}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [activeCanvasId, element.id, setUiError, updateElement]);

  const handleRotate = useCallback(() => {
    persistPosition({
      ...element.position,
      rotation: ((element.position.rotation ?? 0) + 90) % 360,
    }, "Rotate element failed");
  }, [element.position, persistPosition]);

  const handleLayerChange = useCallback((direction: "front" | "back") => {
    const zIndexes = elements.map((candidate) => candidate.position.zIndex);
    const nextZIndex = direction === "front"
      ? Math.max(...zIndexes, element.position.zIndex) + 1
      : Math.min(...zIndexes, element.position.zIndex) - 1;
    persistPosition({ ...element.position, zIndex: nextZIndex }, "Update element layer failed");
  }, [element.position, elements, persistPosition]);

  const handleDuplicate = useCallback(async () => {
    if (!activeCanvasId) return;
    const nodeType = element.elementKind.replace(/^native\//, "");
    try {
      const result = await createNativeElement(
        activeCanvasId,
        nodeType,
        {
          ...element.position,
          x: element.position.x + DUPLICATE_OFFSET_GRID,
          y: element.position.y + DUPLICATE_OFFSET_GRID,
          zIndex: Math.max(...elements.map((candidate) => candidate.position.zIndex), element.position.zIndex) + 1,
        },
        { ...element.config },
      );
      const duplicateId = (result as { resultPatch?: { element?: { id?: string } } } | undefined)
        ?.resultPatch?.element?.id;
      if (duplicateId) setSelectedElementId(duplicateId);
    } catch (error) {
      setUiError(`Duplicate element failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [activeCanvasId, element.config, element.elementKind, element.position, elements, setSelectedElementId, setUiError]);

  const dismissSelectionToolbar = useCallback(() => {
    setSelectedElementId(null);
  }, [setSelectedElementId]);

  const { t: translate } = useTranslation();

  const utilityActions: ElementUtilityActionsProps = {
    onDuplicate: handleDuplicate,
    onRotate: handleRotate,
    onBringToFront: () => handleLayerChange("front"),
    onSendToBack: () => handleLayerChange("back"),
    onDismiss: dismissSelectionToolbar,
    onDelete: handleDelete,
    deleteTitle: translate("conductor.toolbar.delete"),
    locked,
    onToggleLock: toggleLocked,
  };

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
  const [resizeDimensions, setResizeDimensions] = useState<{ w: number; h: number } | null>(null);

  // Ref to the outer chrome wrapper. The FloatingCapsuleToolbar portal
  // uses this to anchor its position above the element regardless of
  // the host element's z-index or canvas stacking context.
  const hostRef = useRef<HTMLDivElement | null>(null);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedElementId(element.id);
  }, [element.id, setSelectedElementId]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (capabilities.editMode === "none") return;
    setEditingElementId(element.id);
  }, [capabilities.editMode, element.id, setEditingElementId]);

  const handleResizeStart = useCallback((e: React.MouseEvent, dir: HandleDirection) => {
    if (locked) return;
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
    setResizeDimensions({
      w: Math.round(element.position.w * GRID_PX),
      h: Math.round(element.position.h * GRID_PX),
    });
  }, [element.position, element.metadata, locked]);

  useEffect(() => {
    const flushResizeFrame = () => {
      const r = resizeRef.current;
      if (!r) return;
      r.rafId = null;

      const zoom = canvasTransformState.zoom || 1;
      const dx = (r.lastMouseX - r.startMouseX) / zoom;
      const dy = (r.lastMouseY - r.startMouseY) / zoom;
      // Resize in half-grid steps. Continuous pixel updates made it too easy
      // to land on accidental sizes, while the previous release-time snap
      // caused a noticeable jump under the cursor.
      const dw = quantizeResizeDelta(dx / GRID_PX);
      const dh = quantizeResizeDelta(dy / GRID_PX);

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
      setResizeDimensions({
        w: Math.round(newW * GRID_PX),
        h: Math.round(newH * GRID_PX),
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
      // Values are already quantized while resizing. Keep the displayed
      // geometry on release rather than applying a second, larger snap.
      const el = useConductorStore.getState().elements.find((e) => e.id === element.id);
      let finalPosition: CanvasPosition | undefined;
      if (el) {
        finalPosition = { ...el.position };
        updateElement(element.id, { position: finalPosition });
      }
      resizeRef.current = null;
      setResizeDimensions(null);
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

  const effectiveZoom = canvasZoom > 0 ? canvasZoom : canvasTransformState.zoom || 1;
  const handleSize = HANDLE_SIZE / effectiveZoom;
  const handleOffset = handleSize / 2;
  const handleStyle: React.CSSProperties = {
    position: "absolute",
    width: handleSize,
    height: handleSize,
    boxSizing: "border-box",
    background: "var(--canvas-bg, #fff)",
    border: `${1 / effectiveZoom}px solid var(--canvas-tool-accent)`,
    borderRadius: 1 / effectiveZoom,
    zIndex: 10,
    pointerEvents: "auto",
    boxShadow: "none",
    transition: "transform var(--motion-duration-micro) var(--motion-spring)",
  };

  const showSelectionToolbar =
    showSingleElementControls
    && capabilities.selectionToolbar !== "none"
    && capabilities.selectionToolbar !== undefined;

  return (
    <div
      ref={hostRef}
      className="native-chrome"
      style={{
        position: "relative",
        width: "100%",
        height: usesIntrinsicHeight ? "fit-content" : "100%",
        // Tables draw their selection border on the grid itself. Their height is
        // determined by rows, rather than the stale freeform element rectangle.
        outline: isSelected && !usesIntrinsicHeight ? `${1.5 / effectiveZoom}px solid var(--canvas-tool-accent)` : "none",
        outlineOffset: 0,
        borderRadius: selectionRadius,
        cursor: isEditing && capabilities.editMode !== "database" ? "text" : "default",
        boxShadow: "none",
        transition: "outline var(--motion-duration-micro) var(--motion-smooth)",
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className="native-chrome__visual"
        data-native-element-visual
        style={{
          position: "absolute",
          inset: 0,
          transform: element.position.rotation
            ? `rotate(${element.position.rotation}deg)`
            : undefined,
          transformOrigin: "center",
        }}
      >
        {children}
      </div>

      {showSelectionToolbar && (
        <FloatingCapsuleToolbar hostRef={hostRef}>
          {capabilities.selectionToolbar === "shape" && (
            <ShapeSelectionToolbar
              element={element}
              onEdit={() => setEditingElementId(element.id)}
              onDelete={handleDelete}
              onDuplicate={handleDuplicate}
              onRotate={handleRotate}
              onBringToFront={() => handleLayerChange("front")}
              onSendToBack={() => handleLayerChange("back")}
              onDismiss={dismissSelectionToolbar}
              locked={locked}
              onToggleLock={toggleLocked}
            />
          )}

          {capabilities.selectionToolbar === "sticky" && (
            <StickySelectionToolbar
              element={element}
              onEdit={() => setEditingElementId(element.id)}
              onDelete={handleDelete}
              onDuplicate={handleDuplicate}
              onRotate={handleRotate}
              onBringToFront={() => handleLayerChange("front")}
              onSendToBack={() => handleLayerChange("back")}
              onDismiss={dismissSelectionToolbar}
              locked={locked}
              onToggleLock={toggleLocked}
            />
          )}

          {capabilities.selectionToolbar === "text" && (
            <TextSelectionToolbar element={element} utilityActions={utilityActions} />
          )}

          {capabilities.selectionToolbar === "utility" && (
            <CapsuleToolbar positioned={false} zoomAware={false}>
              <ElementUtilityActions
                {...utilityActions}
                leadingDivider={false}
                showDuplicate={false}
                showRotate={false}
              />
            </CapsuleToolbar>
          )}
        </FloatingCapsuleToolbar>
      )}

      {showSingleElementControls && !locked && capabilities.resizeHandles !== "none" && element.metadata?.resizeMode !== 'fixed' && (
        <>
          {usesIntrinsicHeight ? <>
            <div
              data-resize-handle="w"
              className="conductor-resize-handle w"
              style={{ ...handleStyle, top: "50%", left: -handleOffset, cursor: "ew-resize", transform: "translateY(-50%)" }}
              onMouseDown={(e) => handleResizeStart(e, "w")}
            />
            <div
              data-resize-handle="e"
              className="conductor-resize-handle e"
              style={{ ...handleStyle, top: "50%", right: -handleOffset, cursor: "ew-resize", transform: "translateY(-50%)" }}
              onMouseDown={(e) => handleResizeStart(e, "e")}
            />
          </> : <>
            <div
              data-resize-handle="nw"
              className="conductor-resize-handle nw"
              style={{ ...handleStyle, top: -handleOffset, left: -handleOffset, cursor: "nwse-resize" }}
              onMouseDown={(e) => handleResizeStart(e, "nw")}
            />
            <div
              data-resize-handle="ne"
              className="conductor-resize-handle ne"
              style={{ ...handleStyle, top: -handleOffset, right: -handleOffset, cursor: "nesw-resize" }}
              onMouseDown={(e) => handleResizeStart(e, "ne")}
            />
            <div
              data-resize-handle="se"
              className="conductor-resize-handle se"
              style={{ ...handleStyle, bottom: -handleOffset, right: -handleOffset, cursor: "nwse-resize" }}
              onMouseDown={(e) => handleResizeStart(e, "se")}
            />
            <div
              data-resize-handle="sw"
              className="conductor-resize-handle sw"
              style={{ ...handleStyle, bottom: -handleOffset, left: -handleOffset, cursor: "nesw-resize" }}
              onMouseDown={(e) => handleResizeStart(e, "sw")}
            />
          </>}
        </>
      )}

      {resizeDimensions && (
        <div
          aria-live="polite"
          style={{
            position: "absolute",
            right: -2 / (canvasTransformState.zoom || 1),
            bottom: -18 / (canvasTransformState.zoom || 1),
            zIndex: 20,
            padding: "1px 3px",
            borderRadius: 4,
            background: "transparent",
            color: "var(--canvas-tool-accent)",
            fontSize: 10,
            fontWeight: 600,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            transform: `scale(${1 / (canvasTransformState.zoom || 1)})`,
            transformOrigin: "top right",
          }}
        >
          {resizeDimensions.w} × {resizeDimensions.h}
        </div>
      )}
    </div>
  );
};
