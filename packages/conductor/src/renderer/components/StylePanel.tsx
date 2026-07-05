"use client";

import React, { useMemo } from "react";
import type { CanvasElement } from "../types/conductor";
import { useConductorStore } from "../stores/conductor-store";
import { updateElementContent } from "../ipc/conductor-ipc";
import { STICKY_COLORS, STICKY_COLOR_KEYS } from "./native/sticky-colors";
import { GRID_PX } from "../domain/canvas/units";
const PANEL_WIDTH = 320;
// Height reserved for the StylePanel when visible. ObjectAgentPrompt adds this
// to its vertical offset so the two panels stack without overlapping.
// Sized to fit the tallest variant (connector: 4 rows).
export const STYLE_PANEL_HEIGHT = 130;
// Vertical gap between the element's bottom edge and the StylePanel.
const STYLE_PANEL_OFFSET = 14;
// Vertical gap between StylePanel and ObjectAgentPrompt.
export const STYLE_PANEL_STACK_GAP = 8;

// Sticky color palette — derived from the shared module so this stays in sync
// with StickyElement.tsx and CanvasToolbar.tsx.
const STICKY_COLOR_SWATCHES: { key: string; hex: string }[] = STICKY_COLOR_KEYS.map(
  (key) => ({ key, hex: STICKY_COLORS[key].bg }),
);

// Connector / group color palette.
const NEUTRAL_COLOR_SWATCHES: { key: string; hex: string }[] = [
  { key: "#1F2937", hex: "#1F2937" }, // near-black
  { key: "#6B7280", hex: "#6B7280" }, // gray
  { key: "#EF4444", hex: "#EF4444" }, // red
  { key: "#3B82F6", hex: "#3B82F6" }, // blue
  { key: "#10B981", hex: "#10B981" }, // green
  { key: "#F59E0B", hex: "#F59E0B" }, // orange
];

const SHAPES: { value: "rect" | "diamond" | "ellipse"; label: string }[] = [
  { value: "rect", label: "Rect" },
  { value: "diamond", label: "Diamond" },
  { value: "ellipse", label: "Ellipse" },
];

const BORDER_STYLES: { value: "none" | "solid" | "dashed" | "dotted"; label: string }[] = [
  { value: "none", label: "None" },
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];

const STROKE_STYLES: { value: "solid" | "dashed" | "dotted"; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];

const LINE_WIDTHS: number[] = [1, 2, 4];

/**
 * Returns true when the StylePanel should render for the given element kind.
 * Exported so ObjectAgentPrompt can decide whether to push itself down.
 */
export function isStylePanelKind(kind: string | undefined): boolean {
  return kind === "native/sticky" || kind === "native/connector" || kind === "native/group";
}

export function StylePanel() {
  const elements = useConductorStore((state) => state.elements);
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const selectedElementIds = useConductorStore((state) => state.selectedElementIds);
  const canvasScrollX = useConductorStore((state) => state.canvasScrollX);
  const canvasScrollY = useConductorStore((state) => state.canvasScrollY);
  const canvasViewportW = useConductorStore((state) => state.canvasViewportW);
  const canvasZoom = useConductorStore((state) => state.canvasZoom);

  const selectedElements = useMemo(() => {
    const ids =
      selectedElementIds.length > 0
        ? selectedElementIds
        : selectedElementId
          ? [selectedElementId]
          : [];
    const idSet = new Set(ids);
    return elements.filter((el) => idSet.has(el.id));
  }, [elements, selectedElementId, selectedElementIds]);

  const single = selectedElements.length === 1 ? selectedElements[0] : null;
  const kind = single?.elementKind;
  const isStyleable = isStylePanelKind(kind);

  const position = useMemo(() => {
    if (!single || !isStyleable) return null;
    const zoom = canvasZoom > 0 ? canvasZoom : 1;
    const widthPx = single.position.w * GRID_PX * zoom;
    const left = canvasScrollX + single.position.x * GRID_PX * zoom + widthPx / 2;
    const top =
      canvasScrollY + (single.position.y * GRID_PX + single.position.h * GRID_PX) * zoom + STYLE_PANEL_OFFSET;
    const clampedLeft = Math.max(
      16,
      Math.min(left - PANEL_WIDTH / 2, Math.max(16, canvasViewportW - PANEL_WIDTH - 16)),
    );
    return { left: clampedLeft, top: Math.max(56, top) };
  }, [canvasScrollX, canvasScrollY, canvasViewportW, canvasZoom, single, isStyleable]);

  if (!single || !isStyleable || !position) return null;

  return (
    <div
      className="absolute z-[44] pointer-events-auto"
      style={{ left: position.left, top: position.top, width: PANEL_WIDTH }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="conductor-style-panel flex flex-col gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--sidebar-bg)] px-2 py-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.32)]">
        {kind === "native/sticky" && <StickyStyleChips element={single} />}
        {kind === "native/connector" && <ConnectorStyleChips element={single} />}
        {kind === "native/group" && <GroupStyleChips element={single} />}
      </div>
    </div>
  );
}

// ---- shared primitives ----

interface ChipProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}

function Chip({ active, onClick, children, title }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex h-6 items-center justify-center rounded px-2 text-[11px] font-medium transition-colors ${
        active
          ? "bg-[var(--conductor-accent)] text-white"
          : "bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-hover)]"
      }`}
    >
      {children}
    </button>
  );
}

interface SwatchProps {
  color: string;
  active: boolean;
  onClick: () => void;
  title?: string;
}

function Swatch({ color, active, onClick, title }: SwatchProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`h-5 w-5 flex-shrink-0 rounded-full border transition-transform hover:scale-110 ${
        active
          ? "border-[var(--conductor-accent)] ring-2 ring-[var(--conductor-accent)]"
          : "border-[var(--border)]"
      }`}
      style={{ backgroundColor: color }}
    />
  );
}

interface ColorRowProps {
  label: string;
  swatches: { key: string; hex: string }[];
  current?: string;
  onPick: (hex: string) => void;
}

function ColorRow({ label, swatches, current, onPick }: ColorRowProps) {
  const inputColor = current && /^#[0-9a-fA-F]{6}$/.test(current) ? current : "#000000";
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-12 flex-shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</span>
      <div className="flex flex-wrap items-center gap-1">
        {swatches.map((sw) => (
          <Swatch
            key={sw.key}
            color={sw.hex}
            active={current === sw.hex}
            onClick={() => onPick(sw.hex)}
            title={sw.key}
          />
        ))}
        <label
          className="relative h-5 w-5 flex-shrink-0 cursor-pointer overflow-hidden rounded-full border border-[var(--border)] transition-transform hover:scale-110"
          title="Custom color"
        >
          <span
            className="absolute inset-0"
            style={{ background: "conic-gradient(from 0deg, red, yellow, lime, cyan, blue, magenta, red)" }}
          />
          <input
            type="color"
            value={inputColor}
            onChange={(e) => onPick(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      </div>
    </div>
  );
}

/**
 * Returns a memoized `apply(patch)` function that optimistically updates the
 * element config in the store and persists the merge-patch via IPC.
 * Mirrors the save pattern in StickyElement.tsx.
 */
function useStyleUpdate(element: CanvasElement) {
  const updateElement = useConductorStore((state) => state.updateElement);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const setUiError = useConductorStore((state) => state.setUiError);

  return useMemo(() => {
    const apply = (patch: Record<string, unknown>) => {
      const newConfig = { ...element.config, ...patch };
      updateElement(element.id, { config: newConfig });
      if (activeCanvasId) {
        updateElementContent(element.id, activeCanvasId, patch).catch((err) => {
          setUiError(`Update style failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    };
    return apply;
  }, [element.config, element.id, updateElement, activeCanvasId, setUiError]);
}

// ---- sticky ----

function StickyStyleChips({ element }: { element: CanvasElement }) {
  const apply = useStyleUpdate(element);

  const shape = (element.config.shape as "rect" | "diamond" | "ellipse" | undefined) || "rect";
  const bgColor = element.config.bgColor as string | undefined;
  const borderStyleCfg = element.config.borderStyle as
    | { color?: string; width?: number; style?: "solid" | "dashed" | "dotted" }
    | undefined;
  const borderStyleKey: "none" | "solid" | "dashed" | "dotted" =
    !borderStyleCfg || !borderStyleCfg.width ? "none" : borderStyleCfg.style ?? "solid";

  // Swatches use STICKY_COLOR hexes; current is bgColor if set, else fall back
  // to the legacy color key's hex so the active swatch reflects the visible bg.
  const legacyColorKey = (element.config.color as string | undefined) || "yellow";
  const legacyHex =
    STICKY_COLOR_SWATCHES.find((s) => s.key === legacyColorKey)?.hex ?? STICKY_COLOR_SWATCHES[0].hex;
  const currentBg = bgColor ?? legacyHex;

  const setShape = (value: "rect" | "diamond" | "ellipse") => apply({ shape: value });
  const setBgColor = (hex: string) => apply({ bgColor: hex });
  const setBorderStyle = (value: "none" | "solid" | "dashed" | "dotted") => {
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

  return (
    <>
      <div className="flex items-center gap-1.5">
        <span className="w-12 flex-shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">Shape</span>
        <div className="flex gap-1">
          {SHAPES.map((s) => (
            <Chip key={s.value} active={shape === s.value} onClick={() => setShape(s.value)} title={s.label}>
              {s.label}
            </Chip>
          ))}
        </div>
      </div>
      <ColorRow label="Fill" swatches={STICKY_COLOR_SWATCHES} current={currentBg} onPick={setBgColor} />
      <div className="flex items-center gap-1.5">
        <span className="w-12 flex-shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">Border</span>
        <div className="flex gap-1">
          {BORDER_STYLES.map((b) => (
            <Chip key={b.value} active={borderStyleKey === b.value} onClick={() => setBorderStyle(b.value)} title={b.label}>
              {b.label}
            </Chip>
          ))}
        </div>
      </div>
    </>
  );
}

// ---- connector ----

function ConnectorStyleChips({ element }: { element: CanvasElement }) {
  const apply = useStyleUpdate(element);

  const strokeStyle = (element.config.strokeStyle as "solid" | "dashed" | "dotted" | undefined) || "solid";
  const lineWidth = Number(element.config.lineWidth ?? 2);
  const color = (element.config.color as string | undefined) || "#6B7280";
  const arrowStart = (element.config.arrowStart as boolean) || false;
  const arrowEnd = element.config.arrowEnd as boolean | undefined;
  const arrowEndResolved = arrowEnd ?? true;

  const setStrokeStyle = (value: "solid" | "dashed" | "dotted") => apply({ strokeStyle: value });
  const setLineWidth = (value: number) => apply({ lineWidth: value });
  const setColor = (hex: string) => apply({ color: hex });
  const toggleArrowStart = () => apply({ arrowStart: !arrowStart });
  const toggleArrowEnd = () => apply({ arrowEnd: !arrowEndResolved });

  return (
    <>
      <div className="flex items-center gap-1.5">
        <span className="w-12 flex-shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">Stroke</span>
        <div className="flex gap-1">
          {STROKE_STYLES.map((s) => (
            <Chip key={s.value} active={strokeStyle === s.value} onClick={() => setStrokeStyle(s.value)} title={s.label}>
              {s.label}
            </Chip>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-12 flex-shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">Width</span>
        <div className="flex gap-1">
          {LINE_WIDTHS.map((w) => (
            <Chip key={w} active={lineWidth === w} onClick={() => setLineWidth(w)} title={`${w}px`}>
              {w}
            </Chip>
          ))}
        </div>
      </div>
      <ColorRow label="Color" swatches={NEUTRAL_COLOR_SWATCHES} current={color} onPick={setColor} />
      <div className="flex items-center gap-1.5">
        <span className="w-12 flex-shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">Arrows</span>
        <div className="flex gap-1">
          <Chip active={arrowStart} onClick={toggleArrowStart} title="Toggle start arrow">Start</Chip>
          <Chip active={arrowEndResolved} onClick={toggleArrowEnd} title="Toggle end arrow">End</Chip>
        </div>
      </div>
    </>
  );
}

// ---- group ----

function GroupStyleChips({ element }: { element: CanvasElement }) {
  const apply = useStyleUpdate(element);
  const updateElement = useConductorStore((state) => state.updateElement);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const setUiError = useConductorStore((state) => state.setUiError);

  const title = (element.config.title as string | undefined) ?? "";
  const bgColor = element.config.bgColor as string | undefined;

  // Title is optimistically updated in the store on every keystroke, and
  // persisted via IPC on blur (or Enter) to avoid one IPC call per char.
  const setTitle = (value: string) => {
    updateElement(element.id, { config: { ...element.config, title: value } });
  };
  const persistTitle = (value: string) => {
    if (!activeCanvasId) return;
    updateElementContent(element.id, activeCanvasId, { title: value }).catch((err) => {
      setUiError(`Update group title failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const setBgColor = (hex: string) => apply({ bgColor: hex });

  return (
    <>
      <div className="flex items-center gap-1.5">
        <span className="w-12 flex-shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={(e) => persistTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
          placeholder="Group title"
          className="min-w-0 flex-1 rounded bg-[var(--surface)] px-1.5 py-0.5 text-[11px] text-[var(--text)] outline-none placeholder:text-[var(--muted)] focus:bg-[var(--surface-hover)]"
        />
      </div>
      <ColorRow label="Fill" swatches={NEUTRAL_COLOR_SWATCHES} current={bgColor} onPick={setBgColor} />
    </>
  );
}
