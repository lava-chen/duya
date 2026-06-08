"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeftIcon,
  CopyIcon,
  CheckIcon,
  WarningIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from "@/components/icons";
import { cn } from "@/lib/utils";
import type { PluginCatalogEntry, PluginRegistryEntry, PluginCapabilityDisplay, PluginPermissionDisplay } from "@/lib/plugin-types";
import { RuntimeStatusBadge } from "./RuntimeStatusBadge";
import {
  buildIncludes,
  getUsageExamples,
  getKindIconClass,
  getKindFirstLetter,
} from "./capability-adapter";

interface PluginDetailViewProps {
  installed: PluginRegistryEntry;
  catalog: PluginCatalogEntry | null;
  onBack: () => void;
  onEnable: () => void;
  onDisable: () => void;
  onRemove: () => void;
  busy: boolean;
}

function buildCapabilities(
  catalog: PluginCatalogEntry | null,
  installed: PluginRegistryEntry
): PluginCapabilityDisplay[] {
  if (catalog?.capabilities && catalog.capabilities.length > 0) {
    return catalog.capabilities;
  }

  const manifest = catalog?.manifest || installed.manifest;
  if (!manifest) return [];

  const items: PluginCapabilityDisplay[] = [];
  if (manifest.capabilities.skills) {
    for (const s of manifest.capabilities.skills) {
      const skillPath = typeof s === "string" ? s : (s as { path: string }).path ?? "";
      items.push({
        id: `skill-${skillPath}`,
        name: skillPath.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, ""),
        type: "skill",
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
        type: "mcp",
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
        type: "cli",
        description: c.command,
        required: true,
        enabled: true,
      });
    }
  }
  return items;
}

function buildPermissions(
  catalog: PluginCatalogEntry | null,
  installed: PluginRegistryEntry
): PluginPermissionDisplay[] {
  if (catalog?.permissions && catalog.permissions.length > 0) {
    return catalog.permissions;
  }

  const manifest = catalog?.manifest || installed.manifest;
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

  const grantedSet = new Set(installed.permissionsGranted);

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
      enabled: grantedSet.has(p.name),
      riskLevel: label.riskLevel,
    };
  });
}

function getCapabilityKindLabel(type: PluginCapabilityDisplay["type"]): string {
  switch (type) {
    case "skill":
      return "Skill";
    case "mcp":
      return "MCP";
    case "cli":
      return "CLI";
    case "tool":
      return "Tool";
    case "connector":
      return "Connector";
    default:
      return type;
  }
}

function normalizeCapabilityKind(
  type: PluginCapabilityDisplay["type"]
): "skill" | "mcp" | "cli" {
  if (type === "connector") return "mcp";
  if (type === "tool") return "skill";
  return type;
}

export function PluginDetailView({
  installed,
  catalog,
  onBack,
  onEnable,
  onDisable,
  onRemove,
  busy,
}: PluginDetailViewProps) {
  const [techExpanded, setTechExpanded] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);

  const entry = catalog || installed;
  const capabilities = useMemo(() => buildCapabilities(catalog, installed), [catalog, installed]);
  const permissions = useMemo(() => buildPermissions(catalog, installed), [catalog, installed]);
  const includes = useMemo(
    () => buildIncludes(catalog as PluginCatalogEntry | PluginRegistryEntry | null),
    [catalog]
  );
  const usageExamples = useMemo(
    () => getUsageExamples(catalog as PluginCatalogEntry | PluginRegistryEntry | null),
    [catalog]
  );
  const capabilityCount = capabilities.length || includes.length;
  const grantedPermissionCount = permissions.filter((perm) => perm.enabled).length;
  const permissionCount = permissions.length;
  const authorName = catalog?.developer || entry.author?.name || "Unknown";
  const lastUpdated = catalog?.updatedAt || installed.updatedAt || installed.installedAt;
  const capabilitySummary = useMemo(() => {
    if (capabilities.length > 0) {
      return capabilities.slice(0, 3).map((cap) => cap.name).join(", ");
    }
    return includes.slice(0, 3).map((item) => item.name).join(", ");
  }, [capabilities, includes]);

  const hasIssues =
    installed.runtimeStatus === "needs_setup" ||
    installed.runtimeStatus === "failed_to_load" ||
    (installed.permissionDenied?.length ?? 0) > 0;

  const monogram = entry.name.trim().charAt(0).toUpperCase();

  return (
    <div className="space-y-6">
      {/* Back button + breadcrumb */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          onClick={onBack}
        >
          <ArrowLeftIcon size={16} />
          Plugins
        </button>
        <span className="text-muted-foreground text-sm">/</span>
        <span className="text-sm text-foreground font-medium">{entry.name}</span>
      </div>

      {/* Header */}
      <div className="flex flex-col gap-5 rounded-2xl border border-border/50 bg-surface/50 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-lg font-semibold text-accent">
              {entry.icon ? (
                <img src={entry.icon} alt={entry.name} className="h-9 w-9 rounded-lg" />
              ) : (
                monogram
              )}
            </div>
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-2xl font-semibold text-foreground">{entry.name}</h2>
                <span className="text-xs text-muted-foreground">v{entry.version}</span>
                <RuntimeStatusBadge status={installed.runtimeStatus} />
              </div>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                {catalog?.shortDescription || entry.description}
              </p>
              <div className="flex items-center gap-3 flex-wrap text-sm">
                <span className={cn(
                  "font-medium",
                  installed.enabled ? "text-emerald-600" : "text-muted-foreground"
                )}>
                  {installed.enabled ? "Enabled" : "Disabled"}
                </span>
                <span className="text-muted-foreground">by {authorName}</span>
                <span className="text-muted-foreground capitalize">{entry.source}</span>
                {hasIssues && (
                  <span className="inline-flex items-center gap-1 text-amber-500">
                    <WarningIcon size={14} />
                    Needs attention
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              className={cn(
                "rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50",
                installed.enabled
                  ? "border border-border/60 text-muted-foreground hover:text-foreground"
                  : "bg-accent text-white hover:opacity-90"
              )}
              disabled={busy}
              onClick={installed.enabled ? onDisable : onEnable}
            >
              {installed.enabled ? "Disable" : "Enable"}
            </button>
            <button
              type="button"
              className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-500/20 dark:text-red-400 dark:hover:bg-red-500/10"
              disabled={busy}
              onClick={onRemove}
            >
              Remove
            </button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-border/40 bg-background/40 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Agent Ready
            </p>
            <p className="mt-2 text-lg font-semibold text-foreground">
              {installed.enabled && !hasIssues ? "Ready to use" : hasIssues ? "Needs review" : "Disabled"}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {installed.enabled
                ? "The plugin can be exposed to chat once setup and permissions are healthy."
                : "Enable the plugin to expose its capabilities to the agent."}
            </p>
          </div>
          <div className="rounded-xl border border-border/40 bg-background/40 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Includes
            </p>
            <p className="mt-2 text-lg font-semibold text-foreground">
              {capabilityCount} capability{capabilityCount === 1 ? "" : "ies"}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {capabilitySummary || "No declared capabilities yet."}
            </p>
          </div>
          <div className="rounded-xl border border-border/40 bg-background/40 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Permissions
            </p>
            <p className="mt-2 text-lg font-semibold text-foreground">
              {grantedPermissionCount}/{permissionCount}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {permissionCount > 0
                ? "Granted access scopes required by this plugin."
                : "This plugin does not request extra access."}
            </p>
          </div>
          <div className="rounded-xl border border-border/40 bg-background/40 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Last Updated
            </p>
            <p className="mt-2 text-lg font-semibold text-foreground">{lastUpdated}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Source: <span className="capitalize">{entry.source}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <section className="space-y-3">
            <div>
              <h3 className="text-base font-semibold text-foreground">Overview</h3>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                {catalog?.longDescription || entry.description}
              </p>
            </div>
            {capabilityCount > 0 && (
              <div className="flex flex-wrap gap-2">
                {(capabilities.length > 0 ? capabilities : includes).map((item) => {
                  const label =
                    "type" in item
                      ? getCapabilityKindLabel(item.type)
                      : item.kindLabel;
                  return (
                    <span
                      key={item.id}
                      className="rounded-full border border-border/50 bg-background/60 px-3 py-1 text-xs font-medium text-foreground"
                    >
                      {label}
                    </span>
                  );
                })}
              </div>
            )}
          </section>

          {usageExamples.length > 0 && (
            <section className="space-y-3">
              <div>
                <h3 className="text-base font-semibold text-foreground">Try In Chat</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  These are the clearest prompts to verify the plugin is working.
                </p>
              </div>
              <div className="space-y-2">
                {usageExamples.slice(0, 3).map((example, idx) => (
                  <div
                    key={idx}
                    className="rounded-xl border border-border/40 bg-surface/35 px-4 py-3"
                  >
                    <p className="text-sm italic leading-6 text-foreground/80">
                      &ldquo;{example.prompt}&rdquo;
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {capabilities.length > 0 && (
            <section className="space-y-3">
              <div>
                <h3 className="text-base font-semibold text-foreground">What This Adds</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  A concise view of the capabilities this plugin registers.
                </p>
              </div>
              <div className="space-y-2">
                {capabilities.map((cap) => {
                  const normalizedKind = normalizeCapabilityKind(cap.type);
                  return (
                    <div
                      key={cap.id}
                      className="flex items-start gap-3 rounded-xl border border-border/40 bg-surface/35 px-4 py-3"
                    >
                      <span className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold",
                        getKindIconClass(normalizedKind)
                      )}>
                        {getKindFirstLetter(normalizedKind)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-foreground">{cap.name}</span>
                          <span className={cn(
                            "rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase",
                            getKindIconClass(normalizedKind)
                          )}>
                            {getCapabilityKindLabel(cap.type)}
                          </span>
                          {cap.required && (
                            <span className="text-[10px] text-muted-foreground">Required</span>
                          )}
                        </div>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">{cap.description}</p>
                      </div>
                      <span className={cn(
                        "shrink-0 text-xs font-medium",
                        cap.enabled ? "text-emerald-600" : "text-muted-foreground"
                      )}>
                        {cap.enabled ? "Active" : "Inactive"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {capabilities.length === 0 && includes.length > 0 && (
            <section className="space-y-3">
              <div>
                <h3 className="text-base font-semibold text-foreground">What This Adds</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  A concise view of the capability groups exposed by this plugin.
                </p>
              </div>
              <div className="space-y-2">
                {includes.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-3 rounded-xl border border-border/40 bg-surface/35 px-4 py-3"
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold",
                        getKindIconClass(item.kind)
                      )}
                    >
                      {getKindFirstLetter(item.kind)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">
                          {item.name}
                        </span>
                        <span className={cn(
                          "rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase",
                          getKindIconClass(item.kind)
                        )}>
                          {item.kindLabel}
                        </span>
                      </div>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        {item.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <div className="rounded-2xl border border-border/50 bg-surface/40 p-4">
            <h4 className="text-sm font-semibold text-foreground">Runtime</h4>
            <div className="mt-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">Status</span>
                <RuntimeStatusBadge status={installed.runtimeStatus} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">Enabled</span>
                <span className={cn(
                  "text-sm font-medium",
                  installed.enabled ? "text-emerald-600" : "text-muted-foreground"
                )}>
                  {installed.enabled ? "Yes" : "No"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">Setup</span>
                <span className="text-sm text-foreground">
                  {installed.setupRequired ? "Required" : "Complete"}
                </span>
              </div>
              {(installed.permissionDenied?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
                  {installed.permissionDenied?.length} permission request{installed.permissionDenied?.length === 1 ? "" : "s"} denied.
                </div>
              )}
            </div>
          </div>

          {permissions.length > 0 && (
            <div className="rounded-2xl border border-border/50 bg-surface/40 p-4">
              <h4 className="text-sm font-semibold text-foreground">Permissions</h4>
              <div className="mt-3 space-y-2">
                {permissions.map((perm) => (
                  <div
                    key={perm.id}
                    className="rounded-xl border border-border/35 bg-background/35 px-3 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-foreground">{perm.title}</span>
                          <span className={cn(
                            "text-[10px] font-medium uppercase",
                            perm.riskLevel === "high" ? "text-red-500" :
                            perm.riskLevel === "medium" ? "text-amber-500" :
                            "text-muted-foreground"
                          )}>
                            {perm.riskLevel}
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{perm.description}</p>
                      </div>
                      <span className={cn(
                        "shrink-0 text-xs font-medium",
                        perm.enabled ? "text-emerald-600" : "text-muted-foreground"
                      )}>
                        {perm.enabled ? "Granted" : "Not granted"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-border/50 bg-surface/40 p-4">
            <h4 className="text-sm font-semibold text-foreground">Information</h4>
            <dl className="mt-3 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <dt className="text-sm text-muted-foreground">Developer</dt>
                <dd className="text-sm text-foreground">{authorName}</dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-sm text-muted-foreground">Version</dt>
                <dd className="text-sm text-foreground">v{entry.version}</dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-sm text-muted-foreground">Source</dt>
                <dd className="text-sm text-foreground capitalize">{entry.source}</dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-sm text-muted-foreground">Category</dt>
                <dd className="text-sm text-foreground capitalize">{catalog?.category || "N/A"}</dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-sm text-muted-foreground">Plugin ID</dt>
                <dd className="max-w-[180px] break-all text-right text-xs font-mono text-foreground">{entry.id}</dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>

      {/* Technical details (collapsible) */}
      <div>
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-lg border border-border/40 bg-surface/40 px-4 py-3 text-left transition-colors hover:bg-surface/60"
          onClick={() => setTechExpanded(!techExpanded)}
        >
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Technical Details
          </span>
          {techExpanded ? (
            <ChevronUpIcon size={16} className="text-muted-foreground" />
          ) : (
            <ChevronDownIcon size={16} className="text-muted-foreground" />
          )}
        </button>

        {techExpanded && (
          <div className="mt-2 space-y-3 rounded-lg border border-border/40 bg-surface/40 px-4 py-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-24 shrink-0">Status</span>
              <span className="text-sm font-medium text-foreground">
                {installed.enabled ? "Enabled" : "Disabled"}
              </span>
              <RuntimeStatusBadge status={installed.runtimeStatus} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-24 shrink-0">Source</span>
              <span className="text-sm text-foreground capitalize">{entry.source}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-24 shrink-0">Developer</span>
              <span className="text-sm text-foreground">{authorName}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-24 shrink-0">Version</span>
              <span className="text-sm text-foreground">v{entry.version}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-xs text-muted-foreground w-24 shrink-0 pt-0.5">Permissions</span>
              <div className="flex-1">
                {(installed.permissionsGranted?.length ?? 0) === 0 && (installed.permissionDenied?.length ?? 0) === 0 ? (
                  <span className="text-sm text-emerald-600">None required</span>
                ) : (
                  <div className="space-y-1">
                    {(installed.permissionDenied?.length ?? 0) > 0 && (
                      <span className="text-sm text-red-500">
                        {installed.permissionDenied?.length} denied
                      </span>
                    )}
                    {(installed.permissionsGranted?.length ?? 0) > 0 && (
                      <div className="text-xs text-muted-foreground">
                        {installed.permissionsGranted?.join(", ")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            {installed.installPath && (
              <div className="flex items-start gap-2">
                <span className="text-xs text-muted-foreground w-24 shrink-0 pt-0.5">Install path</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="block truncate rounded bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground font-mono">
                      {installed.installPath}
                    </code>
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(installed.installPath);
                          setPathCopied(true);
                          setTimeout(() => setPathCopied(false), 2000);
                        } catch {
                          void 0;
                        }
                      }}
                    >
                      {pathCopied ? (
                        <CheckIcon size={14} className="text-emerald-500" />
                      ) : (
                        <CopyIcon size={14} />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
