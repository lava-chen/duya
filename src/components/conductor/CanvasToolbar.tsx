"use client";

import React, { useRef, useState, useEffect, useCallback } from "react";
import { useConductorStore } from "@/stores/conductor-store";
import { createNativeElement } from "@/lib/conductor-ipc";
import * as Icons from "@phosphor-icons/react";
import { ELEMENT_ICONS } from "./toolbar/element-icons";

type ToolId =
  | "select" | "text" | "sticky" | "shape"
  | "connector" | "frame" | "section";

interface Tool {
  id: ToolId;
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  hasSubmenu?: boolean;
  group: number;
}

const TOOLS: Tool[] = [
  { id: "select", icon: ELEMENT_ICONS.select, label: "Select", shortcut: "V", group: 0 },
  { id: "text", icon: ELEMENT_ICONS.text, label: "Text", shortcut: "T", group: 1 },
  { id: "sticky", icon: ELEMENT_ICONS.sticky, label: "Sticky note", shortcut: "N", group: 1, hasSubmenu: true },
  { id: "shape", icon: ELEMENT_ICONS.shape, label: "Shape", shortcut: "S", group: 1, hasSubmenu: true },
  { id: "connector", icon: ELEMENT_ICONS.connector, label: "Connector", shortcut: "C", group: 1 },
  { id: "frame", icon: ELEMENT_ICONS.frame, label: "Frame", shortcut: "F", group: 2 },
  { id: "section", icon: ELEMENT_ICONS.section, label: "Section", group: 2 },
];

const SHAPE_ITEMS = [
  { type: "rect", icon: Icons.Rectangle, label: "Rectangle", shortcut: "R" },
  { type: "circle", icon: Icons.Circle, label: "Ellipse", shortcut: "O" },
  { type: "diamond", icon: Icons.Diamond, label: "Diamond" },
  { type: "triangle", icon: Icons.Triangle, label: "Triangle" },
  { type: "capsule", icon: Icons.Pill, label: "Capsule" },
];

const STICKY_COLORS = [
  { color: "yellow", hex: "#FFF9C4" },
  { color: "blue", hex: "#BBDEFB" },
  { color: "green", hex: "#C8E6C9" },
  { color: "pink", hex: "#F8BBD0" },
  { color: "purple", hex: "#E1BEE7" },
  { color: "gray", hex: "#E0E0E0" },
];

interface SubmenuProps {
  toolId: ToolId;
  anchorY: number;
  onSelect: (type: string, extra?: Record<string, unknown>) => void;
  onClose: () => void;
}

function Submenu({ toolId, anchorY, onSelect, onClose }: SubmenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [stickyColor, setStickyColor] = useState("yellow");

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const baseClass = "absolute left-[52px] bg-[var(--sidebar-bg)] border border-[var(--border)] rounded-xl py-1 min-w-[156px] z-[200] shadow-2xl";

  if (toolId === "sticky") return (
    <div ref={ref} className={baseClass} style={{ top: anchorY }}>
      <div className="flex gap-1.5 px-3 py-2.5">
        {STICKY_COLORS.map((c) => (
          <button
            key={c.color}
            onMouseDown={(e) => {
              e.preventDefault();
              setStickyColor(c.color);
              onSelect("sticky", { color: c.color });
            }}
            className="w-[18px] h-[18px] rounded-[4px] transition-transform hover:scale-110 flex-shrink-0"
            style={{
              background: c.hex,
              outline: stickyColor === c.color ? "2px solid rgba(255,255,255,0.6)" : "none",
              outlineOffset: 1,
            }}
            aria-label={c.color}
          />
        ))}
      </div>
    </div>
  );

  if (toolId === "shape") return (
    <div ref={ref} className={baseClass} style={{ top: anchorY }}>
      {SHAPE_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.type}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect("shape", { shapeType: item.type });
            }}
            className="flex items-center gap-2.5 w-full px-3 py-1.5 text-left text-[12px] text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors"
          >
            <Icon size={14} className="text-[var(--muted)] flex-shrink-0" />
            <span className="flex-1">{item.label}</span>
            {item.shortcut && (
              <span className="text-[10px] text-[var(--muted)] font-mono">{item.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>
  );

  return null;
}

interface ToolbarTooltipProps {
  label: string;
  shortcut?: string;
  children: React.ReactElement<{ ref?: React.Ref<HTMLButtonElement> }>;
}

function ToolbarTooltip({ label, shortcut, children }: ToolbarTooltipProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const btn = buttonRef.current;
    if (!btn) return;

    const handleEnter = () => {
      const rect = btn.getBoundingClientRect();
      setPos({
        top: rect.top + rect.height / 2,
        left: rect.right + 10,
      });
      setVisible(true);
    };

    const handleLeave = () => {
      setVisible(false);
    };

    btn.addEventListener("mouseenter", handleEnter);
    btn.addEventListener("mouseleave", handleLeave);

    return () => {
      btn.removeEventListener("mouseenter", handleEnter);
      btn.removeEventListener("mouseleave", handleLeave);
    };
  }, []);

  return (
    <>
      {React.cloneElement(children, { ref: buttonRef })}
      {visible && (
        <div
          className="fixed z-[300] pointer-events-none"
          style={{ top: pos.top, left: pos.left, transform: "translateY(-50%)" }}
        >
          <div className="px-2.5 py-1.5 rounded-md bg-[var(--sidebar-bg)] text-[var(--text)] text-xs whitespace-nowrap shadow-xl border border-[var(--border)] flex items-center gap-2">
            <span>{label}</span>
            {shortcut && <span className="text-[var(--muted)] text-[10px] font-mono">{shortcut}</span>}
          </div>
        </div>
      )}
    </>
  );
}

interface ToolButtonProps {
  tool: Tool;
  isActive: boolean;
  isSubmenuOpen: boolean;
  onClick: (tool: Tool, e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent, toolId: string) => void;
}

function ToolButton({ tool, isActive, isSubmenuOpen, onClick, onDragStart }: ToolButtonProps) {
  return (
    <div className="relative">
      <ToolbarTooltip label={tool.label} shortcut={tool.shortcut}>
        <button
          type="button"
          draggable={!tool.hasSubmenu && tool.id !== "connector" && tool.id !== "select"}
          onClick={(e) => onClick(tool, e)}
          onDragStart={(e) => {
            if (tool.hasSubmenu || tool.id === "connector" || tool.id === "select") {
              e.preventDefault();
              return;
            }
            onDragStart(e, tool.id);
          }}
          className={`flex items-center justify-center w-10 h-10 rounded-xl transition-all ${
          isActive || isSubmenuOpen
            ? "bg-[var(--surface-hover)] text-[var(--text)] shadow-lg"
            : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        }`}
        >
          <div className="w-5 h-5">
            {tool.icon}
          </div>
        </button>
      </ToolbarTooltip>
    </div>
  );
}

export function CanvasToolbar() {
  const activeTool = useConductorStore((s) => s.activeTool);
  const setActiveTool = useConductorStore((s) => s.setActiveTool);
  const activeCanvasId = useConductorStore((s) => s.activeCanvasId);
  const setUiError = useConductorStore((s) => s.setUiError);
  const editMode = useConductorStore((s) => s.editMode);
  const toggleEditMode = useConductorStore((s) => s.toggleEditMode);
  const toggleHistory = useConductorStore((s) => s.toggleHistory);
  const canvasScrollX = useConductorStore((s) => s.canvasScrollX);
  const canvasScrollY = useConductorStore((s) => s.canvasScrollY);
  const canvasViewportW = useConductorStore((s) => s.canvasViewportW);
  const canvasViewportH = useConductorStore((s) => s.canvasViewportH);
  const canvasZoom = useConductorStore((s) => s.canvasZoom);

  const barRef = useRef<HTMLDivElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<ToolId | null>(null);
  const [submenuAnchorY, setSubmenuAnchorY] = useState(0);

  const handleDragStart = useCallback(
    (e: React.DragEvent, toolId: string) => {
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("application/x-conductor-tool", toolId);
    },
    []
  );

  const handleClick = useCallback(
    (tool: Tool, e: React.MouseEvent) => {
      if (tool.hasSubmenu) {
        if (barRef.current) {
          const btn = (e.currentTarget as HTMLElement).closest("button");
          if (btn) {
            const barTop = barRef.current.getBoundingClientRect().top;
            const btnTop = btn.getBoundingClientRect().top;
            setSubmenuAnchorY(btnTop - barTop);
          }
        }
        setOpenSubmenu((prev) => (prev === tool.id ? null : tool.id));
        return;
      }

      if (tool.id === "connector") {
        setActiveTool(activeTool === "connector" ? null : "connector");
        return;
      }

      if (tool.id === "select") {
        setActiveTool(null);
        return;
      }
    },
    [activeTool, setActiveTool]
  );

  const GRID_PX = 80;

  const NATIVE_DEFAULTS: Record<string, { w: number; h: number; zIndex: number }> = {
    text: { w: 4, h: 2, zIndex: 0 },
    sticky: { w: 3, h: 3, zIndex: 0 },
    shape: { w: 4, h: 3, zIndex: 0 },
    frame: { w: 8, h: 6, zIndex: 0 },
    section: { w: 6, h: 4, zIndex: -1 },
  };

  function getViewportCenter(
    scrollX: number, scrollY: number, vpW: number, vpH: number, zoom: number
  ): { cx: number; cy: number } | null {
    if (vpW <= 0 || vpH <= 0) return null;
    return {
      cx: (scrollX + vpW / 2) / zoom,
      cy: (scrollY + vpH / 2) / zoom,
    };
  }

  const handleSubmenuSelect = useCallback(
    (type: string, extra?: Record<string, unknown>) => {
      if (!activeCanvasId) {
        setOpenSubmenu(null);
        return;
      }
      const center = getViewportCenter(canvasScrollX, canvasScrollY, canvasViewportW, canvasViewportH, canvasZoom);
      if (!center) {
        setOpenSubmenu(null);
        return;
      }
      const defaults = NATIVE_DEFAULTS[type] || { w: 4, h: 3, zIndex: 0 };
      const pxW = defaults.w * GRID_PX;
      const pxH = defaults.h * GRID_PX;
      const position = {
        x: center.cx - pxW / 2,
        y: center.cy - pxH / 2,
        w: defaults.w,
        h: defaults.h,
        zIndex: defaults.zIndex,
        rotation: 0,
      };
      createNativeElement(activeCanvasId, type, position, extra || {})
        .then(() => {
          // success — store will pick up via bridge
        })
        .catch((err) => {
          setUiError(`Failed to create ${type}: ${err}`);
        });
      setOpenSubmenu(null);
    },
    [activeCanvasId, canvasScrollX, canvasScrollY, canvasViewportW, canvasViewportH, canvasZoom, setUiError]
  );

  const groups = TOOLS.reduce<Map<number, Tool[]>>((acc, tool) => {
    const g = acc.get(tool.group) || [];
    g.push(tool);
    acc.set(tool.group, g);
    return acc;
  }, new Map());

  return (
    <div
      ref={barRef}
      className="absolute left-4 top-1/2 -translate-y-1/2 z-20 select-none flex flex-col items-center gap-1 py-3 px-2 bg-[var(--sidebar-bg)] border border-[var(--border)] rounded-2xl shadow-2xl"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {Array.from(groups.entries()).map(([group, tools]) => (
        <div key={group} className="flex flex-col">
          {group > 0 && <div className="w-6 h-px bg-[var(--border)] my-2 mx-auto" />}
          <div className="flex flex-col items-center gap-1">
            {tools.map((tool) => {
              const isActive =
                tool.id === "connector"
                  ? activeTool === "connector"
                  : tool.id === activeTool;
              const isSubmenuOpen = openSubmenu === tool.id;

              return (
                <ToolButton
                  key={tool.id}
                  tool={tool}
                  isActive={isActive}
                  isSubmenuOpen={isSubmenuOpen}
                  onClick={handleClick}
                  onDragStart={handleDragStart}
                />
              );
            })}
          </div>
        </div>
      ))}

      <div className="w-6 h-px bg-[var(--border)] my-2" />

      <button
        type="button"
        onClick={toggleHistory}
        className="flex items-center justify-center w-10 h-10 rounded-xl text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-all"
        title="History"
      >
        <Icons.ClockCounterClockwise size={20} />
      </button>

      <div className="w-6 h-px bg-[var(--border)] my-2" />

      <button
        type="button"
        onClick={toggleEditMode}
        className={`flex items-center justify-center w-10 h-10 rounded-xl transition-all ${
          editMode
            ? "bg-[var(--surface-hover)] text-[var(--text)] shadow-lg"
            : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        }`}
        title={editMode ? "View mode" : "Edit mode"}
      >
        {editMode ? <Icons.PencilSimple size={20} /> : <Icons.Eye size={20} />}
      </button>

      {openSubmenu && (
        <Submenu
          toolId={openSubmenu}
          anchorY={submenuAnchorY}
          onSelect={handleSubmenuSelect}
          onClose={() => setOpenSubmenu(null)}
        />
      )}
    </div>
  );
}
