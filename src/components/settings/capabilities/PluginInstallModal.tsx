"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import { XIcon, CubeIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { PluginCatalogEntry, PluginCapabilityDisplay, PluginPermissionDisplay } from "@/lib/plugin-types";
import {
  buildIncludes,
  getKindIconClass,
  getKindFirstLetter,
  type IncludeItem,
} from "./capability-adapter";

interface PluginInstallModalProps {
  plugin: PluginCatalogEntry;
  onInstall: () => void;
  onCancel: () => void;
  busy: boolean;
}

const PERMISSION_RISK_COLORS: Record<string, string> = {
  low: "text-muted-foreground",
  medium: "text-amber-500",
  high: "text-red-500",
};

const PERMISSION_RISK_BG: Record<string, string> = {
  low: "bg-muted/30",
  medium: "bg-amber-500/5 border-amber-500/15",
  high: "bg-red-500/5 border-red-500/15",
};

function buildDisplayCapabilities(plugin: PluginCatalogEntry): PluginCapabilityDisplay[] {
  if (plugin.capabilities && plugin.capabilities.length > 0) {
    return plugin.capabilities;
  }

  const items: PluginCapabilityDisplay[] = [];
  const manifest = plugin.manifest;
  if (!manifest) return items;

  if (manifest.capabilities.skills) {
    for (const s of manifest.capabilities.skills) {
      const skillPath = typeof s === "string" ? s : (s as { path: string }).path ?? "";
      items.push({
        id: `skill-${skillPath}`,
        name: skillPath.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, ""),
        type: "skill" as const,
        description: typeof s === "string" ? `Skill: ${skillPath}` : ((s as { description?: string }).description ?? `Skill: ${skillPath}`),
        required: true,
        enabled: true,
      });
    }
  }
  if (manifest.capabilities.mcpServers) {
    for (const m of manifest.capabilities.mcpServers) {
      items.push({
        id: `mcp-${m.name}`,
        name: m.name,
        type: "mcp" as const,
        description: m.command,
        required: true,
        enabled: true,
      });
    }
  }
  if (manifest.capabilities.cli) {
    for (const c of manifest.capabilities.cli) {
      items.push({
        id: `cli-${c.name}`,
        name: c.name,
        type: "cli" as const,
        description: c.command,
        required: true,
        enabled: true,
      });
    }
  }
  return items;
}

function buildDisplayPermissions(plugin: PluginCatalogEntry): PluginPermissionDisplay[] {
  if (plugin.permissions && plugin.permissions.length > 0) {
    return plugin.permissions;
  }

  const manifest = plugin.manifest;
  if (!manifest?.permissions) return [];

  const permissionLabels: Record<string, { title: string; description: string; riskLevel: 'low' | 'medium' | 'high' }> = {
    'agent.memory.read': { title: 'Read Agent Memory', description: 'Access your research memory and saved knowledge', riskLevel: 'low' },
    'agent.memory.write': { title: 'Write Agent Memory', description: 'Save new information to your research memory', riskLevel: 'low' },
    'workspace.read': { title: 'Read Workspace Files', description: 'Read files in your current project workspace', riskLevel: 'low' },
    'workspace.write': { title: 'Write Workspace Files', description: 'Create and modify files in your workspace', riskLevel: 'medium' },
    'file.read': { title: 'Read Local Files', description: 'Access files outside the project workspace', riskLevel: 'medium' },
    'file.write': { title: 'Write Local Files', description: 'Modify files outside the project workspace', riskLevel: 'high' },
    'network': { title: 'Network Access', description: 'Make network requests to external services', riskLevel: 'medium' },
    'exec': { title: 'Execute Commands', description: 'Run system commands and scripts', riskLevel: 'high' },
  };

  return manifest.permissions.map((p) => {
    const label = permissionLabels[p.name] || {
      title: p.name,
      description: `Permission: ${p.name}${p.scope ? ` (scope: ${p.scope})` : ""}`,
      riskLevel: 'low' as const,
    };
    return {
      id: p.name,
      title: label.title,
      description: label.description,
      required: true,
      enabled: true,
      riskLevel: label.riskLevel,
    };
  });
}

export function PluginInstallModal({
  plugin,
  onInstall,
  onCancel,
  busy,
}: PluginInstallModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [enableAfterInstall, setEnableAfterInstall] = useState(true);
  const [allowAutoInvoke, setAllowAutoInvoke] = useState(false);

  const displayCapabilities = useMemo(() => buildDisplayCapabilities(plugin), [plugin]);
  const displayPermissions = useMemo(() => buildDisplayPermissions(plugin), [plugin]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onCancel]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && e.target === modalRef.current) {
        onCancel();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onCancel]);

  const monogram = plugin.name.trim().charAt(0).toUpperCase();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" ref={modalRef}>
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-lg max-h-[85vh] bg-[var(--main-bg)] border border-border/50 rounded-xl shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 p-5 border-b border-border/50 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-sm font-semibold text-accent">
              <CubeIcon size={20} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Duya</span>
              <div className="flex items-center gap-1 text-muted-foreground/60">
                <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/40" />
                <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/40" />
                <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/40" />
              </div>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface/60 text-sm font-semibold text-foreground">
                {monogram}
              </div>
              <span className="text-sm text-foreground">{plugin.name}</span>
            </div>
          </div>
          <button onClick={onCancel} className="p-2 rounded-lg hover:bg-muted transition-colors">
            <XIcon size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Developer info */}
          <p className="text-xs text-muted-foreground">
            Built by {plugin.developer || plugin.author?.name || "Duya"}
          </p>

          {/* Description */}
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              About
            </h4>
            <p className="text-sm text-foreground leading-relaxed">
              {plugin.longDescription || plugin.description}
            </p>
          </div>

          {/* Included capabilities */}
          {displayCapabilities.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Included Capabilities
              </h4>
              <div className="space-y-1.5">
                {displayCapabilities.map((cap) => (
                  <div
                    key={cap.id}
                    className="flex items-center gap-3 rounded-lg border border-border/40 bg-surface/40 px-3 py-2"
                  >
                    <span className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold",
                      getKindIconClass(cap.type === "tool" ? "skill" : cap.type === "connector" ? "mcp" : cap.type as "skill" | "mcp" | "cli")
                    )}>
                      {getKindFirstLetter(cap.type === "tool" ? "skill" : cap.type === "connector" ? "mcp" : cap.type as "skill" | "mcp" | "cli")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-foreground">{cap.name}</span>
                        <span className="text-[10px] text-muted-foreground uppercase">
                          {cap.type}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{cap.description}</p>
                    </div>
                    {cap.required && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">Required</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Permissions */}
          {displayPermissions.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Permissions & Access
              </h4>
              <div className="space-y-1.5">
                {displayPermissions.map((perm) => (
                  <div
                    key={perm.id}
                    className={cn(
                      "rounded-lg border px-3 py-2",
                      PERMISSION_RISK_BG[perm.riskLevel] || PERMISSION_RISK_BG.low
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-foreground">{perm.title}</span>
                      <span className={cn("text-[10px] font-medium uppercase", PERMISSION_RISK_COLORS[perm.riskLevel])}>
                        {perm.riskLevel} risk
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{perm.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Options */}
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Options
            </h4>
            <div className="space-y-2">
              <label className="flex items-center gap-3 rounded-lg border border-border/40 bg-surface/40 px-3 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableAfterInstall}
                  onChange={(e) => setEnableAfterInstall(e.target.checked)}
                  className="h-4 w-4 rounded border-border/60 text-accent focus:ring-accent"
                />
                <div>
                  <span className="text-sm text-foreground">Enable after install</span>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Immediately activate this plugin for use in conversations
                  </p>
                </div>
              </label>
              <label className="flex items-center gap-3 rounded-lg border border-border/40 bg-surface/40 px-3 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowAutoInvoke}
                  onChange={(e) => setAllowAutoInvoke(e.target.checked)}
                  className="h-4 w-4 rounded border-border/60 text-accent focus:ring-accent"
                />
                <div>
                  <span className="text-sm text-foreground">Allow auto-invoke in conversations</span>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Let Duya automatically use this plugin&apos;s capabilities when relevant
                  </p>
                </div>
              </label>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-5 border-t border-border/50 shrink-0">
          <button
            type="button"
            className="rounded-lg border border-border/60 px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={onInstall}
            disabled={busy}
          >
            {busy ? "Installing..." : "Install Plugin"}
          </button>
        </div>
      </div>
    </div>
  );
}