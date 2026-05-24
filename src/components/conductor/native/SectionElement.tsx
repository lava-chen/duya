"use client";

import React from "react";
import type { CanvasElement } from "@/types/conductor";

interface SectionElementProps {
  element: CanvasElement;
}

export const SectionElement: React.FC<SectionElementProps> = ({ element }) => {
  const w = Math.round(element.position.w * 80);
  const h = Math.round(element.position.h * 80);
  const title = (element.config.title as string) || "";
  const backgroundColor = (element.config.background as string) || "rgba(124, 58, 237, 0.08)";

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: "block", overflow: "visible", zIndex: 0 }}
    >
      <rect
        x={0}
        y={0}
        width={w}
        height={h}
        fill={backgroundColor}
        rx={8}
      />
      {title && (
        <text
          x={12}
          y={20}
          fill="var(--muted)"
          fontSize={13}
          fontFamily="inherit"
          fontWeight={500}
        >
          {title}
        </text>
      )}
    </svg>
  );
};