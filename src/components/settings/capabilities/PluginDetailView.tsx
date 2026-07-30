"use client";

import { useMemo, useState, useEffect, useCallback } from "react";
import { ArrowLeftIcon, CopyIcon, CheckIcon, WarningIcon, ChevronDownIcon, ChevronUpIcon, ArrowRightIcon, ExternalLinkIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/utils";
import { getPluginAPI } from "@/lib/plugin-ipc";
import { fetchMCPInventorySnapshot } from "@/lib/mcp-inventory-ipc";
import { dispatchPrefillChatInput } from "@/lib/prefill-chat-input-event";
import type { PluginCatalogEntry, PluginRegistryEntry, PluginCapabilityDisplay, PluginPermissionDisplay, CapabilityIndexItem } from "@/lib/plugin-types";
import type { MCPEffectiveServerDTO } from "@/lib/mcp-inventory-types";
import type { WorkflowTemplate, WorkflowTemplateSummary } from "@duya/plugin-core";
import { instantiateWorkflow, extractVariables, WorkflowInstantiateError, getTemplatePrompt } from "@duya/plugin-core";
import { tierRequiresConfirmation, tierRequiresExplicitConfirmation, bumpPermissionTier } from "@duya/plugin-core";
import { RuntimeStatusBadge } from "./RuntimeStatusBadge";
import {
  buildIncludes,
  getUsageExamples,
  getWorkflows,
  getPermissionTierDisplay,
} from "./capability-adapter";

interface PluginDetailViewProps {
  installed: PluginRegistryEntry;
  catalog: PluginCatalogEntry | null;
  onBack: () => void;
  onEnable: () => void;
  onDisable: () => void;
  onRemove: () => void;
  busy: boolean;
  /**
   * Plan 311 — called after a workflow template is instantiated and
   * the prefill event has been dispatched. The parent navigates to
   * the chat view so `MessageInput` can consume the pending prefill.
   */
  onLaunchWorkflow?: (prompt: string) => void;
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
  // Plan 311 made `PluginManifest.capabilities` optional on v2 manifests;
  // guard here so the detail view degrades to "no capabilities" instead of
  // throwing when a v2 manifest has no `capabilities` block.
  if (!manifest.capabilities) return items;
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
        description: m.command ?? m.name,
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
  onLaunchWorkflow,
}: PluginDetailViewProps) {
  const [techExpanded, setTechExpanded] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);

  // Plan 311 — workflow template discovery + launch state.
  const [indexItem, setIndexItem] = useState<CapabilityIndexItem | null>(null);
  const [launchingWorkflowId, setLaunchingWorkflowId] = useState<string | null>(null);
  const [fullTemplate, setFullTemplate] = useState<WorkflowTemplate | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [dangerConfirmed, setDangerConfirmed] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchLoading, setLaunchLoading] = useState(false);

  const pluginApi = useMemo(() => getPluginAPI(), []);

  // MCP tool discovery for plugin-declared servers.
  const [serverTools, setServerTools] = useState<Array<{
    server: MCPEffectiveServerDTO;
    tools: Array<{ name: string; description?: string }> | null;
    loading: boolean;
    error?: string;
  }>>([]);

  useEffect(() => {
    if (!pluginApi) return;
    let cancelled = false;

    void (async () => {
      try {
        const snapshot = await fetchMCPInventorySnapshot();
        if (cancelled || !snapshot) return;

        const pluginServers = snapshot.effectiveServers.filter(
          (server) => server.sourceId === installed.id,
        );

        setServerTools(
          pluginServers.map((server) => ({
            server,
            tools: null,
            loading: true,
          })),
        );

        await Promise.all(
          pluginServers.map(async (server) => {
            const res = await pluginApi.mcpTools(server.id);
            if (cancelled) return;
            setServerTools((prev) =>
              prev.map((entry) =>
                entry.server.id === server.id
                  ? {
                      ...entry,
                      tools: res.success && res.data ? res.data : null,
                      loading: false,
                      error: res.success ? undefined : (res.error ?? "Unable to load tools"),
                    }
                  : entry,
              ),
            );
          }),
        );
      } catch {
        // Silent — the Connectors section shows loading/error states.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pluginApi, installed.id]);
  const workflows = useMemo(() => getWorkflows(indexItem), [indexItem]);
  const launchVariables = useMemo(
    () => (fullTemplate ? extractVariables(fullTemplate) : []),
    [fullTemplate],
  );

  // Fetch the capability index entry for this plugin so we can show
  // workflow summaries. The index is the only source of workflow
  // summaries in the renderer (Plan 241 progressive disclosure).
  useEffect(() => {
    if (!pluginApi) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await pluginApi.capabilityIndex();
        if (cancelled) return;
        if (res.success && res.data) {
          const entry = res.data.find((item) => item.pluginId === installed.id) ?? null;
          setIndexItem(entry);
        }
      } catch {
        // Silent — workflows section just stays empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginApi, installed.id]);

  const handleLaunchClick = useCallback(
    async (workflowId: string) => {
      if (!pluginApi) return;
      setLaunchLoading(true);
      setLaunchError(null);
      try {
        const res = await pluginApi.workflowGet({
          pluginId: installed.id,
          workflowId,
        });
        if (!res.success || !res.data) {
          setLaunchError(res.error ?? "Failed to load workflow template");
          return;
        }
        setFullTemplate(res.data);
        setLaunchingWorkflowId(workflowId);
        setVariableValues({});
        setDangerConfirmed(false);
      } catch (err) {
        setLaunchError(err instanceof Error ? err.message : String(err));
      } finally {
        setLaunchLoading(false);
      }
    },
    [pluginApi, installed.id],
  );

  const handleLaunchConfirm = useCallback(() => {
    if (!fullTemplate || !onLaunchWorkflow) return;
    setLaunchError(null);
    try {
      const result = instantiateWorkflow(fullTemplate, { variables: variableValues });
      dispatchPrefillChatInput(result.prompt);
      onLaunchWorkflow(result.prompt);
      // Reset launch state after successful handoff.
      setLaunchingWorkflowId(null);
      setFullTemplate(null);
      setVariableValues({});
      setDangerConfirmed(false);
    } catch (err) {
      if (err instanceof WorkflowInstantiateError) {
        setLaunchError(err.message);
      } else {
        setLaunchError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [fullTemplate, variableValues, onLaunchWorkflow]);

  const handleLaunchCancel = useCallback(() => {
    setLaunchingWorkflowId(null);
    setFullTemplate(null);
    setVariableValues({});
    setDangerConfirmed(false);
    setLaunchError(null);
  }, []);

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

  const skills = useMemo(() => {
    const fromCaps = capabilities.filter((c) => c.type === "skill");
    if (fromCaps.length > 0) return fromCaps;
    return includes.filter((i) => i.kind === "skill");
  }, [capabilities, includes]);

  const connectors = useMemo(() => {
    const fromCaps = capabilities.filter((c) => c.type === "mcp" || c.type === "connector");
    if (fromCaps.length > 0) return fromCaps;
    return includes.filter((i) => i.kind === "mcp");
  }, [capabilities, includes]);

  const grantedPermissionCount = permissions.filter((perm) => perm.enabled).length;
  const permissionCount = permissions.length;
  const authorName = catalog?.developer || entry.author?.name || "Unknown";

  const externalUrl = catalog?.website || catalog?.documentationUrl || entry.author?.url;
  const externalDomain = useMemo(() => {
    if (!externalUrl) return null;
    try {
      return new URL(externalUrl).hostname.replace(/^www\./, "");
    } catch {
      return externalUrl;
    }
  }, [externalUrl]);

  const hasIssues =
    installed.runtimeStatus === "needs_setup" ||
    installed.runtimeStatus === "failed_to_load" ||
    (installed.permissionDenied?.length ?? 0) > 0;

  return (
    <div className="space-y-8">
      {/* Back button */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon size={16} />
          Back
        </Button>
      </div>

      {/* Header */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-3xl font-semibold text-foreground">{entry.name}</h1>
            <RuntimeStatusBadge status={installed.runtimeStatus} />
          </div>
          <p className="text-sm text-muted-foreground">by {authorName}</p>
          {externalUrl && externalDomain && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-foreground hover:underline"
            >
              View on {externalDomain}
              <ExternalLinkIcon size={14} />
            </a>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {externalUrl && (
            <IconButton
              variant="default"
              size="sm"
              aria-label="Open external link"
              onClick={() => window.open(externalUrl, "_blank", "noopener,noreferrer")}
            >
              <ExternalLinkIcon size={16} />
            </IconButton>
          )}
          <Button variant="secondary" size="sm" disabled={busy} onClick={onRemove}>
            Uninstall
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={installed.enabled ? onDisable : onEnable}
          >
            {installed.enabled ? "Disable" : "Enable"}
          </Button>
        </div>
      </div>

      {/* Description */}
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
        {catalog?.longDescription || entry.description}
      </p>

      {/* Try asking... */}
      {usageExamples.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-base font-semibold text-foreground">Try asking...</h3>
          <div className="space-y-2">
            {usageExamples.map((example, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => dispatchPrefillChatInput(example.prompt)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/40 bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
              >
                <span className="text-sm text-foreground">{example.prompt}</span>
                <ArrowRightIcon size={16} className="shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Plan 311 — Workflow Templates section */}
      {workflows.length > 0 && (
        <section className="space-y-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">Workflows</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Pre-built task templates. Launch one to pre-fill the chat input — you can review
              and edit before sending.
            </p>
          </div>
          <div className="space-y-2">
            {workflows.map((wf) => (
              <WorkflowLaunchCard
                key={wf.id}
                workflow={wf}
                isLaunching={launchingWorkflowId === wf.id}
                fullTemplate={launchingWorkflowId === wf.id ? fullTemplate : null}
                launchVariables={launchingWorkflowId === wf.id ? launchVariables : []}
                variableValues={launchingWorkflowId === wf.id ? variableValues : {}}
                onVariableChange={(name, value) =>
                  setVariableValues((prev) => ({ ...prev, [name]: value }))
                }
                dangerConfirmed={dangerConfirmed}
                onDangerConfirmChange={setDangerConfirmed}
                launchError={launchingWorkflowId === wf.id ? launchError : null}
                launchLoading={launchingWorkflowId === wf.id ? launchLoading : false}
                onLaunch={() => void handleLaunchClick(wf.id)}
                onConfirm={handleLaunchConfirm}
                onCancel={handleLaunchCancel}
                canConfirm={
                  !!onLaunchWorkflow &&
                  (launchingWorkflowId !== wf.id ||
                    !tierRequiresExplicitConfirmation(
                      bumpPermissionTier(fullTemplate?.permissionTier ?? wf.permissionTier),
                    ) ||
                    dangerConfirmed)
                }
              />
            ))}
          </div>
        </section>
      )}

      {/* Skills */}
      {skills.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-base font-semibold text-foreground">
            Skills
            <span className="ml-2 inline-flex items-center rounded-full bg-[var(--chip)] px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {skills.length}
            </span>
          </h3>
          <div className="flex flex-wrap gap-2">
            {skills.map((skill) => (
              <span
                key={skill.id}
                className="rounded-full border border-border/50 bg-[var(--chip)] px-3 py-1 text-sm text-foreground"
              >
                {skill.name}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Connectors */}
      {(connectors.length > 0 || serverTools.length > 0) && (
        <section className="space-y-3">
          <h3 className="text-base font-semibold text-foreground">
            Connectors
            <span className="ml-2 inline-flex items-center rounded-full bg-[var(--chip)] px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {serverTools.length || connectors.length}
            </span>
          </h3>
          <p className="text-sm text-muted-foreground">
            External services and tools connected via the Model Context Protocol (MCP).
          </p>
          <div className="space-y-4">
            {serverTools.length > 0 ? (
              serverTools.map(({ server, tools, loading, error }) => (
                <div key={server.id} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{server.name}</span>
                    {loading && (
                      <span className="text-xs text-muted-foreground">Loading tools…</span>
                    )}
                    {error && !loading && (
                      <span className="text-xs text-error">Unable to load tools</span>
                    )}
                  </div>
                  {tools && tools.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {tools.map((tool) => (
                        <span
                          key={tool.name}
                          title={tool.description ?? undefined}
                          className="rounded-full border border-border/50 bg-[var(--chip)] px-3 py-1 text-sm text-foreground"
                        >
                          {tool.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="flex flex-wrap gap-2">
                {connectors.map((conn) => (
                  <span
                    key={conn.id}
                    className="rounded-full border border-border/50 bg-[var(--chip)] px-3 py-1 text-sm text-foreground"
                  >
                    {conn.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Technical details (collapsible) */}
      <div>
        <Button
          variant="ghost"
          className="flex w-full items-center justify-between rounded-lg border border-border/40 bg-[var(--surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
          onClick={() => setTechExpanded(!techExpanded)}
        >
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Technical Details
          </span>
          {techExpanded ? (
            <ChevronUpIcon size={16} className="text-muted-foreground" />
          ) : (
            <ChevronDownIcon size={16} className="text-muted-foreground" />
          )}
        </Button>

        {techExpanded && (
          <div className="mt-2 space-y-6 rounded-lg border border-border/40 bg-[var(--surface)] px-4 py-4">
            {/* Runtime */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-foreground">Runtime</h4>
              <div className="space-y-2">
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
                {hasIssues && (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
                    <span className="inline-flex items-center gap-1">
                      <WarningIcon size={14} />
                      This plugin needs attention before it can be used.
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Permissions */}
            {permissions.length > 0 && (
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-foreground">
                  Permissions ({grantedPermissionCount}/{permissionCount})
                </h4>
                <div className="space-y-2">
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

            {/* Information */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-foreground">Information</h4>
              <dl className="space-y-2">
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

            {/* Install path */}
            {installed.installPath && (
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-foreground">Install path</h4>
                <div className="flex items-center gap-2">
                  <code className="block truncate rounded bg-[var(--chip)] px-2 py-0.5 text-[11px] text-muted-foreground font-mono">
                    {installed.installPath}
                  </code>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label="Copy path"
                    className="shrink-0"
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
                  </IconButton>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Plan 311 — WorkflowLaunchCard
// ----------------------------------------------------------------------------

interface WorkflowLaunchCardProps {
  workflow: WorkflowTemplateSummary;
  isLaunching: boolean;
  fullTemplate: WorkflowTemplate | null;
  launchVariables: string[];
  variableValues: Record<string, string>;
  onVariableChange: (name: string, value: string) => void;
  dangerConfirmed: boolean;
  onDangerConfirmChange: (confirmed: boolean) => void;
  launchError: string | null;
  launchLoading: boolean;
  onLaunch: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  canConfirm: boolean;
}

function WorkflowLaunchCard({
  workflow,
  isLaunching,
  fullTemplate,
  launchVariables,
  variableValues,
  onVariableChange,
  dangerConfirmed,
  onDangerConfirmChange,
  launchError,
  launchLoading,
  onLaunch,
  onConfirm,
  onCancel,
  canConfirm,
}: WorkflowLaunchCardProps) {
  const tierDisplay = getPermissionTierDisplay(workflow.permissionTier);
  const effectiveTier = bumpPermissionTier(workflow.permissionTier);
  const requiresConfirmation = tierRequiresConfirmation(effectiveTier);
  const requiresExplicit = tierRequiresExplicitConfirmation(effectiveTier);

  return (
    <div className="rounded-xl border border-border/40 bg-surface/35 px-4 py-3">
      {/* Summary row — always visible */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{workflow.name}</span>
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase",
                tierDisplay.badgeClass,
              )}
            >
              {tierDisplay.label}
            </span>
          </div>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{workflow.description}</p>
        </div>
        {!isLaunching && (
          <Button
            variant="secondary"
            size="sm"
            disabled={launchLoading}
            onClick={onLaunch}
          >
            {launchLoading ? "Loading…" : "Launch"}
            {!launchLoading && <ArrowRightIcon size={14} />}
          </Button>
        )}
      </div>

      {/* Launch panel — visible when launching */}
      {isLaunching && (
        <div className="mt-3 space-y-3 border-t border-border/30 pt-3">
          {/* Required capabilities */}
          {fullTemplate && fullTemplate.requiredCapabilities.length > 0 && (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                Required capabilities
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {fullTemplate.requiredCapabilities.map((cap) => (
                  <span
                    key={cap}
                    className="rounded border border-border/50 bg-background/60 px-2 py-0.5 text-xs font-mono text-foreground/70"
                  >
                    {cap}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Variable inputs */}
          {launchVariables.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                Variables
              </p>
              {launchVariables.map((varName) => (
                <div key={varName} className="flex flex-col gap-1">
                  <label className="text-xs text-foreground" htmlFor={`wf-var-${varName}`}>
                    {varName}
                  </label>
                  <input
                    id={`wf-var-${varName}`}
                    type="text"
                    value={variableValues[varName] ?? ""}
                    onChange={(e) => onVariableChange(varName, e.target.value)}
                    className="rounded-lg border border-border/50 bg-background/60 px-3 py-1.5 text-sm text-foreground outline-none focus:border-accent/50"
                    placeholder={`Enter ${varName}…`}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Permission tier warning */}
          {requiresConfirmation && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
              This workflow has a <strong>{tierDisplay.label}</strong> permission tier.
              {" "}
              {requiresExplicit
                ? "Confirm the checkbox below before launching."
                : "Review the pre-filled prompt carefully before sending."}
            </div>
          )}

          {/* Danger confirmation checkbox */}
          {requiresExplicit && (
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={dangerConfirmed}
                onChange={(e) => onDangerConfirmChange(e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <span>
                I understand this workflow may make dangerous changes. Confirm to proceed.
              </span>
            </label>
          )}

          {/* Error message */}
          {launchError && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/[0.05] px-3 py-2 text-xs leading-5 text-red-500">
              {launchError}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!canConfirm}
              onClick={onConfirm}
            >
              Start
              <ArrowRightIcon size={14} />
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
