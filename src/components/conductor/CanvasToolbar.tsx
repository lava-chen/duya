"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useConductorStore } from "@/stores/conductor-store";
import * as Icons from "@phosphor-icons/react";
import { ELEMENT_ICONS } from "./toolbar/element-icons";

type ToolId =
  | "select" | "text" | "sticky" | "shape"
  | "connector" | "mindmap" | "frame" | "section";

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
  { id: "mindmap", icon: ELEMENT_ICONS.mindmap, label: "Mind Map", shortcut: "M", group: 1 },
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

function createToolValue(type: string, extra?: Record<string, unknown>): string {
  const encoded = extra ? `:${encodeURIComponent(JSON.stringify(extra))}` : "";
  return `create:${type}${encoded}`;
}

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
    window.setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const baseClass = "absolute left-[62px] bg-[var(--sidebar-bg)]/96 backdrop-blur-md border border-[var(--border)] rounded-2xl py-1.5 min-w-[176px] z-[200] shadow-[0_18px_40px_rgba(0,0,0,0.24)]";

  if (toolId === "sticky") {
    return (
      <div ref={ref} className={baseClass} style={{ top: anchorY }}>
        <div className="flex gap-1.5 px-3 py-2.5">
          {STICKY_COLORS.map((c) => (
            <button
              key={c.color}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "copy";
                e.dataTransfer.setData("application/x-conductor-tool", "sticky");
                e.dataTransfer.setData("application/x-conductor-extra", JSON.stringify({ color: c.color }));
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                setStickyColor(c.color);
                onSelect("sticky", { color: c.color });
              }}
              className="w-[20px] h-[20px] rounded-[6px] transition-transform hover:scale-110 flex-shrink-0"
              style={{
                background: c.hex,
                outline: stickyColor === c.color ? "2px solid var(--accent)" : "none",
                outlineOffset: 1,
              }}
              aria-label={c.color}
            />
          ))}
        </div>
      </div>
    );
  }

  if (toolId === "shape") {
    return (
      <div ref={ref} className={baseClass} style={{ top: anchorY }}>
        {SHAPE_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.type}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "copy";
                e.dataTransfer.setData("application/x-conductor-tool", "shape");
                e.dataTransfer.setData("application/x-conductor-extra", JSON.stringify({ shapeType: item.type }));
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect("shape", { shapeType: item.type });
              }}
              className="flex items-center gap-2.5 w-full px-3.5 py-2 text-left text-[12px] text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors rounded-xl mx-1"
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
  }

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
      setPos({ top: rect.top + rect.height / 2, left: rect.right + 10 });
      setVisible(true);
    };
    const handleLeave = () => setVisible(false);

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
          <div className="px-3 py-1.5 rounded-lg bg-[var(--sidebar-bg)]/96 backdrop-blur-sm text-[var(--text)] text-xs whitespace-nowrap shadow-lg border border-[var(--border)] flex items-center gap-2">
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
          draggable={tool.id !== "connector" && tool.id !== "select"}
          onClick={(e) => onClick(tool, e)}
          onDragStart={(e) => {
            if (tool.id === "connector" || tool.id === "select") {
              e.preventDefault();
              return;
            }
            onDragStart(e, tool.id);
          }}
          className={`group relative flex items-center justify-center w-11 h-11 rounded-2xl transition-all duration-150 ${
            isActive || isSubmenuOpen
              ? "bg-[var(--surface-hover)] text-[var(--text)] shadow-[inset_0_0_0_1px_var(--accent),0_8px_18px_rgba(0,0,0,0.18)]"
              : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] hover:shadow-[inset_0_0_0_1px_var(--border)]"
          }`}
        >
          <div className="w-[21px] h-[21px]">{tool.icon}</div>
          {(isActive || isSubmenuOpen) && (
            <span className="absolute -right-0.5 top-1/2 -translate-y-1/2 h-4 w-[2.5px] rounded-full bg-[var(--accent)]" />
          )}
        </button>
      </ToolbarTooltip>
    </div>
  );
}

export function CanvasToolbar() {
  const activeTool = useConductorStore((s) => s.activeTool);
  const setActiveTool = useConductorStore((s) => s.setActiveTool);
  const editMode = useConductorStore((s) => s.editMode);
  const toggleEditMode = useConductorStore((s) => s.toggleEditMode);
  const toggleHistory = useConductorStore((s) => s.toggleHistory);

  const barRef = useRef<HTMLDivElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<ToolId | null>(null);
  const [submenuAnchorY, setSubmenuAnchorY] = useState(0);

  const handleDragStart = useCallback((e: React.DragEvent, toolId: string) => {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("application/x-conductor-tool", toolId);
  }, []);

  const handleSubmenuSelect = useCallback((type: string, extra?: Record<string, unknown>) => {
    setActiveTool(createToolValue(type, extra));
    setOpenSubmenu(null);
  }, [setActiveTool]);

  const handleClick = useCallback((tool: Tool, e: React.MouseEvent) => {
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

    setActiveTool(createToolValue(tool.id));
  }, [activeTool, setActiveTool]);

  const groups = TOOLS.reduce<Map<number, Tool[]>>((acc, tool) => {
    const group = acc.get(tool.group) || [];
    group.push(tool);
    acc.set(tool.group, group);
    return acc;
  }, new Map());

  return (
    <div
      ref={barRef}
      className="absolute left-0 top-1/2 -translate-y-1/2 z-20 select-none flex flex-col items-center gap-1.5 py-4 px-2.5 bg-[var(--sidebar-bg)]/92 backdrop-blur-lg border border-[var(--border)] rounded-r-[22px] shadow-[0_20px_50px_rgba(0,0,0,0.2)]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {Array.from(groups.entries()).map(([group, tools]) => (
        <div key={group} className="flex flex-col">
          {group > 0 && <div className="w-7 h-px bg-[var(--border)]/80 my-2.5 mx-auto" />}
          <div className="flex flex-col items-center gap-1.5">
            {tools.map((tool) => {
              const isActive = tool.id === "connector"
                ? activeTool === "connector"
                : activeTool === tool.id || Boolean(activeTool?.startsWith(`create:${tool.id}`));
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

      <div className="w-7 h-px bg-[var(--border)]/80 my-2.5" />

      <button
        type="button"
        onClick={toggleHistory}
        className="flex items-center justify-center w-11 h-11 rounded-2xl text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] hover:shadow-[inset_0_0_0_1px_var(--border)] transition-all duration-150"
        title="History"
      >
        <Icons.ClockCounterClockwise size={20} />
      </button>

      <div className="w-7 h-px bg-[var(--border)]/80 my-2.5" />

      <button
        type="button"
        onClick={toggleEditMode}
        className={`flex items-center justify-center w-11 h-11 rounded-2xl transition-all duration-150 ${
          editMode
            ? "bg-[var(--surface-hover)] text-[var(--text)] shadow-[inset_0_0_0_1px_var(--accent),0_8px_18px_rgba(0,0,0,0.18)]"
            : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] hover:shadow-[inset_0_0_0_1px_var(--border)]"
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
