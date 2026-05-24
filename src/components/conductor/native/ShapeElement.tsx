"use client";

import React from "react";
import type { CanvasElement } from "@/types/conductor";

interface ShapeElementProps {
  element: CanvasElement;
}

function getShapeSvg(shapeType: string, w: number, h: number) {
  const strokeColor = "var(--border)";
  const fillColor = "transparent";

  switch (shapeType) {
    case "circle":
      return (
        <ellipse
          cx={w / 2}
          cy={h / 2}
          rx={w / 2}
          ry={h / 2}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={1}
        />
      );
    case "diamond":
      return (
        <polygon
          points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={1}
        />
      );
    case "triangle":
      return (
        <polygon
          points={`${w / 2},0 ${w},${h} 0,${h}`}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={1}
        />
      );
    case "capsule":
      return (
        <rect
          x={0}
          y={0}
          width={w}
          height={h}
          rx={h / 2}
          ry={h / 2}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={1}
        />
      );
    case "rect":
    default:
      return (
        <rect
          x={0}
          y={0}
          width={w}
          height={h}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={1}
          rx={4}
        />
      );
  }
}

export const ShapeElement: React.FC<ShapeElementProps> = ({ element }) => {
  const w = Math.round(element.position.w * 80);
  const h = Math.round(element.position.h * 80);
  const shapeType = (element.config.shapeType as string) || "rect";
  const label = (element.config.label as string) || "";

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: "block", overflow: "visible" }}
    >
      {getShapeSvg(shapeType, w, h)}
      {label && (
        <foreignObject x={0} y={0} width={w} height={h}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "100%",
              height: "100%",
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                fontSize: "14px",
                color: "var(--text)",
                textAlign: "center",
                lineHeight: 1.3,
                padding: "4px 8px",
                pointerEvents: "none",
              }}
            >
              {label}
            </span>
          </div>
        </foreignObject>
      )}
    </svg>
  );
};