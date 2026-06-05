"use client";

/**
 * CapabilitySecurityBadge — Plan 83b Phase 4
 *
 * Visual badge for skill security verdicts surfaced by the
 * cross-source scanner. Inline English labels (Phase 4 does not
 * touch the i18n files; legacy follow-up commits handle the
 * migration).
 */

import { cn } from "@/lib/utils";

import type { CapabilitySkillSecurityVerdict } from "@/lib/capability-management-types";

const VERDICT_CONFIG: Record<CapabilitySkillSecurityVerdict, { label: string; className: string }> = {
  safe: { label: "Safe", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400" },
  caution: { label: "Caution", className: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400" },
  dangerous: { label: "Dangerous", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400" },
  unknown: { label: "Unknown", className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-400" },
};

interface CapabilitySecurityBadgeProps {
  verdict: CapabilitySkillSecurityVerdict;
  findingCount?: number;
}

export function CapabilitySecurityBadge({ verdict, findingCount }: CapabilitySecurityBadgeProps) {
  const config = VERDICT_CONFIG[verdict];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-current/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
        config.className,
      )}
      title={findingCount && findingCount > 0 ? `${findingCount} findings` : undefined}
    >
      {config.label}
      {findingCount && findingCount > 0 ? (
        <span className="text-[9px] opacity-70">·{findingCount}</span>
      ) : null}
    </span>
  );
}
