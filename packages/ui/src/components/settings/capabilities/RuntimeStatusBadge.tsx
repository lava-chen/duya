"use client";

import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { PluginRuntimeStatus } from "@/lib/plugin-types";

const statusConfig: Record<PluginRuntimeStatus, { labelKey: string; colorClass: string }> = {
  enabled: {
    labelKey: "settings.capabilities.statusEnabled",
    colorClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
  },
  disabled: {
    labelKey: "settings.capabilities.statusDisabled",
    colorClass: "bg-zinc-100 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-400",
  },
  needs_setup: {
    labelKey: "settings.capabilities.statusNeedsSetup",
    colorClass: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
  },
  failed_to_load: {
    labelKey: "settings.capabilities.statusFailed",
    colorClass: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400",
  },
  update_available: {
    labelKey: "settings.capabilities.statusUpdateAvailable",
    colorClass: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400",
  },
};

interface RuntimeStatusBadgeProps {
  status: PluginRuntimeStatus;
}

export function RuntimeStatusBadge({ status }: RuntimeStatusBadgeProps) {
  const { t } = useTranslation();
  const config = statusConfig[status];
  if (!config) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        config.colorClass
      )}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {t(config.labelKey as never)}
    </span>
  );
}