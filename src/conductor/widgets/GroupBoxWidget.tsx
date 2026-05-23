"use client";

import type { WidgetComponentProps, WidgetDefinition } from "./registry";

interface GroupBoxData {
  label: string;
  collapsed: boolean;
  accentColor: string;
}

function GroupBoxWidget({ data, children }: WidgetComponentProps & { children?: React.ReactNode }) {
  const group = (data as unknown as GroupBoxData) || { label: "Group", collapsed: false, accentColor: "" };

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center gap-2 px-2 py-1.5 rounded-t-md border-b"
        style={{
          borderColor: group.accentColor || "var(--border)",
          backgroundColor: group.accentColor ? `${group.accentColor}12` : "var(--surface)",
        }}
      >
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: group.accentColor || "var(--accent)" }}
        />
        <span className="text-xs font-semibold text-[var(--text)] truncate">
          {group.label}
        </span>
      </div>
      <div className="flex-1 p-2 min-h-0 overflow-auto">
        {children || (
          <span className="text-[10px] text-[var(--muted)]">
            Drop widgets inside to group them
          </span>
        )}
      </div>
    </div>
  );
}

export const GroupBoxDefinition: WidgetDefinition = {
  kind: "builtin",
  type: "group-box",
  label: "Group Box",
  description: "Visual grouping container with label",
  component: GroupBoxWidget,
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 2, h: 2 },
  defaultData: {
    label: "Section",
    collapsed: false,
    accentColor: "#3b82f6",
  },
  defaultConfig: {
    title: "📦 Group",
  },
};