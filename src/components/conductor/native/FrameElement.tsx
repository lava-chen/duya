"use client";

import React from "react";
import type { CanvasElement } from "@/types/conductor";

const GRID_PX = 80;

interface FrameElementProps {
  element: CanvasElement;
}

export const FrameElement: React.FC<FrameElementProps> = ({ element }) => {
  const w = Math.round(element.position.w * GRID_PX);
  const h = Math.round(element.position.h * GRID_PX);
  const title = (element.config.title as string) || "Frame";
  const backgroundColor =
    (element.config.background as string) || "rgba(128, 128, 128, 0.04)";
  const clipContent =
    element.config.clipContent !== undefined
      ? (element.config.clipContent as boolean)
      : true;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: "block", overflow: "visible", zIndex: 0 }}
    >
      <defs>
        <clipPath id={`frame-clip-${element.id}`}>
          <rect x={0} y={0} width={w} height={h} rx={12} ry={12} />
        </clipPath>
      </defs>

      <rect
        x={0}
        y={0}
        width={w}
        height={h}
        fill={backgroundColor}
        stroke="var(--border)"
        strokeWidth={2}
        rx={12}
        ry={12}
        strokeDasharray="8 4"
      />

      <text
        x={16}
        y={24}
        fill="var(--muted)"
        fontSize={13}
        fontFamily="inherit"
        fontWeight={600}
      >
        {title}
      </text>
    </svg>
  );
};