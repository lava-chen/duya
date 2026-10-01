"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CaretRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  DotsThreeIcon,
  ExternalLinkIcon,
  PlugIcon,
  PlusIcon,
  PowerIcon,
  ProhibitIcon,
  SpinnerGapIcon,
  TrashIcon,
  WarningIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { getPluginAPI } from "@/lib/plugin-ipc";
import { fetchMCPInventorySnapshot } from "@/lib/mcp-inventory-ipc";
import { dispatchPrefillChatInput } from "@/lib/prefill-chat-input-event";
import type {
  AppConnectionProviderDTO,
  AppConnectionStatus,
  AppConnectionStatusDTO,
} from "@/lib/app-connection-ipc";
import { ConnectorIcon } from "@/components/extensions/connector-icons";
import type { PluginCatalogEntry, PluginRegistryEntry, PluginCapabilityDisplay, PluginPermissionDisplay, CapabilityIndexItem, PluginSetupFieldDef, PluginManifest } from "@/lib/plugin-types";
import type { MCPEffectiveServerDTO } from "@/lib/mcp-inventory-types";
import type { WorkflowTemplate, WorkflowTemplateSummary } from "@duya/plugin-core";
import { instantiateWorkflow, extractVariables, WorkflowInstantiateError } from "@duya/plugin-core";
import { tierRequiresConfirmation, tierRequiresExplicitConfirmation, bumpPermissionTier } from "@duya/plugin-core";
import { RuntimeStatusBadge } from "./RuntimeStatusBadge";
import {
  buildIncludes,
  getUsageExamples,
  getWorkflows,
  getPermissionTierDisplay,
  getKindIconClass,
  getKindFirstLetter,
  type IncludeItemKind,
} from "./capability-adapter";

interface PluginDetailViewProps {
  /** Required when viewing an installed plugin; absent for catalog-only (marketplace) preview. */
  installed?: PluginRegistryEntry;
  catalog: PluginCatalogEntry | null;
  onBack: () => void;
  /** Called when user clicks Install in catalog-only mode. */
  onInstall?: () => void;
  onEnable?: () => void;
  onDisable?: () => void;
  onRemove?: () => void;
  busy: boolean;
  /**
   * Plan 311 — called after a workflow template is instantiated and
   * the prefill event has been dispatched. The parent navigates to
   * the chat view so `MessageInput` can consume the pending prefill.
   */
  onLaunchWorkflow?: (prompt: string) => void;
  /** Called when the user clicks a skill chip to open its detail view. */
  onSkillClick?: (skill: { name: string; description?: string }) => void;
  // ── App connections (ChatGPT-style "Connected accounts" section) ──
  /** All app connections across providers; the section filters to the
   *  connectors declared in the plugin manifest (`components.appConnections`).
   *  Omit to hide the section entirely (e.g. settings page without the
   *  connection API). */
  connections?: AppConnectionStatusDTO[];
  /** Provider catalog used to resolve declared connector ids. */
  providers?: AppConnectionProviderDTO[];
  /** Opens the connect flow for a declared provider (setup / managed
   *  OAuth dialogs are owned by the parent page). */
  onConnectProvider?: (provider: AppConnectionProviderDTO) => void;
  onDisconnectConnection?: (connectionId: string) => void;
  onRemoveConnection?: (connectionId: string) => void;
}

function buildCapabilities(
  catalog: PluginCatalogEntry | null,
  installed?: PluginRegistryEntry
): PluginCapabilityDisplay[] {
  if (catalog?.capabilities && catalog.capabilities.length > 0) {
    return catalog.capabilities;
  }

  const manifest = catalog?.manifest || installed?.manifest;
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
  installed?: PluginRegistryEntry
): PluginPermissionDisplay[] {
  if (catalog?.permissions && catalog.permissions.length > 0) {
    return catalog.permissions;
  }

  const manifest = catalog?.manifest || installed?.manifest;
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

  const grantedSet = new Set(installed?.permissionsGranted ?? []);

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

// ============================================================================
// Presentational helpers — ChatGPT-app-detail style layout
// ============================================================================

/** Plugin icon tile with monogram fallback (duya-file:// assets retry once). */
function PluginIcon({
  name,
  icon,
  brandColor,
  size = 76,
}: {
  name: string;
  icon?: string;
  brandColor?: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    setFailed(false);
    setRetryTick(0);
  }, [icon]);

  const handleError = useCallback(() => {
    if (retryTick === 0) setRetryTick((tick) => tick + 1);
    else setFailed(true);
  }, [retryTick]);

  const src = retryTick > 0 && icon ? `${icon}#retry=${retryTick}` : icon;
  const letter = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div
      className="flex shrink-0 select-none items-center justify-center overflow-hidden rounded-[22%] shadow-sm"
      style={{
        width: size,
        height: size,
        backgroundColor: brandColor
          ? `color-mix(in srgb, ${brandColor} 16%, var(--main-bg))`
          : "var(--surface-hover)",
        border: "1px solid color-mix(in srgb, var(--foreground) 8%, transparent)",
      }}
    >
      {icon && !failed ? (
        <img
          key={src}
          src={src}
          alt=""
          draggable={false}
          decoding="async"
          className="h-[62%] w-[62%] object-contain"
          onError={handleError}
        />
      ) : (
        <span
          className="font-semibold"
          style={{ fontSize: Math.round(size * 0.34), color: brandColor ?? "var(--accent)" }}
        >
          {letter}
        </span>
      )}
    </div>
  );
}

/** Section title with the thin divider used across the detail page. */
function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="border-b border-[var(--border)] pb-2.5">
      <h3 className="flex items-baseline gap-2 text-[15px] font-semibold text-foreground">
        {title}
        {typeof count === "number" && (
          <span className="text-[13px] font-normal text-muted-foreground">{count}</span>
        )}
      </h3>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <dt className="w-28 shrink-0 pt-px text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm text-foreground">{children}</dd>
    </div>
  );
}

type IconComponent = ComponentType<{ size?: number; className?: string }>;

function MenuRow({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: IconComponent;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        danger ? "text-red-500 hover:bg-red-500/10" : "text-foreground hover:bg-[var(--surface-hover)]"
      )}
    >
      <Icon size={15} className="shrink-0 opacity-80" />
      {label}
    </button>
  );
}

/** One row of the "What's included" list. */
interface ComponentRow {
  id: string;
  kind: Exclude<IncludeItemKind, "app">;
  kindLabel: string;
  title: string;
  description: string;
  tools?: Array<{ name: string; description?: string }> | null;
  onClick?: () => void;
}

export function PluginDetailView({
  installed,
  catalog,
  onBack,
  onInstall,
  onEnable,
  onDisable,
  onRemove,
  busy,
  onLaunchWorkflow,
  onSkillClick,
  connections,
  providers,
  onConnectProvider,
  onDisconnectConnection,
  onRemoveConnection,
}: PluginDetailViewProps) {
  const { t, locale } = useTranslation();
  const isInstalled = !!installed;
  const [techExpanded, setTechExpanded] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openConnMenuId, setOpenConnMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Plan 311 — workflow template discovery + launch state.
  const [indexItem, setIndexItem] = useState<CapabilityIndexItem | null>(null);
  const [launchingWorkflowId, setLaunchingWorkflowId] = useState<string | null>(null);
  const [fullTemplate, setFullTemplate] = useState<WorkflowTemplate | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [dangerConfirmed, setDangerConfirmed] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchLoading, setLaunchLoading] = useState(false);

  // Plugin setup form — loaded from the main process via plugin:setup:load.
  // `setupBaseline` holds the values as loaded (secrets masked to ""), used
  // for dirty-checking on save so unchanged fields are not sent. The main
  // process merges on top of existing stored values, so omitted fields
  // (notably unchanged secrets) are preserved.
  const [setupFields, setSetupFields] = useState<PluginSetupFieldDef[]>([]);
  const [setupFormValues, setSetupFormValues] = useState<Record<string, string>>({});
  const [setupBaseline, setSetupBaseline] = useState<Record<string, string>>({});
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupSavedFlash, setSetupSavedFlash] = useState(false);

  const pluginApi = useMemo(() => getPluginAPI(), []);

  // MCP tool discovery for plugin-declared servers.
  const [serverTools, setServerTools] = useState<Array<{
    server: MCPEffectiveServerDTO;
    tools: Array<{ name: string; description?: string }> | null;
    loading: boolean;
    error?: string;
  }>>([]);

  useEffect(() => {
    if (!pluginApi || !isInstalled) return;
    let cancelled = false;

    void (async () => {
      try {
        const snapshot = await fetchMCPInventorySnapshot();
        if (cancelled || !snapshot) return;

        const pluginServers = snapshot.effectiveServers.filter(
          (server) => server.sourceId === installed!.id,
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
  }, [pluginApi, installed?.id]);
  const workflows = useMemo(() => getWorkflows(indexItem), [indexItem]);
  const launchVariables = useMemo(
    () => (fullTemplate ? extractVariables(fullTemplate) : []),
    [fullTemplate],
  );

  // Fetch the capability index entry for this plugin so we can show
  // workflow summaries. The index is the only source of workflow
  // summaries in the renderer (Plan 241 progressive disclosure).
  useEffect(() => {
    if (!pluginApi || !isInstalled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await pluginApi.capabilityIndex();
        if (cancelled) return;
        if (res.success && res.data) {
          const entry = res.data.find((item) => item.pluginId === installed!.id) ?? null;
          setIndexItem(entry);
        }
      } catch {
        // Silent — workflows section just stays empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginApi, installed?.id]);

  // Load setup field definitions + stored values once per plugin. Secrets
  // arrive as empty string (masked by the main process); the baseline is
  // captured so the save handler can compute the dirty diff and only send
  // fields the user actually changed.
  useEffect(() => {
    if (!pluginApi || !isInstalled) return;
    let cancelled = false;
    setSetupLoading(true);
    setSetupError(null);
    void (async () => {
      try {
        const res = await pluginApi.setupLoad(installed!.id);
        if (cancelled) return;
        if (res.success && res.data) {
          setSetupFields(res.data.fields);
          setSetupFormValues({ ...res.data.values });
          setSetupBaseline({ ...res.data.values });
        } else if (!res.success) {
          setSetupError(res.error ?? "Failed to load setup fields");
        }
      } catch (err) {
        if (!cancelled) {
          setSetupError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setSetupLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginApi, installed?.id]);

  const handleSetupSave = useCallback(async () => {
    if (!pluginApi) return;
    // Compute the dirty diff against the loaded baseline. Only changed
    // fields are sent; the main process merges them on top of existing
    // stored values. For secrets the baseline is "" (masked), so an
    // untouched secret stays "" === baseline and is omitted — preserving
    // the stored value. Clearing a text/path/url field sends "" which
    // overwrites the stored value.
    const changed: Record<string, string> = {};
    for (const field of setupFields) {
      const current = setupFormValues[field.id] ?? "";
      const baseline = setupBaseline[field.id] ?? "";
      if (current !== baseline) {
        changed[field.id] = current;
      }
    }
    if (Object.keys(changed).length === 0) {
      return;
    }
    setSetupSaving(true);
    setSetupError(null);
    setSetupSavedFlash(false);
    try {
      const res = await pluginApi.setupSave({ pluginId: installed!.id, values: changed });
      if (res.success) {
        // Refresh the baseline so subsequent saves only send new changes.
        // Reload from the main process to pick up the canonical masked
        // state (secrets stay "").
        const loadRes = await pluginApi.setupLoad(installed!.id);
        if (loadRes.success && loadRes.data) {
          setSetupFormValues({ ...loadRes.data.values });
          setSetupBaseline({ ...loadRes.data.values });
        }
        setSetupSavedFlash(true);
        setTimeout(() => setSetupSavedFlash(false), 2000);
      } else {
        setSetupError(res.error ?? "Failed to save setup values");
      }
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err));
    } finally {
      setSetupSaving(false);
    }
  }, [pluginApi, installed?.id, setupFields, setupFormValues, setupBaseline]);

  const handleLaunchClick = useCallback(
    async (workflowId: string) => {
      if (!pluginApi) return;
      setLaunchLoading(true);
      setLaunchError(null);
      try {
        const res = await pluginApi.workflowGet({
          pluginId: installed!.id,
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
    [pluginApi, installed?.id],
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

  // "…" menu: close on outside click or Escape (non-portal dropdown, so a
  // plain contains() check is reliable).
  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  // Per-connection "…" menu: same dismissal contract, scoped by the
  // data-conn-menu marker so any row's menu stays open while clicked.
  useEffect(() => {
    if (!openConnMenuId) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.("[data-conn-menu]")) setOpenConnMenuId(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenConnMenuId(null);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openConnMenuId]);

  const entry = (catalog ?? installed) as PluginCatalogEntry | PluginRegistryEntry;
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

  const authorName = catalog?.developer || entry.author?.name || "Unknown";

  const displayName =
    locale === "zh" ? catalog?.displayName_zh || entry.name : entry.name;

  const tagline = catalog
    ? locale === "zh"
      ? catalog.shortDescription_zh || catalog.shortDescription || catalog.description_zh || catalog.description
      : catalog.shortDescription || catalog.description
    : entry.description;

  const detailDescription = catalog
    ? locale === "zh"
      ? catalog.longDescription_zh || catalog.longDescription
      : catalog.longDescription
    : null;

  const brandColor = useMemo(() => {
    const manifest: PluginManifest | undefined = catalog?.manifest ?? installed?.manifest;
    if (manifest && manifest.schemaVersion === "duya.plugin.v2") {
      return manifest.interface?.brandColor ?? null;
    }
    return null;
  }, [catalog, installed]);

  // ── App connections ("Connected accounts" section) ──
  // v2 manifests declare their connectors in `components.appConnections`;
  // each entry is a provider id in the open connector catalog (builtin ids
  // like `notion` or namespaced `plugin-<name>-<id>` strings, plan 455).
  const declaredConnectorIds = useMemo(() => {
    const manifest: PluginManifest | undefined = catalog?.manifest ?? installed?.manifest;
    if (manifest && manifest.schemaVersion === "duya.plugin.v2") {
      return manifest.components?.appConnections ?? [];
    }
    return [];
  }, [catalog, installed]);

  const resolvedProviders = useMemo(
    () => (providers ?? []).filter((p) => declaredConnectorIds.includes(p.id)),
    [providers, declaredConnectorIds]
  );

  const pluginConnections = useMemo(
    () =>
      declaredConnectorIds.length === 0
        ? []
        : (connections ?? []).filter((c) => declaredConnectorIds.includes(c.provider)),
    [connections, declaredConnectorIds]
  );

  // Hidden when the plugin declares no connectors, or when none of them
  // resolved to a host binding (no accounts to show, nothing to connect).
  const showAccounts =
    declaredConnectorIds.length > 0 &&
    (pluginConnections.length > 0 || resolvedProviders.length > 0);

  const connectionStatusLabel = useCallback(
    (status: AppConnectionStatus): string => {
      switch (status) {
        case "connected":
          return t("extensions.status.connected");
        case "pending":
          return t("extensions.status.pending");
        case "expired":
          return t("extensions.status.expired");
        case "revoked":
          return t("extensions.status.revoked");
        case "error":
          return t("extensions.status.error");
        default:
          return t("extensions.status.disconnected");
      }
    },
    [t]
  );

  const externalUrl = catalog?.website || catalog?.documentationUrl || entry.author?.url;
  const externalDomain = useMemo(() => {
    if (!externalUrl) return null;
    try {
      return new URL(externalUrl).hostname.replace(/^www\./, "");
    } catch {
      return externalUrl;
    }
  }, [externalUrl]);

  const hasIssues = installed
    ? installed.runtimeStatus === "needs_setup" ||
      installed.runtimeStatus === "failed_to_load" ||
      (installed.permissionDenied?.length ?? 0) > 0
    : false;

  // ── Actions ──

  /** Send a usage example to the chat input and hand off to the parent view. */
  const launchExample = useCallback(
    (prompt: string) => {
      dispatchPrefillChatInput(prompt);
      onLaunchWorkflow?.(prompt);
    },
    [onLaunchWorkflow],
  );

  const handleCopyPath = useCallback(async () => {
    if (!installed?.installPath) return;
    try {
      await navigator.clipboard.writeText(installed.installPath);
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 2000);
    } catch {
      void 0;
    }
  }, [installed?.installPath]);

  const primaryLabel = !isInstalled
    ? busy
      ? t("settings.capabilities.install.progress")
      : t("settings.capabilities.actionInstall")
    : installed!.enabled
      ? t("settings.capabilities.detailTryNow")
      : t("settings.capabilities.actionEnable");

  const primaryAction = useCallback(() => {
    if (!isInstalled) {
      onInstall?.();
      return;
    }
    if (!installed!.enabled) {
      onEnable?.();
      return;
    }
    const first = usageExamples[0];
    if (first) launchExample(first.prompt);
  }, [isInstalled, installed?.enabled, onInstall, onEnable, usageExamples, launchExample]);

  // ── "What's included" rows ──

  const componentRows = useMemo<ComponentRow[]>(() => {
    const rows: ComponentRow[] = [];

    if (serverTools.length > 0) {
      // Live inventory wins: one row per effective server with its tools.
      for (const { server, tools, loading, error } of serverTools) {
        rows.push({
          id: `mcp-${server.id}`,
          kind: "mcp",
          kindLabel: "MCP",
          title: server.name,
          description: loading
            ? t("settings.capabilities.detailToolsLoading")
            : error
              ? error
              : tools && tools.length > 0
                ? t("settings.capabilities.detailToolCount", { count: tools.length })
                : "",
          tools,
        });
      }
    } else {
      for (const conn of connectors) {
        rows.push({
          id: conn.id,
          kind: "mcp",
          kindLabel: "MCP",
          title: conn.name,
          description: conn.description,
        });
      }
    }

    for (const skill of skills) {
      rows.push({
        id: skill.id,
        kind: "skill",
        kindLabel: "Skill",
        title: skill.name,
        description: skill.description,
        onClick: onSkillClick ? () => onSkillClick(skill) : undefined,
      });
    }

    // CLI / hook / UI components only — skills and MCP servers are already
    // covered above (the includes fallback inside `skills`/`connectors`
    // keeps ids aligned so nothing is shown twice).
    for (const inc of includes) {
      if (inc.kind === "mcp" || inc.kind === "skill" || inc.kind === "app") continue;
      rows.push({
        id: inc.id,
        kind: inc.kind,
        kindLabel: inc.kindLabel,
        title: inc.name,
        description: inc.description,
      });
    }

    return rows;
  }, [serverTools, connectors, skills, includes, onSkillClick, t]);

  const heroBackground = useMemo(() => {
    // Brand-tinted aurora: relative color syntax shifts hue/lightness around
    // the plugin's brand color so the banner stays vivid instead of washing
    // out to gray over var(--main-bg). Falls back to the theme accent.
    const brand = brandColor ?? "var(--accent)";
    return [
      `radial-gradient(120% 240% at 10% 8%, hsl(from ${brand} calc(h + 45) s calc(s * 0.9) calc(l * 0.85)), transparent 55%)`,
      `radial-gradient(100% 200% at 95% 0%, hsl(from ${brand} h s calc(l * 1.05)), transparent 60%)`,
      `radial-gradient(150% 220% at 45% 140%, hsl(from ${brand} calc(h - 40) s s calc(l * 0.6)), transparent 72%)`,
      `linear-gradient(135deg, hsl(from ${brand} h s calc(l * 0.45)), hsl(from ${brand} h s calc(l * 0.28)))`,
    ].join(", ");
  }, [brandColor]);

  const firstExample = usageExamples[0];

  return (
    <div className="pb-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-[13px]">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("extensions.tabs.plugins")}
        </button>
        <CaretRightIcon size={12} className="shrink-0 text-muted-foreground/60" />
        <span className="max-w-[280px] truncate text-foreground">{displayName}</span>
      </nav>

      <div className="mx-auto mt-7 flex w-full max-w-[860px] flex-col gap-9">
        {/* Header: icon, title + actions, tagline */}
        <div className="flex flex-col gap-5">
          <PluginIcon name={displayName} icon={entry.icon} brandColor={brandColor} size={76} />
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">{displayName}</h1>
                {isInstalled && <RuntimeStatusBadge status={installed!.runtimeStatus} />}
              </div>
              {tagline && (
                <p className="mt-1.5 text-[15px] text-muted-foreground">{tagline}</p>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {/* "…" menu */}
              <div className="relative" ref={menuRef}>
                <button
                  type="button"
                  aria-label={t("extensions.actions.more")}
                  onClick={() => setMenuOpen((v) => !v)}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground",
                    menuOpen && "bg-[var(--surface-hover)] text-foreground"
                  )}
                >
                  <DotsThreeIcon size={18} />
                </button>
                {menuOpen && (
                  <div
                    className="absolute right-0 top-full z-30 mt-1.5 w-52 rounded-[10px] border p-1"
                    style={{
                      backgroundColor: "var(--main-bg)",
                      borderColor: "var(--border)",
                      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                    }}
                  >
                    {isInstalled && (
                      <MenuRow
                        icon={installed!.enabled ? ProhibitIcon : PowerIcon}
                        label={t(installed!.enabled ? "settings.capabilities.actionDisable" : "settings.capabilities.actionEnable")}
                        disabled={busy}
                        onClick={() => {
                          setMenuOpen(false);
                          if (installed!.enabled) onDisable?.();
                          else onEnable?.();
                        }}
                      />
                    )}
                    {externalUrl && (
                      <MenuRow
                        icon={ExternalLinkIcon}
                        label={t("settings.capabilities.detailWebsite")}
                        onClick={() => {
                          setMenuOpen(false);
                          window.open(externalUrl, "_blank", "noopener,noreferrer");
                        }}
                      />
                    )}
                    {isInstalled && (
                      <MenuRow
                        icon={TrashIcon}
                        label={t("settings.capabilities.actionRemove")}
                        danger
                        disabled={busy}
                        onClick={() => {
                          setMenuOpen(false);
                          onRemove?.();
                        }}
                      />
                    )}
                  </div>
                )}
              </div>

              {/* Copy install path */}
              {isInstalled && installed!.installPath && (
                <Button variant="secondary" size="sm" onClick={() => void handleCopyPath()}>
                  {pathCopied ? (
                    <CheckIcon size={14} className="text-emerald-500" />
                  ) : (
                    <CopyIcon size={14} />
                  )}
                  {pathCopied
                    ? t("settings.capabilities.detailPathCopied")
                    : t("settings.capabilities.detailCopyPath")}
                </Button>
              )}

              {/* Primary action */}
              <Button variant="primary" size="sm" disabled={busy} onClick={primaryAction}>
                {busy ? (
                  <SpinnerGapIcon size={14} className="animate-spin" />
                ) : (
                  isInstalled && installed!.enabled && <ArrowRightIcon size={14} />
                )}
                {primaryLabel}
              </Button>
            </div>
          </div>
        </div>

        {/* Hero banner with the usage-example prompt cards */}
        {firstExample && (
          <div
            className="flex w-full justify-center overflow-hidden rounded-2xl px-4 py-8 sm:px-6"
            style={{ background: heroBackground }}
          >
            <div className="flex w-full max-w-xl flex-col gap-2.5">
              {usageExamples.map((example, idx) => (
                <div
                  key={idx}
                  role="button"
                  tabIndex={0}
                  title={t("settings.capabilities.detailSendPrompt")}
                  onClick={() => launchExample(example.prompt)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      launchExample(example.prompt);
                    }
                  }}
                  className="group/hero flex w-full cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 shadow-md outline-none transition-transform hover:scale-[1.01] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  style={{
                    backgroundColor: "color-mix(in srgb, var(--main-bg) 85%, transparent)",
                    borderColor: "color-mix(in srgb, var(--foreground) 8%, transparent)",
                    backdropFilter: "blur(10px)",
                  }}
                >
                  <PluginIcon name={displayName} icon={entry.icon} brandColor={brandColor} size={24} />
                  <p className="line-clamp-2 min-w-0 flex-1 text-sm leading-6">
                    <span className="font-semibold text-foreground">{displayName}</span>{" "}
                    <span className="text-muted-foreground">{example.prompt}</span>
                  </p>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-white transition-[filter] group-hover/hero:brightness-110">
                    <ArrowRightIcon size={16} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Long description */}
        {detailDescription && detailDescription !== tagline && (
          <p className="text-[15px] leading-7 text-muted-foreground">{detailDescription}</p>
        )}

        {/* What's included */}
        {componentRows.length > 0 && (
          <section className="space-y-3">
            <SectionHeader title={t("settings.capabilities.detailIncludes")} count={componentRows.length} />
            <div>
              {componentRows.map((row) => {
                const inner = (
                  <>
                    <span
                      className={cn(
                        "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] text-sm font-semibold",
                        getKindIconClass(row.kind)
                      )}
                    >
                      {getKindFirstLetter(row.kind)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{row.title}</span>
                        <span className="rounded bg-[var(--chip)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {row.kindLabel}
                        </span>
                      </div>
                      {row.description && (
                        <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{row.description}</p>
                      )}
                      {row.tools && row.tools.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {row.tools.map((tool) => (
                            <span
                              key={tool.name}
                              title={tool.description ?? undefined}
                              className="rounded-md border border-[var(--border)] bg-[var(--chip)] px-2 py-0.5 text-xs text-muted-foreground"
                            >
                              {tool.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                );
                return row.onClick ? (
                  <button
                    key={row.id}
                    type="button"
                    onClick={row.onClick}
                    className="flex w-full items-start gap-3.5 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
                  >
                    {inner}
                  </button>
                ) : (
                  <div key={row.id} className="flex items-start gap-3.5 px-2 py-2.5">
                    {inner}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Connected accounts — plugin-declared app connectors */}
        {showAccounts && (
          <section className="space-y-3">
            <SectionHeader title={t("settings.capabilities.detailConnectedAccounts")} />
            <div
              className="overflow-hidden rounded-2xl border"
              style={{ borderColor: "color-mix(in srgb, var(--foreground) 10%, transparent)" }}
            >
              {pluginConnections.map((conn, idx) => {
                const providerMeta =
                  resolvedProviders.find((p) => p.id === conn.provider) ?? null;
                const providerLabel = providerMeta?.label ?? conn.provider;
                const needsAttention =
                  conn.status === "expired" ||
                  conn.status === "revoked" ||
                  conn.status === "error";
                return (
                  <div
                    key={conn.id}
                    className={cn(
                      "flex items-center gap-3 px-4 py-3",
                      idx > 0 && "border-t border-[var(--border)]"
                    )}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-hover)]">
                      <ConnectorIcon
                        provider={conn.provider}
                        size={20}
                        monogram={providerMeta?.monogram}
                        label={providerMeta?.label}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-foreground">
                        {conn.accountLabel || providerLabel}
                      </div>
                      <div
                        className={cn(
                          "mt-0.5 truncate text-[13px]",
                          needsAttention ? "text-amber-500" : "text-muted-foreground"
                        )}
                      >
                        {needsAttention
                          ? `${providerLabel} · ${connectionStatusLabel(conn.status)}`
                          : providerLabel}
                      </div>
                      {needsAttention && conn.lastError && (
                        <div className="mt-0.5 truncate text-xs text-muted-foreground/70">
                          {conn.lastError}
                        </div>
                      )}
                    </div>
                    <div className="relative" data-conn-menu>
                      <button
                        type="button"
                        aria-label={t("settings.capabilities.detailAccountOptions")}
                        onClick={() =>
                          setOpenConnMenuId((current) =>
                            current === conn.id ? null : conn.id
                          )
                        }
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground"
                      >
                        <DotsThreeIcon size={16} />
                      </button>
                      {openConnMenuId === conn.id && (
                        <div
                          className="absolute right-0 top-full z-30 mt-1.5 w-44 rounded-[10px] border p-1"
                          style={{
                            backgroundColor: "var(--main-bg)",
                            borderColor: "var(--border)",
                            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                          }}
                        >
                          <MenuRow
                            icon={PlugIcon}
                            label={t("extensions.actions.disconnect")}
                            onClick={() => {
                              setOpenConnMenuId(null);
                              onDisconnectConnection?.(conn.id);
                            }}
                          />
                          <MenuRow
                            icon={TrashIcon}
                            label={t("extensions.actions.remove")}
                            danger
                            onClick={() => {
                              setOpenConnMenuId(null);
                              onRemoveConnection?.(conn.id);
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {onConnectProvider && resolvedProviders.length > 0 && (
                <button
                  type="button"
                  onClick={() => onConnectProvider(resolvedProviders[0])}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]",
                    pluginConnections.length > 0 && "border-t border-[var(--border)]"
                  )}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-muted-foreground">
                    <PlusIcon size={16} />
                  </span>
                  <span className="text-sm font-medium text-foreground">
                    {t("settings.capabilities.detailConnectAnother")}
                  </span>
                </button>
              )}
            </div>
          </section>
        )}

        {/* Setup configuration — only renders when the plugin manifest declares
            setup fields (text/secret/path/url). app-connection fields are
            filtered out by the main process and rendered via the OAuth UI. */}
        {isInstalled && setupFields.length > 0 && (
          <section className="space-y-3">
            <SectionHeader title={t("settings.capabilities.detailSetup")} />
            <p className="text-sm text-muted-foreground">
              {t("settings.capabilities.detailSetupDesc")}
            </p>
            {setupLoading ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-muted-foreground">
                {t("extensions.loading")}
              </div>
            ) : (
              <div className="space-y-3">
                {setupFields.map((field) => {
                  const value = setupFormValues[field.id] ?? "";
                  const inputType =
                    field.type === "secret" ? "password" :
                    field.type === "url" ? "url" :
                    "text";
                  const placeholder =
                    field.type === "secret"
                      ? "Enter a new value to replace the stored secret"
                      : field.type === "url"
                        ? "https://example.com"
                        : field.type === "path"
                          ? "/path/to/resource"
                          : "";
                  return (
                    <div key={field.id} className="space-y-1">
                      <label
                        htmlFor={`setup-${field.id}`}
                        className="flex items-center gap-1 text-sm text-foreground"
                      >
                        <span>{field.label}</span>
                        {field.required && (
                          <span className="text-xs text-muted-foreground">*</span>
                        )}
                        <span className="ml-1 rounded bg-[var(--chip)] px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                          {field.type}
                        </span>
                      </label>
                      <input
                        id={`setup-${field.id}`}
                        type={inputType}
                        value={value}
                        onChange={(e) =>
                          setSetupFormValues((prev) => ({
                            ...prev,
                            [field.id]: e.target.value,
                          }))
                        }
                        placeholder={placeholder}
                        autoComplete="off"
                        spellCheck={false}
                        className="w-full rounded-lg border border-border/50 bg-background/60 px-3 py-2 text-sm text-foreground outline-none focus:border-accent/50"
                      />
                    </div>
                  );
                })}
                {setupError && (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/[0.05] px-3 py-2 text-xs leading-5 text-red-500">
                    {setupError}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={setupSaving}
                    onClick={() => void handleSetupSave()}
                  >
                    {t("settings.capabilities.setup.save")}
                  </Button>
                  {setupSavedFlash && (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                      <CheckIcon size={14} />
                      {t("settings.capabilities.detailSaved")}
                    </span>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Plan 311 — Workflow Templates section */}
        {workflows.length > 0 && (
          <section className="space-y-3">
            <SectionHeader title={t("settings.capabilities.detailWorkflows")} count={workflows.length} />
            <p className="text-sm text-muted-foreground">
              {t("settings.capabilities.detailWorkflowsDesc")}
            </p>
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

        {/* Information */}
        <section className="space-y-3">
          <SectionHeader title={t("settings.capabilities.detailInfo")} />
          <dl className="space-y-3">
            <InfoRow label={t("settings.capabilities.detailDeveloper")}>
              {authorName}
            </InfoRow>
            {catalog?.category && (
              <InfoRow label={t("settings.capabilities.detailCategory")}>
                <span className="capitalize">{catalog.category}</span>
              </InfoRow>
            )}
            <InfoRow label={t("settings.capabilities.detailVersion")}>
              v{entry.version}
            </InfoRow>
            <InfoRow label={t("settings.capabilities.detailSource")}>
              <span className="capitalize">{entry.source}</span>
            </InfoRow>
            {externalUrl && externalDomain && (
              <InfoRow label={t("settings.capabilities.detailWebsite")}>
                <a
                  href={externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-foreground transition-colors hover:text-[var(--accent)]"
                >
                  {externalDomain}
                  <ArrowUpRightIcon size={13} className="text-muted-foreground" />
                </a>
              </InfoRow>
            )}
            <InfoRow label={t("settings.capabilities.detailPluginId")}>
              <code className="break-all font-mono text-xs text-muted-foreground">{entry.id}</code>
            </InfoRow>
          </dl>
        </section>

        {/* Technical details (collapsible) */}
        {(isInstalled || permissions.length > 0) && (
          <section className="space-y-2">
            <button
              type="button"
              onClick={() => setTechExpanded((v) => !v)}
              className="flex w-full items-center justify-between rounded-lg px-1 py-1 text-left"
            >
              <span className="text-[13px] font-medium text-muted-foreground">
                {t("settings.capabilities.detailTechnical")}
              </span>
              {techExpanded ? (
                <ChevronUpIcon size={15} className="text-muted-foreground" />
              ) : (
                <ChevronDownIcon size={15} className="text-muted-foreground" />
              )}
            </button>

            {techExpanded && (
              <div className="space-y-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
                {/* Runtime — only for installed plugins */}
                {isInstalled && (
                  <div className="space-y-2.5">
                    <h4 className="text-sm font-semibold text-foreground">
                      {t("settings.capabilities.detailRuntime")}
                    </h4>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted-foreground">{t("settings.capabilities.detailStatus")}</span>
                      <RuntimeStatusBadge status={installed!.runtimeStatus} />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted-foreground">{t("settings.capabilities.detailEnabledRow")}</span>
                      <span className={cn(
                        "text-sm font-medium",
                        installed!.enabled ? "text-emerald-600" : "text-muted-foreground"
                      )}>
                        {installed!.enabled ? t("settings.capabilities.detailYes") : t("settings.capabilities.detailNo")}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted-foreground">{t("settings.capabilities.detailSetup")}</span>
                      <span className="text-sm text-foreground">
                        {installed!.setupRequired
                          ? t("settings.capabilities.detailSetupRequired")
                          : t("settings.capabilities.detailSetupComplete")}
                      </span>
                    </div>
                    {hasIssues && (
                      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
                        <span className="inline-flex items-center gap-1">
                          <WarningIcon size={14} />
                          {t("settings.capabilities.detailAttention")}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Permissions */}
                {permissions.length > 0 && (
                  <div className="space-y-2.5">
                    <h4 className="text-sm font-semibold text-foreground">
                      {t("settings.capabilities.detailPermissions")}
                    </h4>
                    <div className="space-y-2">
                      {permissions.map((perm) => (
                        <div
                          key={perm.id}
                          className="rounded-xl border border-[var(--border)] bg-[var(--main-bg)] px-3 py-3"
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
                              {perm.enabled
                                ? t("settings.capabilities.permissions.granted")
                                : t("settings.capabilities.detailPermissionNotGranted")}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Data-use disclaimer */}
        <p className="border-t border-[var(--border)] pt-5 text-xs leading-5 text-muted-foreground">
          {t("settings.capabilities.detailDisclaimer", { name: displayName })}
        </p>
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
  const { t } = useTranslation();
  const tierDisplay = getPermissionTierDisplay(workflow.permissionTier);
  const effectiveTier = bumpPermissionTier(workflow.permissionTier);
  const requiresConfirmation = tierRequiresConfirmation(effectiveTier);
  const requiresExplicit = tierRequiresExplicitConfirmation(effectiveTier);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
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
            {launchLoading ? (
              <SpinnerGapIcon size={14} className="animate-spin" />
            ) : (
              <>
                {t("settings.capabilities.detailWorkflowLaunch")}
                <ArrowRightIcon size={14} />
              </>
            )}
          </Button>
        )}
      </div>

      {/* Launch panel — visible when launching */}
      {isLaunching && (
        <div className="mt-3 space-y-3 border-t border-[var(--border)] pt-3">
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
                    className="rounded border border-[var(--border)] bg-[var(--main-bg)] px-2 py-0.5 text-xs font-mono text-foreground/70"
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
              {t("settings.capabilities.detailTierWarning", { tier: tierDisplay.label })}{" "}
              {requiresExplicit
                ? t("settings.capabilities.detailTierConfirmHint")
                : t("settings.capabilities.detailTierReviewHint")}
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
              <span>{t("settings.capabilities.detailTierDangerConfirm")}</span>
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
              {t("settings.capabilities.detailTierStart")}
              <ArrowRightIcon size={14} />
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("settings.capabilities.detailCancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
