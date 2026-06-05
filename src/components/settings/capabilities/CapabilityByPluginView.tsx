"use client";

/**
 * CapabilityByPluginView — Plan 83b Phase 1A
 *
 * Read-only collapsible block rendered after the Installed Plugins section
 * in the `manage` view. Lists every installed plugin (including disabled
 * ones, per Rev 3 修订 2) and the capabilities it declares in its manifest.
 *
 * Phase 1A does not read the `ownEnabled` state from the resolver or
 * settings (Rev 3 修订 1): ownEnabled is always `null` and the UI shows
 * "Provided by plugin" instead of "Enabled / Disabled". Once Phase 1B
 * joins the real read models, the badge will switch to a boolean.
 *
 * Phase 1A also leaves `mcp.connectionStatus` at `'unknown'` and does
 * not derive `blockedReason` from connection errors (Rev 3 修订 4).
 */

import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";

import type {
  CapabilityDTO,
  CapabilityManagementSnapshot,
  CapabilityManagementSnapshotPhase1B,
  PluginPackageDTO,
} from "@/lib/capability-management-types";
import { CrossSourceInventory } from "./CrossSourceInventory";
import { CapabilityHealthBadge } from "./CapabilityHealthBadge";
import { CapabilitySecurityBadge } from "./CapabilitySecurityBadge";

interface CapabilityByPluginViewProps {
  snapshot: CapabilityManagementSnapshot;
}

interface PluginGroup {
  plugin: PluginPackageDTO;
  capabilities: CapabilityDTO[];
}

function groupByPlugin(snapshot: CapabilityManagementSnapshot): PluginGroup[] {
  const byPluginId = new Map<string, CapabilityDTO[]>();
  for (const cap of snapshot.capabilities) {
    if (!cap.providerPluginId) continue;
    const list = byPluginId.get(cap.providerPluginId) ?? [];
    list.push(cap);
    byPluginId.set(cap.providerPluginId, list);
  }
  const groups: PluginGroup[] = [];
  for (const plugin of snapshot.plugins) {
    groups.push({
      plugin,
      capabilities: byPluginId.get(plugin.id) ?? [],
    });
  }
  return groups;
}

function describeStatus(capability: CapabilityDTO): {
  badge: string;
  helper?: string;
} {
  if (capability.effectiveEnabled === false) {
    return {
      badge: capability.blockedReason === "plugin-disabled" ? "Blocked (plugin disabled)" : "Blocked",
      helper: "Effective state is false; resolve the provider or override to enable.",
    };
  }
  if (capability.effectiveEnabled === null) {
    return {
      badge: "Provided by plugin",
      helper:
        "Detailed enabled state will be visible once full capability aggregation lands in a later release.",
    };
  }
  return {
    badge: "Effective: true",
    helper: "Full aggregation available.",
  };
}

export function CapabilityByPluginView({ snapshot }: CapabilityByPluginViewProps) {
  const groups = useMemo(() => groupByPlugin(snapshot), [snapshot]);
  const [open, setOpen] = useState(false);
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(() => new Set());

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-border/50 bg-surface/40">
      <button
        type="button"
        className="w-full text-left px-4 py-3 flex items-center justify-between gap-2"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <div>
          <div className="text-sm font-medium text-foreground">Plugin-Declared Capabilities</div>
          <div className="text-xs text-muted-foreground">
            Read-only inventory of every capability declared by an installed plugin&apos;s on-disk manifest.
          </div>
        </div>
        <span className="text-xs text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="border-t border-border/50 divide-y divide-border/40">
          {groups.map((group) => {
            const isOpen = expandedPlugins.has(group.plugin.id);
            return (
              <div key={group.plugin.id} className="px-4 py-3">
                <button
                  type="button"
                  className="w-full text-left flex items-center justify-between gap-2"
                  onClick={() => {
                    setExpandedPlugins((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.plugin.id)) {
                        next.delete(group.plugin.id);
                      } else {
                        next.add(group.plugin.id);
                      }
                      return next;
                    });
                  }}
                  aria-expanded={isOpen}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground truncate">{group.plugin.name}</span>
                      <span className="text-[10px] text-muted-foreground">({group.plugin.id})</span>
                      <CapabilityHealthBadge health={group.plugin.health} />
                      {!group.plugin.enabled ? (
                        <span className="text-[10px] uppercase tracking-wide rounded-md border border-amber-500/40 text-amber-500 px-1.5 py-0.5">
                          Disabled
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {group.capabilities.length} declared capabilit{group.capabilities.length === 1 ? "y" : "ies"}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">{isOpen ? "▾" : "▸"}</span>
                </button>
                {isOpen ? (
                  <div className="mt-2 space-y-2">
                    {group.capabilities.length === 0 ? (
                      <div className="text-[11px] text-muted-foreground">
                        No capabilities declared in the on-disk manifest.
                      </div>
                    ) : (
                      group.capabilities.map((cap) => <CapabilityRow key={cap.displayKey} capability={cap} />)
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
          {(snapshot as CapabilityManagementSnapshotPhase1B).crossSource ? (
            <div className="px-4 py-3">
              <CrossSourceInventory snapshot={snapshot as CapabilityManagementSnapshotPhase1B} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CapabilityRow({ capability }: { capability: CapabilityDTO }) {
  const status = describeStatus(capability);
  const isBlocked = capability.effectiveEnabled === false;
  return (
    <div
      className={cn(
        "rounded-md border border-border/40 bg-background/40 px-3 py-2",
        isBlocked ? "border-amber-500/40" : null,
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-foreground flex items-center gap-2 flex-wrap">
            <span className="uppercase text-[10px] text-muted-foreground">{capability.kind}</span>
            <span>{capability.name}</span>
            {capability.kind === "skill" && capability.skill ? (
              <CapabilitySecurityBadge
                verdict={capability.skill.securityVerdict}
                findingCount={capability.skill.findingCount}
              />
            ) : null}
          </div>
          {capability.description ? (
            <div className="text-[11px] text-muted-foreground truncate">{capability.description}</div>
          ) : null}
        </div>
        <span
          className={cn(
            "text-[10px] uppercase tracking-wide rounded-md border px-1.5 py-0.5 shrink-0",
            isBlocked
              ? "border-amber-500/40 text-amber-500"
              : "border-border/60 text-muted-foreground",
          )}
        >
          {status.badge}
        </span>
      </div>
      {status.helper ? <div className="mt-1 text-[10px] text-muted-foreground">{status.helper}</div> : null}
      {capability.kind === "mcp" ? <McpRow capability={capability} /> : null}
    </div>
  );
}

function McpRow({ capability }: { capability: CapabilityDTO }) {
  const mcp = capability.mcp;
  if (!mcp) return null;
  return (
    <div className="mt-1 text-[10px] text-muted-foreground">
      Connection status: <span className="uppercase">{mcp.connectionStatus}</span>
    </div>
  );
}
