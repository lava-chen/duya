"use client";

import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { PluginRuntimeStatus } from "@/lib/plugin-types";

const statusConfig: Record<PluginRuntimeStatus, { labelKey: string; colorClass: string }> = {
  enabled: {
    labelKey: "settings.capabilities.statusEnabled",
    colorClass: "bg-emerald-500/15 text-emerald-400",
  },
  disabled: {
    labelKey: "settings.capabilities.statusDisabled",
    colorClass: "bg-zinc-500/15 text-zinc-400",
  },
  needs_setup: {
    labelKey: "settings.capabilities.statusNeedsSetup",
    colorClass: "bg-amber-500/15 text-amber-400",
  },
  failed_to_load: {
    labelKey: "settings.capabilities.statusFailed",
    colorClass: "bg-red-500/15 text-red-400",
  },
  update_available: {
    labelKey: "settings.capabilities.statusUpdateAvailable",
    colorClass: "bg-blue-500/15 text-blue-400",
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