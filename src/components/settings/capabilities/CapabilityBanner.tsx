"use client";

/**
 * CapabilityBanner — Plan 83b Phase 1A
 *
 * Read-only summary card rendered at the top of the `discover` view.
 * Inline English literal labels (Phase 1A does not modify src/i18n
 * because the file is dirty in the main worktree).
 */

import { useMemo } from "react";

import type {
  CapabilityDTO,
  CapabilityManagementSnapshot,
  PluginPackageDTO,
} from "@/lib/capability-management-types";
import { CapabilityHealthBadge } from "./CapabilityHealthBadge";

interface CapabilityBannerProps {
  snapshot: CapabilityManagementSnapshot;
  onOpenManage: () => void;
}

function countByKind(capabilities: CapabilityDTO[]): Record<CapabilityDTO["kind"], number> {
  const counts: Record<CapabilityDTO["kind"], number> = {
    skill: 0,
    mcp: 0,
    cli: 0,
    ui: 0,
    hook: 0,
  };
  for (const cap of capabilities) {
    counts[cap.kind] += 1;
  }
  return counts;
}

function countEnabledPlugins(plugins: PluginPackageDTO[]): { total: number; enabled: number; disabled: number } {
  let enabled = 0;
  let disabled = 0;
  for (const plugin of plugins) {
    if (plugin.enabled) enabled += 1;
    else disabled += 1;
  }
  return { total: plugins.length, enabled, disabled };
}

export function CapabilityBanner({ snapshot, onOpenManage }: CapabilityBannerProps) {
  const kindCounts = useMemo(() => countByKind(snapshot.capabilities), [snapshot.capabilities]);
  const pluginCounts = useMemo(() => countEnabledPlugins(snapshot.plugins), [snapshot.plugins]);

  return (
    <button
      type="button"
      onClick={onOpenManage}
      className="w-full text-left rounded-xl border border-border/50 bg-surface/40 hover:bg-surface/60 transition-colors px-4 py-3 mb-3"
    >
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-sm font-medium text-foreground">Capabilities</span>
        <span className="text-xs text-muted-foreground">Read-only snapshot</span>
      </div>
      <div className="grid grid-cols-5 gap-2 text-xs">
        <Stat label="Plugins" value={pluginCounts.total} hint={`${pluginCounts.enabled} enabled`} />
        <Stat label="Skills" value={kindCounts.skill} hint="plugin-declared" />
        <Stat label="MCP" value={kindCounts.mcp} hint="plugin-declared" />
        <Stat label="CLI" value={kindCounts.cli} hint="plugin-declared" />
        <Stat label="UI / Hook" value={kindCounts.ui + kindCounts.hook} hint="plugin-declared" />
      </div>
      {snapshot.plugins.length > 0 ? (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Health:</span>
          {snapshot.plugins.slice(0, 3).map((plugin) => (
            <CapabilityHealthBadge key={plugin.id} health={plugin.health} />
          ))}
          {snapshot.plugins.length > 3 ? (
            <span className="text-[10px] text-muted-foreground">+{snapshot.plugins.length - 3} more</span>
          ) : null}
        </div>
      ) : null}
      {pluginCounts.disabled > 0 ? (
        <div className="mt-2 text-[11px] text-amber-500">
          {pluginCounts.disabled} disabled plugin{pluginCounts.disabled === 1 ? "" : "s"} — capabilities hidden in the snapshot are listed under each disabled plugin.
        </div>
      ) : null}
    </button>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-background/40 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold text-foreground">{value}</div>
      {hint ? <div className="text-[10px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
