"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useConductorStore } from "..//stores/conductor-store";
import { ELEMENT_ICONS } from "./toolbar/element-icons";
import { uploadAsset } from "..//ipc/conductor-ipc";
import { LinkCreateDialog } from "./LinkCreateDialog";
import { DocumentCreateDialog } from "./DocumentCreateDialog";
import type { LinkContent } from "..//types/canvas-node";
import {
  ArrowElbowDownRight,
  BezierCurve,
  Circle,
  Diamond,
  Hexagon,
  Parallelogram,
  Rectangle,
  Triangle,
  X,
} from "@phosphor-icons/react";

type ToolId =
  | "select" | "hand" | "document" | "shape"
  | "connector" | "media" | "link" | "text" | "table";

interface Tool {
  id: ToolId;
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  hasSubmenu?: boolean;
  group: number;
}

const TOOLS: Tool[] = [
  { id: "select", icon: ELEMENT_ICONS.select, label: "Arrow", shortcut: "V", group: 0 },
  { id: "hand", icon: ELEMENT_ICONS.hand, label: "Drag canvas", shortcut: "H", group: 0 },
  { id: "document", icon: ELEMENT_ICONS.document, label: "Markdown document", shortcut: "D", group: 1 },
  { id: "shape", icon: ELEMENT_ICONS.shape, label: "Diagram shapes", shortcut: "S", group: 1, hasSubmenu: true },
  { id: "text", icon: ELEMENT_ICONS.text, label: "Text", shortcut: "T", group: 1 },
  { id: "table", icon: ELEMENT_ICONS.table, label: "Table", group: 1 },
  { id: "connector", icon: ELEMENT_ICONS.connector, label: "Connector", shortcut: "C", group: 1, hasSubmenu: true },
  { id: "media", icon: ELEMENT_ICONS.media, label: "Media", shortcut: "M", group: 1 },
  { id: "link", icon: ELEMENT_ICONS.link, label: "Link", shortcut: "L", group: 1 },
];

type DiagramShape = "rect" | "rounded" | "ellipse" | "diamond" | "parallelogram" | "triangle" | "hexagon";

const DIAGRAM_SHAPES: { shape: DiagramShape; label: string; icon: React.ReactNode }[] = [
  { shape: "rect", label: "Rectangle", icon: <Rectangle size={21} weight="regular" /> },
  { shape: "rounded", label: "Rounded rectangle", icon: <Rectangle size={21} weight="regular" /> },
  { shape: "ellipse", label: "Ellipse", icon: <Circle size={21} weight="regular" /> },
  { shape: "diamond", label: "Diamond", icon: <Diamond size={21} weight="regular" /> },
  { shape: "parallelogram", label: "Parallelogram", icon: <Parallelogram size={21} weight="regular" /> },
  { shape: "triangle", label: "Triangle", icon: <Triangle size={21} weight="regular" /> },
  { shape: "hexagon", label: "Hexagon", icon: <Hexagon size={21} weight="regular" /> },
];

function diagramShapeConfig(shape: DiagramShape): Record<string, unknown> {
  return {
    presentation: "shape",
    shape,
    shapePreset: "filled",
    color: "yellow",
    bgColor: "#F4B566",
    borderStyle: { color: "#E98436", width: 1, style: "solid" },
  };
}

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

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const baseClass = "absolute left-[62px] conductor-popover py-1.5 min-w-[176px] z-[200]";

  if (toolId === "shape") {
    return (
      <div
        ref={ref}
        className="absolute left-[62px] z-[200] flex w-12 flex-col items-center gap-1 rounded-[14px] border border-[var(--command-menu-border)] bg-[var(--command-menu-bg)] px-1.5 py-1.5"
        style={{ top: anchorY - 4 }}
      >
        <button
          type="button"
          aria-label="Close shape palette"
          title="Close"
          onClick={onClose}
          className="conductor-tool-button flex h-8 w-8 items-center justify-center rounded-[9px] text-[var(--text)]"
        >
          <X size={18} weight="regular" />
        </button>
        <div className="canvas-toolbar__divider w-full" />
        {DIAGRAM_SHAPES.map((item) => (
          <button
            key={item.shape}
            type="button"
            aria-label={item.label}
            title={item.label}
            onClick={() => onSelect("shape", diagramShapeConfig(item.shape))}
            className="conductor-tool-button flex h-8 w-8 items-center justify-center rounded-[9px] text-[var(--text)]"
          >
            {item.icon}
          </button>
        ))}
      </div>
    );
  }

  if (toolId === "connector") {
    return (
      <div ref={ref} className={baseClass} style={{ top: anchorY }}>
        <button
          type="button"
          onClick={() => onSelect("connector", { routingMode: "elbow" })}
          className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs text-[var(--text)] hover:bg-[var(--surface-hover)]"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--conductor-accent-soft)] text-[var(--conductor-accent)]"><ArrowElbowDownRight size={17} weight="bold" /></span>
          <span><strong className="block font-semibold">Elbow</strong><span className="text-[10px] text-[var(--muted)]">Orthogonal, rounded corners</span></span>
        </button>
        <button
          type="button"
          onClick={() => onSelect("connector", { routingMode: "curve" })}
          className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs text-[var(--text)] hover:bg-[var(--surface-hover)]"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--conductor-accent-soft)] text-[var(--conductor-accent)]"><BezierCurve size={17} weight="bold" /></span>
          <span><strong className="block font-semibold">Curve</strong><span className="text-[10px] text-[var(--muted)]">Editable Bézier handles</span></span>
        </button>
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

function isNonDraggableTool(id: ToolId): boolean {
  return id === "select" || id === "hand" || id === "document" || id === "shape" || id === "connector" || id === "media" || id === "link";
}

// `text` is draggable: drag from toolbar to canvas creates the
// element at the drop position. Click + click-on-canvas also works via the
// default `create:text` activeTool flow.

function ToolButton({ tool, isActive, isSubmenuOpen, onClick, onDragStart }: ToolButtonProps) {
  const nonDraggable = isNonDraggableTool(tool.id);
  return (
    <div className="relative">
      <ToolbarTooltip label={tool.label} shortcut={tool.shortcut}>
        <button
          type="button"
          draggable={!nonDraggable}
          onClick={(e) => onClick(tool, e)}
          onDragStart={(e) => {
            if (nonDraggable) {
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
  const activeCanvas = useConductorStore((s) => s.canvases.find((canvas) => canvas.id === s.activeCanvasId));
  const setUiError = useConductorStore((s) => s.setUiError);

  const barRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<ToolId | null>(null);
  const [submenuAnchorY, setSubmenuAnchorY] = useState(0);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [documentDialogOpen, setDocumentDialogOpen] = useState(false);

  const handleDragStart = useCallback((e: React.DragEvent, toolId: string) => {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("application/x-conductor-tool", toolId);
  }, []);

  const handleSubmenuSelect = useCallback((type: string, extra?: Record<string, unknown>) => {
    if (type === "connector") {
      const routingMode = extra?.routingMode === "curve" ? "curve" : "elbow";
      setActiveTool(`connector:${routingMode}`);
    } else {
      setActiveTool(createToolValue(type, extra));
    }
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

  const startCreateLink = useCallback((content: LinkContent) => {
    setActiveTool(createToolValue("link", content as unknown as Record<string, unknown>));
  }, [setActiveTool]);

  const startCreateDocument = useCallback((content?: Record<string, unknown>) => {
    if (!activeCanvas?.projectPath) {
      setUiError("Choose a project folder when creating this canvas before adding Markdown files.");
      return;
    }
    setActiveTool(createToolValue("document", content));
    setDocumentDialogOpen(false);
  }, [activeCanvas?.projectPath, setActiveTool, setUiError]);

  const handleClick = useCallback((tool: Tool, e: React.MouseEvent) => {
    if (tool.id === "document") {
      setDocumentDialogOpen(true);
      return;
    }

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

    if (tool.id === "media") {
      fileInputRef.current?.click();
      return;
    }

    if (tool.id === "link") {
      setLinkDialogOpen(true);
      return;
    }

    if (tool.id === "select") {
      setActiveTool(null);
      return;
    }

    if (tool.id === "hand") {
      setActiveTool("pan");
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
      className="canvas-toolbar absolute left-3 top-1/2 -translate-y-1/2 z-20 select-none flex flex-col items-center gap-1.5 py-3 px-2 conductor-panel"
      style={{ borderRadius: 22 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {Array.from(groups.entries()).map(([group, tools]) => (
        <div key={group} className="canvas-toolbar__group flex flex-col">
          {group > 0 && <div className="canvas-toolbar__divider" />}
          <div className="canvas-toolbar__tools flex flex-col items-center gap-1.5">
            {tools.map((tool) => {
              const isShapeTool = Boolean(activeTool?.startsWith("create:shape:"));
              const isActive = tool.id === "select"
                ? activeTool === null
                : tool.id === "hand"
                  ? activeTool === "pan"
                  : tool.id === "shape"
                    ? isShapeTool
                    : tool.id === "document"
                      ? Boolean(activeTool?.startsWith("create:document"))
                      : tool.id === "connector"
                        ? Boolean(activeTool?.startsWith("connector:"))
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
        accept="image/*,application/pdf,.pdf,.doc,.docx,.txt"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            void handleMediaFile(file);
          }
          e.target.value = "";
        }}
      />

      <LinkCreateDialog
        open={linkDialogOpen}
        onClose={() => setLinkDialogOpen(false)}
        onConfirm={startCreateLink}
      />
      <DocumentCreateDialog
        open={documentDialogOpen}
        projectPath={activeCanvas?.projectPath ?? undefined}
        canvasId={activeCanvasId ?? undefined}
        onClose={() => setDocumentDialogOpen(false)}
        onConfirm={startCreateDocument}
        onError={setUiError}
      />
    </div>
  );
}
