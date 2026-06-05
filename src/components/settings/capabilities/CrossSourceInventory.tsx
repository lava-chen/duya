"use client";

/**
 * CrossSourceInventory — Plan 83b Phase 1B
 *
 * Read-only sub-block rendered inside the `CapabilityByPluginView`
 * collapse when Phase 1B is active. Lists cross-source skills and MCPs
 * that the aggregate layer picked up from the resolver / collector
 * pipeline (not just from the plugin manifest).
 *
 * Phase 1B does not display MCP connection state — that is reserved
 * for Phase 3 when SSE wires in. All MCPs render with the
 * "Connection status: UNKNOWN" hint.
 */

import { useMemo, useState } from "react";

import type { CapabilityDTO, CapabilityManagementSnapshotPhase1B } from "@/lib/capability-management-types";

interface CrossSourceInventoryProps {
  snapshot: CapabilityManagementSnapshotPhase1B;
}

function describeStatus(capability: CapabilityDTO): string {
  if (capability.effectiveEnabled === false) {
    switch (capability.blockedReason) {
      case "plugin-disabled":
        return "Provider plugin is disabled";
      case "user-disabled":
        return "Disabled by user override";
      case "overridden-off":
        return "Overridden off";
      case "unresolved":
        return "Unresolved";
      default:
        return "Blocked";
    }
  }
  if (capability.effectiveEnabled === null) {
    return "Provided by plugin";
  }
  return "Enabled";
}

function bucket(capabilities: CapabilityDTO[]): {
  skills: CapabilityDTO[];
  mcps: CapabilityDTO[];
  others: CapabilityDTO[];
} {
  const skills: CapabilityDTO[] = [];
  const mcps: CapabilityDTO[] = [];
  const others: CapabilityDTO[] = [];
  for (const cap of capabilities) {
    if (cap.kind === "skill") skills.push(cap);
    else if (cap.kind === "mcp") mcps.push(cap);
    else others.push(cap);
  }
  return { skills, mcps, others };
}

export function CrossSourceInventory({ snapshot }: CrossSourceInventoryProps) {
  const [open, setOpen] = useState(false);
  const { skills, mcps, others } = useMemo(() => bucket(snapshot.capabilities), [snapshot.capabilities]);
  const cs = snapshot.crossSource;

  if (!cs) {
    // Phase 1A snapshot: no cross-source info. Render nothing.
    return null;
  }

  const total = skills.length + mcps.length + others.length;

  return (
    <div className="rounded-xl border border-border/50 bg-surface/30 mt-3">
      <button
        type="button"
        className="w-full text-left px-4 py-3 flex items-center justify-between gap-2"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <div>
          <div className="text-sm font-medium text-foreground">Cross-Source Inventory</div>
          <div className="text-xs text-muted-foreground">
            Phase 1B: aggregated from skill resolver, MCP collector, and plugin manifests. {total} entr{total === 1 ? "y" : "ies"}; {cs.skillCandidateCount} skill candidates, {cs.mcpCandidateCount} MCP candidates.
          </div>
        </div>
        <span className="text-xs text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="border-t border-border/50 px-4 py-3 space-y-3 text-xs">
          <Section title={`Skills (${skills.length})`} capabilities={skills} />
          <Section title={`MCP servers (${mcps.length})`} capabilities={mcps} showMcpHint />
          {others.length > 0 ? <Section title={`Other (${others.length})`} capabilities={others} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  title,
  capabilities,
  showMcpHint,
}: {
  title: string;
  capabilities: CapabilityDTO[];
  showMcpHint?: boolean;
}) {
  if (capabilities.length === 0) {
    return (
      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{title}</div>
        <div className="text-[11px] text-muted-foreground/70">No entries.</div>
      </div>
    );
  }
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{title}</div>
      <div className="space-y-1.5">
        {capabilities.map((cap) => (
          <div
            key={cap.displayKey}
            className="rounded-md border border-border/40 bg-background/40 px-2 py-1.5"
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium text-foreground truncate">
                  {cap.name}
                  <span className="ml-2 text-[10px] text-muted-foreground uppercase">
                    [{cap.origin}{cap.providerPluginId ? ` / ${cap.providerPluginId}` : ""}]
                  </span>
                </div>
                {cap.description ? <div className="text-[10px] text-muted-foreground truncate">{cap.description}</div> : null}
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">{describeStatus(cap)}</span>
            </div>
            {showMcpHint && cap.mcp ? (
              <div className="mt-1 text-[10px] text-muted-foreground">
                Connection status: <span className="uppercase">{cap.mcp.connectionStatus}</span>
              </div>
            ) : null}
            {cap.skill ? (
              <div className="mt-1 text-[10px] text-muted-foreground">
                Security verdict: <span className="uppercase">{cap.skill.securityVerdict}</span>
                {cap.skill.findingCount > 0 ? ` (${cap.skill.findingCount} findings)` : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
