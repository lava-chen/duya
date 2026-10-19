"use client";

/**
 * CapabilityHealthBadge — Plan 83b Phase 4
 *
 * Visual badge for plugin package health. Renders the eight
 * combinations of {plugin enabled} × {provider alive} ×
 * {effectiveEnabled value}.
 *
 * Phase 4 explicitly does NOT merge plugin runtime health with
 * skill security verdicts. The two are surfaced independently to
 * keep the audit trail clean (per the design decision recorded in
 * `docs/design-docs/2026-06-05-capability-management.md` §E.4).
 */

import { cn } from "@/lib/utils";

import type { PluginHealth } from "@/lib/capability-management-types";

const HEALTH_CONFIG: Record<PluginHealth, { label: string; className: string }> = {
  ready: { label: "Healthy", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400" },
  disabled: { label: "Disabled", className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-400" },
  needs_setup: { label: "Needs setup", className: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400" },
  unknown: { label: "Unknown", className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-400" },
};

interface CapabilityHealthBadgeProps {
  health: PluginHealth;
}

export function CapabilityHealthBadge({ health }: CapabilityHealthBadgeProps) {
  const config = HEALTH_CONFIG[health];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-current/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
        config.className,
      )}
    >
      {config.label}
    </span>
  );
}
