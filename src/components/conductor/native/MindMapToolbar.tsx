"use client";

import React from "react";

interface MindMapToolbarProps {
  x: number;
  y: number;
  branchColors: string[];
  activeColor: string;
  branchStrokeWidth: number;
  branchStyle: "curve" | "elbow";
  onColorChange: (color: string) => void;
  onStrokeWidthChange: (width: number) => void;
  onBranchStyleChange: (style: "curve" | "elbow") => void;
}

const BTN_BASE: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 8,
  background: "rgba(14, 22, 35, 0.94)",
  color: "#E9F0FF",
  height: 30,
  minWidth: 30,
  fontSize: 12,
  padding: "0 10px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

export const MindMapToolbar: React.FC<MindMapToolbarProps> = ({
  x,
  y,
  branchColors,
  activeColor,
  branchStrokeWidth,
  branchStyle,
  onColorChange,
  onStrokeWidthChange,
  onBranchStyleChange,
}) => (
  <foreignObject x={x} y={y} width={420} height={46} style={{ overflow: "visible", pointerEvents: "none" }}>
    <div
      style={{
        pointerEvents: "auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        borderRadius: 12,
        background: "rgba(15, 24, 38, 0.95)",
        boxShadow: "0 8px 28px rgba(8, 12, 18, 0.32)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {branchColors.slice(0, 8).map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`branch-color-${color}`}
          onClick={() => onColorChange(color)}
          style={{
            width: 22,
            height: 22,
            borderRadius: 999,
            border: color === activeColor ? "2px solid #FFFFFF" : "2px solid transparent",
            boxShadow: color === activeColor ? "0 0 0 1px rgba(255,255,255,0.4)" : "none",
            background: color,
            cursor: "pointer",
          }}
        />
      ))}
      <button
        type="button"
        onClick={() => onStrokeWidthChange(Math.max(2, branchStrokeWidth - 1))}
        style={BTN_BASE}
      >
        -
      </button>
      <button type="button" style={{ ...BTN_BASE, minWidth: 40, cursor: "default" }}>
        {branchStrokeWidth}
      </button>
      <button
        type="button"
        onClick={() => onStrokeWidthChange(Math.min(7, branchStrokeWidth + 1))}
        style={BTN_BASE}
      >
        +
      </button>
      <button
        type="button"
        onClick={() => onBranchStyleChange("curve")}
        style={{
          ...BTN_BASE,
          background: branchStyle === "curve" ? "#7C3AED" : BTN_BASE.background,
        }}
      >
        Curved
      </button>
      <button
        type="button"
        onClick={() => onBranchStyleChange("elbow")}
        style={{
          ...BTN_BASE,
          background: branchStyle === "elbow" ? "#7C3AED" : BTN_BASE.background,
        }}
      >
        Elbow
      </button>
    </div>
  </foreignObject>
);
