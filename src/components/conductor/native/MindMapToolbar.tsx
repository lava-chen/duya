"use client";

import React from "react";
import type { LayoutDirection } from "@/conductor/canvas/mindmap-layout";

interface MindMapToolbarProps {
  x: number;
  y: number;
  branchColors: string[];
  activeColor: string;
  branchStrokeWidth: number;
  branchStyle: "curve" | "elbow";
  layoutDirection: LayoutDirection;
  canDelete: boolean;
  canCollapse: boolean;
  collapsed: boolean;
  hiddenDescendantCount: number;
  onColorChange: (color: string) => void;
  onStrokeWidthChange: (width: number) => void;
  onBranchStyleChange: (style: "curve" | "elbow") => void;
  onLayoutDirectionChange: (dir: LayoutDirection) => void;
  onAddChild: () => void;
  onAddSibling: () => void;
  onToggleCollapse: () => void;
  onDelete: () => void;
}

const BTN_BASE: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 6,
  background: "rgba(255,255,255,0.06)",
  color: "#E9F0FF",
  height: 28,
  minWidth: 28,
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1,
  padding: "0 8px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

function isVertical(direction: LayoutDirection): boolean {
  return direction === "vertical";
}

function isRightOnly(direction: LayoutDirection): boolean {
  return direction === "right";
}

function isLeftBoth(direction: LayoutDirection): boolean {
  return direction === "both" || direction === "left";
}

export const MindMapToolbar: React.FC<MindMapToolbarProps> = ({
  x,
  y,
  branchColors,
  activeColor,
  branchStrokeWidth,
  branchStyle,
  layoutDirection,
  canDelete,
  canCollapse,
  collapsed,
  hiddenDescendantCount,
  onColorChange,
  onStrokeWidthChange,
  onBranchStyleChange,
  onLayoutDirectionChange,
  onAddChild,
  onAddSibling,
  onToggleCollapse,
  onDelete,
}) => (
  <foreignObject x={x} y={y} width={700} height={56} style={{ overflow: "visible", pointerEvents: "none" }}>
    <div
      style={{
        pointerEvents: "auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 8px",
        borderRadius: 10,
        background: "rgba(16, 23, 35, 0.96)",
        boxShadow: "0 12px 30px rgba(8, 12, 18, 0.4)",
        border: "1px solid rgba(255,255,255,0.12)",
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 6,
          padding: 1,
        }}
      >
        <button
          type="button"
          onClick={() => onLayoutDirectionChange("right")}
          style={{
            ...BTN_BASE,
            minWidth: 36,
            height: 24,
            border: "none",
            borderRadius: 5,
            background: isRightOnly(layoutDirection) ? "#3B82F6" : "transparent",
          }}
          title="Horizontal (right)"
        >
          →
        </button>
        <button
          type="button"
          onClick={() => onLayoutDirectionChange("both")}
          style={{
            ...BTN_BASE,
            minWidth: 36,
            height: 24,
            border: "none",
            borderRadius: 5,
            background: isLeftBoth(layoutDirection) ? "#3B82F6" : "transparent",
          }}
          title="Horizontal (both sides)"
        >
          ⇄
        </button>
        <button
          type="button"
          onClick={() => onLayoutDirectionChange("vertical")}
          style={{
            ...BTN_BASE,
            minWidth: 36,
            height: 24,
            border: "none",
            borderRadius: 5,
            background: isVertical(layoutDirection) ? "#3B82F6" : "transparent",
          }}
          title="Vertical (top-down)"
        >
          ↓
        </button>
      </div>

      <span style={{ width: 1, height: 20, background: "rgba(255,255,255,0.14)" }} />

      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 6,
          padding: 1,
        }}
      >
        <button
          type="button"
          onClick={() => onBranchStyleChange("curve")}
          style={{
            ...BTN_BASE,
            minWidth: 46,
            height: 24,
            border: "none",
            borderRadius: 5,
            background: branchStyle === "curve" ? "#3B82F6" : "transparent",
          }}
          title="Curved lines"
        >
          Curv
        </button>
        <button
          type="button"
          onClick={() => onBranchStyleChange("elbow")}
          style={{
            ...BTN_BASE,
            minWidth: 46,
            height: 24,
            border: "none",
            borderRadius: 5,
            background: branchStyle === "elbow" ? "#3B82F6" : "transparent",
          }}
          title="Elbow lines"
        >
          Elbow
        </button>
      </div>

      <span style={{ width: 1, height: 20, background: "rgba(255,255,255,0.14)" }} />

      <button type="button" onClick={onAddChild} style={BTN_BASE} title="Add child node">
        +C
      </button>
      <button type="button" onClick={onAddSibling} style={BTN_BASE} title="Add sibling node">
        +S
      </button>
      <button
        type="button"
        onClick={onToggleCollapse}
        disabled={!canCollapse}
        style={{ ...BTN_BASE, opacity: canCollapse ? 1 : 0.38 }}
        title={collapsed ? "Expand branch" : "Collapse branch"}
      >
        {collapsed ? `Show ${hiddenDescendantCount > 0 ? hiddenDescendantCount : ""}`.trim() : "Hide"}
      </button>

      <span style={{ width: 1, height: 20, background: "rgba(255,255,255,0.14)" }} />

      {branchColors.slice(0, 8).map((color) => (
        <button
          key={color}
          type="button"
          title={`Color ${color}`}
          onClick={() => onColorChange(color)}
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            border: color === activeColor ? "2px solid #FFFFFF" : "2px solid transparent",
            boxShadow: color === activeColor ? "0 0 0 1px rgba(255,255,255,0.4)" : "none",
            background: color,
            cursor: "pointer",
            padding: 0,
          }}
        />
      ))}

      <span style={{ width: 1, height: 20, background: "rgba(255,255,255,0.14)" }} />

      <button
        type="button"
        onClick={() => onStrokeWidthChange(Math.max(2, branchStrokeWidth - 1))}
        style={BTN_BASE}
        title="Decrease stroke"
      >
        -
      </button>
      <button type="button" style={{ ...BTN_BASE, minWidth: 36, cursor: "default" }} title="Stroke width">
        {branchStrokeWidth}
      </button>
      <button
        type="button"
        onClick={() => onStrokeWidthChange(Math.min(7, branchStrokeWidth + 1))}
        style={BTN_BASE}
        title="Increase stroke"
      >
        +
      </button>

      <span style={{ width: 1, height: 20, background: "rgba(255,255,255,0.14)" }} />

      <button
        type="button"
        onClick={onDelete}
        disabled={!canDelete}
        style={{ ...BTN_BASE, opacity: canDelete ? 1 : 0.38 }}
        title="Delete node"
      >
        Del
      </button>
    </div>
  </foreignObject>
);