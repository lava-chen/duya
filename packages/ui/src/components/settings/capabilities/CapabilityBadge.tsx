"use client";

import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";

export type CapabilityKind = "skills" | "mcpServers" | "cli" | "ui" | "hooks";

const badgeConfig: Record<CapabilityKind, { labelKey: string; colorClass: string }> = {
  skills: {
    labelKey: "settings.capabilities.badgeSkills",
    colorClass: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  },
  mcpServers: {
    labelKey: "settings.capabilities.badgeMCP",
    colorClass: "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
  },
  cli: {
    labelKey: "settings.capabilities.badgeCLI",
    colorClass: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  },
  ui: {
    labelKey: "settings.capabilities.badgeUI",
    colorClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
  hooks: {
    labelKey: "settings.capabilities.badgeHooks",
    colorClass: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  },
};

interface CapabilityBadgeProps {
  kind: CapabilityKind;
  size?: "sm" | "md";
}

export function CapabilityBadge({ kind, size = "sm" }: CapabilityBadgeProps) {
  const { t } = useTranslation();
  const config = badgeConfig[kind];
  if (!config) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-medium",
        config.colorClass,
        size === "sm" ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-0.5"
      )}
    >
      {t(config.labelKey as never)}
    </span>
  );
}