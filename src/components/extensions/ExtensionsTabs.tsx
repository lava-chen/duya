"use client";

import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";

export type ExtensionTab = "plugins" | "connections" | "mcp" | "skills";

interface ExtensionsTabsProps {
  active: ExtensionTab;
  onChange: (tab: ExtensionTab) => void;
  counts: Record<ExtensionTab, number>;
}

export function ExtensionsTabs({ active, onChange, counts }: ExtensionsTabsProps) {
  const { t } = useTranslation();
  const tabs: { id: ExtensionTab; labelKey: string }[] = [
    { id: "plugins", labelKey: "extensions.tabs.plugins" },
    { id: "connections", labelKey: "extensions.tabs.connections" },
    { id: "mcp", labelKey: "extensions.tabs.mcp" },
    { id: "skills", labelKey: "extensions.tabs.skills" },
  ];

  return (
    <div className="flex items-center gap-2">
      {tabs.map((tab) => {
        const selected = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              selected
                ? "bg-accent text-white"
                : "text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground"
            )}
          >
            {t(tab.labelKey as never)}
            <span
              className={cn(
                "rounded-md px-1.5 py-0 text-[10px] font-semibold",
                selected ? "bg-white/20 text-white" : "bg-[var(--surface-solid)] text-muted-foreground"
              )}
            >
              {counts[tab.id]}
            </span>
          </button>
        );
      })}
    </div>
  );
}