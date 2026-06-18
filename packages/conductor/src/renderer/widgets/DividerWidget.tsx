"use client";

import type { WidgetComponentProps, WidgetDefinition } from "./registry";

interface DividerData {
  label: string;
  thickness: number;
  style: "solid" | "dashed" | "dotted";
  color: string;
}

function DividerWidget({ data }: WidgetComponentProps) {
  const div = (data as unknown as DividerData) || {
    label: "",
    thickness: 1,
    style: "solid",
    color: "",
  };

  const borderColor = div.color || "var(--border)";
  const borderStyle = div.style || "solid";
  const borderWidth = `${div.thickness || 1}px`;

  if (div.label) {
    return (
      <div className="flex items-center gap-3 h-full">
        <div
          className="flex-1"
          style={{ borderTop: `${borderWidth} ${borderStyle} ${borderColor}` }}
        />
        <span className="text-[10px] font-medium text-[var(--muted)] flex-shrink-0">
          {div.label}
        </span>
        <div
          className="flex-1"
          style={{ borderTop: `${borderWidth} ${borderStyle} ${borderColor}` }}
        />
      </div>
    );
  }

  return (
    <div
      className="h-full"
      style={{ borderTop: `${borderWidth} ${borderStyle} ${borderColor}` }}
    />
  );
}

export const DividerDefinition: WidgetDefinition = {
  kind: "builtin",
  type: "divider",
  label: "Divider",
  description: "Visual separator line",
  component: DividerWidget,
  defaultSize: { w: 6, h: 1 },
  minSize: { w: 2, h: 1 },
  defaultData: {
    label: "",
    thickness: 1,
    style: "solid",
    color: "",
  },
  defaultConfig: {
    title: "➖ Divider",
  },
};