"use client";

import React from "react";
import type { ElementComponentProps } from "./ElementRegistry";
import { EmptyElement } from "./EmptyElement";

export const ShapeRectElement: React.FC<ElementComponentProps> = ({ element }) => {
  const fill = (element.vizSpec?.payload?.fill as string) ?? "var(--bg-hover)";
  const stroke = (element.vizSpec?.payload?.stroke as string) ?? "var(--border)";
  const strokeWidth = (element.vizSpec?.payload?.strokeWidth as number) ?? 1;
  const label = (element.vizSpec?.payload?.label as string) ?? "";

  return (
    <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
      <rect
        width="100%"
        height="100%"
        rx={8}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      {label && (
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--text-secondary)"
          fontSize={14}
          fontFamily="var(--font-sans, sans-serif)"
        >
          {label}
        </text>
      )}
    </svg>
  );
};

export const ShapeCircleElement: React.FC<ElementComponentProps> = ({ element }) => {
  const fill = (element.vizSpec?.payload?.fill as string) ?? "var(--bg-hover)";
  const stroke = (element.vizSpec?.payload?.stroke as string) ?? "var(--border)";
  const strokeWidth = (element.vizSpec?.payload?.strokeWidth as number) ?? 1;
  const label = (element.vizSpec?.payload?.label as string) ?? "";

  return (
    <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
      <circle
        cx="50%"
        cy="50%"
        r="45%"
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      {label && (
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--text-secondary)"
          fontSize={14}
          fontFamily="var(--font-sans, sans-serif)"
        >
          {label}
        </text>
      )}
    </svg>
  );
};