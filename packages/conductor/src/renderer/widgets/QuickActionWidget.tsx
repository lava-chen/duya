"use client";

import { RocketLaunch, CheckCircle, UserPlus, Star, Lightning } from "@phosphor-icons/react";
import type { WidgetComponentProps, WidgetDefinition } from "./registry";

interface QuickActionItem {
  id: string;
  label: string;
  icon: string;
  color: string;
  completed: boolean;
}

interface QuickActionData {
  actions: QuickActionItem[];
}

const ICON_MAP: Record<string, typeof RocketLaunch> = {
  rocket: RocketLaunch,
  check: CheckCircle,
  user: UserPlus,
  star: Star,
  lightning: Lightning,
};

function QuickActionWidget({ data, onChange }: WidgetComponentProps) {
  const qa = (data as unknown as QuickActionData) || { actions: [] };
  const actions = qa.actions || [];

  const handleToggle = (id: string) => {
    const updated = actions.map((a) =>
      a.id === id ? { ...a, completed: !a.completed } : a
    );
    onChange({ ...qa, actions: updated } as unknown as Record<string, unknown>);
  };

  if (actions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--muted)]">
        <Lightning size={24} weight="duotone" />
        <span className="text-xs">No actions configured</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 h-full overflow-auto">
      {actions.map((action) => {
        const Icon = ICON_MAP[action.icon] || Lightning;
        const bgColor = action.color ? `${action.color}18` : "var(--surface)";
        const borderColor = action.color ? `${action.color}40` : "var(--border)";

        return (
          <button
            key={action.id}
            type="button"
            onClick={() => handleToggle(action.id)}
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg border transition-all text-left"
            style={{
              backgroundColor: bgColor,
              borderColor: action.completed ? "var(--border)" : borderColor,
              opacity: action.completed ? 0.5 : 1,
            }}
          >
            <Icon
              size={16}
              weight={action.completed ? "regular" : "fill"}
              style={{ color: action.completed ? "var(--muted)" : (action.color || "var(--accent)") }}
            />
            <span
              className={`text-xs flex-1 truncate ${
                action.completed ? "line-through text-[var(--muted)]" : "text-[var(--text)] font-medium"
              }`}
            >
              {action.label}
            </span>
            {action.completed && (
              <CheckCircle size={14} weight="fill" className="text-[var(--success)] flex-shrink-0" />
            )}
          </button>
        );
      })}
    </div>
  );
}

export const QuickActionDefinition: WidgetDefinition = {
  kind: "builtin",
  type: "quick-action",
  label: "Quick Actions",
  description: "Checklist-style action buttons",
  component: QuickActionWidget,
  defaultSize: { w: 3, h: 3 },
  minSize: { w: 2, h: 2 },
  defaultData: {
    actions: [
      { id: "1", label: "Review design doc", icon: "star", color: "#f59e0b", completed: false },
      { id: "2", label: "Submit PR", icon: "rocket", color: "#3b82f6", completed: false },
      { id: "3", label: "Deploy to staging", icon: "lightning", color: "#8b5cf6", completed: false },
    ],
  },
  defaultConfig: {
    title: "⚡ Actions",
  },
};