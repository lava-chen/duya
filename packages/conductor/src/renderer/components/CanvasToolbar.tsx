"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useConductorStore } from "..//stores/conductor-store";
import { ELEMENT_ICONS } from "./toolbar/element-icons";
import { uploadAsset } from "..//ipc/conductor-ipc";
import { STICKY_COLORS, STICKY_COLOR_KEYS } from "./native/sticky-colors";

type ToolId =
  | "select" | "sticky"
  | "connector" | "media";

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
  { id: "sticky", icon: ELEMENT_ICONS.sticky, label: "Sticky note", shortcut: "N", group: 1, hasSubmenu: true },
  { id: "connector", icon: ELEMENT_ICONS.connector, label: "Connector", shortcut: "C", group: 1 },
  { id: "media", icon: ELEMENT_ICONS.media, label: "Media", shortcut: "M", group: 1 },
];

// Sticky color palette — derived from the shared module so the toolbar preview
// swatch matches the rendered sticky color exactly.
const STICKY_COLORS_LIST: { color: string; hex: string }[] = STICKY_COLOR_KEYS.map(
  (key) => ({ color: key, hex: STICKY_COLORS[key].bg }),
);

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

  const baseClass = "absolute left-[62px] conductor-popover py-1.5 min-w-[176px] z-[200]";

  if (toolId === "sticky") {
    return (
      <div ref={ref} className={baseClass} style={{ top: anchorY }}>
        <div className="flex gap-1.5 px-3 py-2.5">
          {STICKY_COLORS_LIST.map((c) => (
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
          <div className="conductor-tooltip flex items-center gap-2">
            <span>{label}</span>
            {shortcut && <span style={{ color: "var(--text-tertiary)", fontSize: 11, fontFamily: "'Fira Mono', monospace" }}>{shortcut}</span>}
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
          draggable={tool.id !== "connector" && tool.id !== "select" && tool.id !== "media"}
          onClick={(e) => onClick(tool, e)}
          onDragStart={(e) => {
            if (tool.id === "connector" || tool.id === "select" || tool.id === "media") {
              e.preventDefault();
              return;
            }
            onDragStart(e, tool.id);
          }}
          className={`conductor-tool-button ${isActive || isSubmenuOpen ? "active" : ""}`}
        >
          <div className="w-[21px] h-[21px]">{tool.icon}</div>
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

  const barRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  const handleMediaFile = useCallback(async (file: File) => {
    if (!activeCanvasId) return;
    try {
      const asset = await uploadAsset(activeCanvasId, file);
      const extra: Record<string, unknown> = {
        assetId: asset.assetId,
        url: asset.url,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        size: asset.size,
      };
      setActiveTool(createToolValue(asset.kind, extra));
    } catch (err) {
      setUiError(`Upload media failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [activeCanvasId, setActiveTool, setUiError]);

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

    if (tool.id === "media") {
      fileInputRef.current?.click();
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
      className="absolute left-0 top-1/2 -translate-y-1/2 z-20 select-none flex flex-col items-center gap-1.5 py-4 px-2.5 conductor-panel"
      style={{ borderRadius: "0 var(--radius-panel) var(--radius-panel) 0", borderLeft: "none" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {Array.from(groups.entries()).map(([group, tools]) => (
        <div key={group} className="flex flex-col">
          {group > 0 && <div className="w-7 h-px my-2.5 mx-auto" style={{ background: "var(--conductor-border)" }} />}
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

      {openSubmenu && (
        <Submenu
          toolId={openSubmenu}
          anchorY={submenuAnchorY}
          onSelect={handleSubmenuSelect}
          onClose={() => setOpenSubmenu(null)}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf,.pdf,.doc,.docx,.txt,.md"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            void handleMediaFile(file);
          }
          e.target.value = "";
        }}
      />
    </div>
  );
}
