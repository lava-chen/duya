"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useTranslation } from "@/hooks/useTranslation";
import { getPluginAPI } from "@/lib/plugin-ipc";
import { getAppConnectionAPI } from "@/lib/app-connection-ipc";
import {
  fetchMCPInventorySnapshot,
  hasMCPInventoryAPI,
} from "@/lib/mcp-inventory-ipc";
import type {
  MCPInventorySnapshotDTO,
  MCPPluginDeclaredServerDTO,
} from "@/lib/mcp-inventory-types";
import type {
  PluginCatalogEntry,
  PluginRegistryEntry,
} from "@/lib/plugin-types";
import type {
  AppConnectionStatusDTO,
  AppConnectionProviderDTO,
  ProviderId,
} from "@/lib/app-connection-ipc";
import type { MCPServerConfig } from "@/types";
import { useSettings } from "@/hooks/useSettings";
import { useConversationStore } from "@/stores/conversation-store";
import { ExtensionsTabs, type ExtensionTab } from "./ExtensionsTabs";
import { PluginsSubPage } from "./PluginsSubPage";
import { ConnectionsSubPage } from "./ConnectionsSubPage";
import { OAuthClientSetupDialog } from "./OAuthClientSetupDialog";
import { ManagedOAuthConnectDialog } from "./ManagedOAuthConnectDialog";
import { MCPSubPage } from "./MCPSubPage";
import { SkillsSubPage, type SkillSummary } from "./SkillsSubPage";
import { MarketplaceModal } from "./MarketplaceModal";
import { PluginDetailView } from "@/components/settings/capabilities/PluginDetailView";
import { PlugIcon, PlusIcon, ChatCircleIcon, FileIcon } from "@/components/icons";
import {
  ArrowLeftIcon,
  EyeIcon,
  CodeIcon,
  InfoIcon,
  DotsThreeIcon,
  CaretDownIcon,
  ShieldIcon,
  WarningIcon,
  ProhibitIcon,
  SpinnerGapIcon,
} from "@/components/icons";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { SkillUploadDialog } from "./SkillUploadDialog";

interface SkillFileNode {
  name: string;
  path: string;
  type: "directory" | "file";
  extension?: string;
  children?: SkillFileNode[];
}

interface SkillDetailData extends SkillSummary {
  content: string;
  skillRoot?: string;
  frontmatter?: Record<string, unknown>;
  security?: {
    verdict: "safe" | "caution" | "dangerous";
    findings: Array<{ severity: string; category: string; description: string; match?: string }>;
    scanned: boolean;
  };
}

function SkillDetailPanel({
  skill,
  onBack,
  onToggleEnabled,
}: {
  skill: SkillDetailData;
  onBack: () => void;
  onToggleEnabled: (skillName: string, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [activeFile, setActiveFile] = useState<string>("SKILL.md");
  const [fileTree, setFileTree] = useState<SkillFileNode[]>([]);
  const [fileContent, setFileContent] = useState<string>(skill.content);
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const skillRoot = skill.skillRoot;
    if (!skillRoot) return;

    const loadFiles = async () => {
      const win = window as unknown as {
        electronAPI?: { files?: { browse: (dir: string) => Promise<{ success: boolean; tree: SkillFileNode[] }> } };
      };
      if (!win.electronAPI?.files?.browse) return;
      const result = await win.electronAPI.files.browse(skillRoot);
      if (result.success) {
        setFileTree(result.tree);
      }
    };

    setActiveFile("SKILL.md");
    setViewMode("preview");
    setFileContent(skill.content);
    void loadFiles();
  }, [skill.skillRoot, skill.name, skill.content]);

  useEffect(() => {
    const skillRoot = skill.skillRoot;
    if (!skillRoot) return;

    if (activeFile === "SKILL.md") {
      setFileContent(skill.content);
      return;
    }

    const loadContent = async () => {
      setLoadingFile(true);
      const win = window as unknown as {
        electronAPI?: {
          files?: {
            preview: (
              targetPath: string,
              rootPath: string,
            ) => Promise<{ success: boolean; content?: string; kind?: string; error?: string }>;
          };
        };
      };
      if (!win.electronAPI?.files?.preview) {
        setLoadingFile(false);
        return;
      }
      const targetPath = `${skillRoot}/${activeFile}`;
      const result = await win.electronAPI.files.preview(targetPath, skillRoot);
      if (result.success && typeof result.content === "string") {
        setFileContent(result.content);
      } else {
        setFileContent(result.error || "Failed to load file");
      }
      setLoadingFile(false);
    };

    void loadContent();
  }, [activeFile, skill.skillRoot, skill.content]);

  const allFiles = useMemo(() => {
    const files: { name: string; path: string }[] = [];
    const walk = (nodes: SkillFileNode[]) => {
      for (const node of nodes) {
        if (node.type === "file") files.push({ name: node.name, path: node.path });
        if (node.children) walk(node.children);
      }
    };
    walk(fileTree);
    return files;
  }, [fileTree]);

  const fileCount = useMemo(() => allFiles.length, [allFiles]);

  const isEnabled = skill.enabled !== false;
  const author = (skill.frontmatter?.author as string | undefined) || undefined;

  const description = skill.description || "";
  const DESCRIPTION_TRUNCATE_AT = 180;
  const shouldTruncate = description.length > DESCRIPTION_TRUNCATE_AT;
  const displayedDescription = descriptionExpanded
    ? description
    : `${description.slice(0, DESCRIPTION_TRUNCATE_AT)}${shouldTruncate ? "..." : ""}`;

  const securityStatus = useMemo(() => {
    if (!skill.security?.scanned) return null;
    if (skill.source === "bundled" || skill.source === "builtin-directory") {
      return { label: t("skills.trustedBuiltin"), variant: "safe" as const };
    }
    if (skill.security.verdict === "dangerous") {
      return { label: t("skills.blocked"), variant: "dangerous" as const };
    }
    if (skill.security.verdict === "caution") {
      return { label: t("skills.caution"), variant: "caution" as const };
    }
    return { label: t("skills.safe"), variant: "safe" as const };
  }, [skill.security, skill.source, t]);

  const activeFileName = allFiles.find((f) => f.path === activeFile)?.name || activeFile;

  return (
    <div className="space-y-5">
      {/* Back link */}
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-2 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)] transition-colors"
      >
        <ArrowLeftIcon size={18} />
        <span>{t("extensions.tabs.skills")}</span>
      </button>

      {/* Title row */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-xl font-semibold text-foreground">{skill.name}</h2>
            <InfoIcon size={18} className="text-muted-foreground shrink-0" />
          </div>
          {author && <p className="text-sm text-muted-foreground">by {author}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            role="switch"
            aria-checked={isEnabled}
            onClick={() => onToggleEnabled(skill.name, !isEnabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--main-bg)] ${
              isEnabled ? "bg-[var(--success)]" : "bg-[var(--muted)]"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                isEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
          <button
            type="button"
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            aria-label="More options"
          >
            <DotsThreeIcon size={20} />
          </button>
        </div>
      </div>

      {/* Description */}
      <div>
        <p className="text-sm text-muted-foreground leading-relaxed inline">{displayedDescription}</p>
        {shouldTruncate && (
          <button
            type="button"
            onClick={() => setDescriptionExpanded((v) => !v)}
            className="text-sm text-[var(--accent)] hover:underline ml-1"
          >
            {descriptionExpanded ? "See less" : "See more"}
          </button>
        )}
      </div>

      {/* Security status */}
      {securityStatus && (
        <div className="flex items-center gap-2">
          {securityStatus.variant === "safe" ? (
            <ShieldIcon size={16} className="text-emerald-500" />
          ) : securityStatus.variant === "dangerous" ? (
            <ProhibitIcon size={16} className="text-red-500" />
          ) : (
            <WarningIcon size={16} className="text-amber-500" />
          )}
          <span
            className={`text-xs font-medium ${
              securityStatus.variant === "safe"
                ? "text-emerald-500"
                : securityStatus.variant === "dangerous"
                ? "text-red-500"
                : "text-amber-500"
            }`}
          >
            {securityStatus.label}
          </span>
          {skill.security && skill.security.findings.length > 0 && (
            <span className="text-xs text-muted-foreground">
              ({skill.security.findings.length} {t("skills.securityFindings", { count: skill.security.findings.length })})
            </span>
          )}
        </div>
      )}

      {/* File viewer panel */}
      <div className="rounded-xl border border-border/50 bg-muted/20 overflow-hidden">
        {/* Panel header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 bg-muted/30">
          <div className="flex items-center gap-3">
            <div className="relative" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setDropdownOpen((v) => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface border border-border/50 text-sm text-foreground hover:bg-muted/40 transition-colors"
              >
                <span className="truncate max-w-[160px]">{activeFileName}</span>
                <CaretDownIcon
                  size={14}
                  className={`text-muted-foreground transition-transform shrink-0 ${dropdownOpen ? "rotate-180" : ""}`}
                />
              </button>
              {dropdownOpen && (
                <div className="absolute top-full left-0 mt-1 min-w-[180px] max-h-60 overflow-y-auto rounded-lg border border-border/50 bg-[var(--main-bg)] shadow-lg z-20">
                  {allFiles.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => {
                        setActiveFile(file.path);
                        setDropdownOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/40 transition-colors ${
                        file.path === activeFile ? "bg-muted/50 text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {file.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className="text-xs text-muted-foreground">{fileCount} files</span>
          </div>
          <div className="flex items-center rounded-lg border border-border/50 bg-surface p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("preview")}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === "preview"
                  ? "bg-muted/60 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              aria-label="Preview"
            >
              <EyeIcon size={16} />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("code")}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === "code"
                  ? "bg-muted/60 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              aria-label="Code"
            >
              <CodeIcon size={16} />
            </button>
          </div>
        </div>

        {/* Panel content */}
        <div className="p-4 min-h-[300px] max-h-[60vh] overflow-y-auto">
          {loadingFile ? (
            <div className="flex items-center justify-center py-12">
              <SpinnerGapIcon size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : viewMode === "code" ? (
            <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-all">{fileContent}</pre>
          ) : (
            <MarkdownRenderer className="prose prose-sm dark:prose-invert max-w-none">
              {fileContent}
            </MarkdownRenderer>
          )}
        </div>
      </div>
    </div>
  );
}

export function ExtensionsPage() {
  const { t } = useTranslation();
  const { settings, save } = useSettings();
  const createThread = useConversationStore((s) => s.createThread);
  const setActiveThread = useConversationStore((s) => s.setActiveThread);
  const setCurrentView = useConversationStore((s) => s.setCurrentView);

  const [activeTab, setActiveTab] = useState<ExtensionTab>("plugins");
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [detailPluginId, setDetailPluginId] = useState<string | null>(null);
  const [
    marketplaceDetailPlugin,
    setMarketplaceDetailPlugin,
  ] = useState<PluginCatalogEntry | null>(null);

  // ── Data state ──
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<PluginRegistryEntry[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(true);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);

  const [connections, setConnections] = useState<AppConnectionStatusDTO[]>([]);
  const [connectionProviders, setConnectionProviders] = useState<AppConnectionProviderDTO[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<ProviderId | null>(null);
  const [connectionSetupProvider, setConnectionSetupProvider] = useState<AppConnectionProviderDTO | null>(null);
  const [connectionSetupError, setConnectionSetupError] = useState<string | null>(null);
  const [managedConnectionProvider, setManagedConnectionProvider] = useState<AppConnectionProviderDTO | null>(null);

  const [
    mcpInventory,
    setMcpInventory,
  ] = useState<MCPInventorySnapshotDTO | null>(null);
  const [mcpLoading, setMcpLoading] = useState(true);

  const [skills, setSkills] = useState<SkillDetailData[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetailData | null>(null);

  // ── Skill add menu / upload dialog ──
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillUploadOpen, setSkillUploadOpen] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const skillMenuRef = useRef<HTMLDivElement>(null);

  // Search per tab
  const [
    searchByTab,
    setSearchByTab,
  ] = useState<Record<ExtensionTab, string>>({
    plugins: "",
    connections: "",
    mcp: "",
    skills: "",
  });

  const pluginApi = useMemo(() => getPluginAPI(), []);
  const appConnectionApi = useMemo(() => getAppConnectionAPI(), []);
  const mcpInventoryAvailable = useMemo(() => hasMCPInventoryAPI(), []);

  // ── Data loaders ──
  const reloadPlugins = useCallback(async () => {
    if (!pluginApi) {
      setPluginsLoading(false);
      return;
    }
    setPluginsLoading(true);
    setPluginsError(null);
    try {
      const [catalogRes, installedRes] = await Promise.allSettled([
        pluginApi.catalog.list(),
        pluginApi.registry.list(),
      ]);
      if (catalogRes.status === "fulfilled" && catalogRes.value.success) {
        setCatalog(catalogRes.value.data);
      } else if (catalogRes.status === "fulfilled") {
        setPluginsError(catalogRes.value.error ?? t("extensions.error"));
      }
      if (installedRes.status === "fulfilled" && installedRes.value.success) {
        setInstalled(installedRes.value.data);
      }
    } catch (err) {
      setPluginsError(err instanceof Error ? err.message : String(err));
    } finally {
      setPluginsLoading(false);
    }
  }, [pluginApi, t]);

  const reloadConnections = useCallback(async () => {
    if (!appConnectionApi) {
      // In the browser dev server the app connection API is not exposed;
      // silently return an empty list so the UI renders without an error.
      setConnections([]);
      setConnectionsLoading(false);
      return;
    }
    setConnectionsLoading(true);
    setConnectionsError(null);
    try {
      const [connectionsRes, providersRes] = await Promise.all([
        appConnectionApi.list(),
        appConnectionApi.providers(),
      ]);
      if (connectionsRes.success) setConnections(connectionsRes.data ?? []);
      else setConnectionsError(connectionsRes.error ?? t("extensions.error"));
      if (providersRes.success) setConnectionProviders(providersRes.data ?? []);
      else setConnectionsError(providersRes.error ?? t("extensions.error"));
    } catch (err) {
      setConnectionsError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectionsLoading(false);
    }
  }, [appConnectionApi, t]);

  const reloadMcp = useCallback(async () => {
    if (!mcpInventoryAvailable) {
      setMcpLoading(false);
      return;
    }
    try {
      const snap = await fetchMCPInventorySnapshot();
      setMcpInventory(snap);
    } catch {
      setMcpInventory(null);
    } finally {
      setMcpLoading(false);
    }
  }, [mcpInventoryAvailable]);

  const reloadSkills = useCallback(async () => {
    const win = window as unknown as {
      electronAPI?: {
        skills?: {
          list: () => Promise<{
            success: boolean;
            skills: SkillDetailData[];
            error?: string;
          }>;
        };
      };
    };
    if (!win.electronAPI?.skills?.list) {
      setSkillsLoading(false);
      return;
    }
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const res = await win.electronAPI.skills.list();
      if (res.success) setSkills(res.skills);
      else setSkillsError(res.error ?? t("extensions.error"));
    } catch (err) {
      setSkillsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSkillsLoading(false);
    }
  }, [t]);

  const reloadAll = useCallback(async () => {
    await Promise.allSettled([
      reloadPlugins(),
      reloadConnections(),
      reloadMcp(),
      reloadSkills(),
    ]);
  }, [reloadPlugins, reloadConnections, reloadMcp, reloadSkills]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  // ── Skill add menu: close on outside click or Escape ──
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        skillMenuRef.current &&
        !skillMenuRef.current.contains(event.target as Node)
      ) {
        setSkillMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSkillMenuOpen(false);
      }
    };

    if (skillMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [skillMenuOpen]);

  // Clear upload success message after a few seconds
  useEffect(() => {
    if (!uploadSuccess) return;
    const timeout = setTimeout(() => setUploadSuccess(null), 3000);
    return () => clearTimeout(timeout);
  }, [uploadSuccess]);

  // ── Plugin mutations ──
  const runPluginAction = useCallback(
    async (
      pluginId: string,
      action: () => Promise<{ success: boolean; error?: string }>
    ) => {
      setBusyPluginId(pluginId);
      const res = await action();
      if (!res.success) setPluginsError(res.error ?? t("extensions.actionFailed"));
      await reloadPlugins();
      setBusyPluginId(null);
    },
    [reloadPlugins, t]
  );

  const handleCreatePlugin = useCallback(async () => {
    try {
      const thread = await createThread();
      if (thread) {
        setActiveThread(thread.id);
        setCurrentView("chat");
      }
    } catch {
      void 0;
    }
  }, [createThread, setActiveThread, setCurrentView]);

  // ── Connection mutations ──
  const handleConnect = useCallback(
    async (provider: ProviderId, scopes?: string[]) => {
      if (!appConnectionApi) {
        setConnectionsError(t("extensions.connections.requiresElectron"));
        return;
      }
      setBusyProvider(provider);
      try {
        const res = await appConnectionApi.connect({ provider, scopes });
        if (!res.success) {
          setConnectionsError(res.error ?? t("extensions.connections.connectFailed"));
          return;
        }
        if (res.data) {
          // Optimistically surface the new connection so the UI flips to
          // "connected" immediately when the user returns to Duya.
          setConnections((prev) => [
            res.data!,
            ...prev.filter((c) => c.provider !== res.data!.provider),
          ]);
        }
      } catch (err) {
        setConnectionsError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyProvider(null);
        void reloadConnections();
      }
    },
    [appConnectionApi, reloadConnections, t]
  );

  const requestConnection = useCallback(
    (provider: AppConnectionProviderDTO) => {
      if (provider.supportsManualConfiguration) {
        void handleConnect(provider.id);
        return;
      }
      setManagedConnectionProvider(provider);
    },
    [handleConnect],
  );

  const handleDisconnect = useCallback(
    async (connectionId: string) => {
      if (!appConnectionApi) {
        setConnectionsError(t("extensions.connections.requiresElectron"));
        return;
      }
      try {
        const res = await appConnectionApi.disconnect(connectionId);
        if (!res.success) {
          setConnectionsError(res.error ?? t("extensions.connections.disconnectFailed"));
        }
      } catch (err) {
        setConnectionsError(err instanceof Error ? err.message : String(err));
      } finally {
        void reloadConnections();
      }
    },
    [appConnectionApi, reloadConnections, t]
  );

  const handleConfigureProvider = useCallback(
    async (values: { clientId: string; clientSecret?: string }) => {
      const provider = connectionSetupProvider;
      if (!provider || !appConnectionApi) return;
      setBusyProvider(provider.id);
      setConnectionSetupError(null);
      try {
        const result = await appConnectionApi.configureProvider({
          provider: provider.id,
          clientId: values.clientId,
          clientSecret: values.clientSecret,
        });
        if (!result.success) {
          setConnectionSetupError(result.error ?? t("extensions.connections.connectFailed"));
          return;
        }
        setConnectionSetupProvider(null);
        await reloadConnections();
        await handleConnect(provider.id);
      } catch (err) {
        setConnectionSetupError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyProvider(null);
      }
    },
    [appConnectionApi, connectionSetupProvider, handleConnect, reloadConnections, t]
  );

  // ── MCP mutations ──
  const mcpServers: MCPServerConfig[] = useMemo(() => {
    const fromSettings = settings.mcpServers ?? [];
    // The inventory intentionally redacts spawn details. Keep the TOML-backed
    // settings list as the editable source so a save cannot destroy it.
    return fromSettings.map((s) => ({
      name: s.name,
      command: s.command,
      args: s.args ?? [],
      env: s.env ?? {},
      enabled: s.enabled !== false,
    }));
  }, [mcpInventory, settings.mcpServers]);

  const pluginMCPs: MCPPluginDeclaredServerDTO[] =
    mcpInventory?.pluginDeclaredServers ?? [];

  const handleMcpToggle = useCallback(
    async (server: MCPServerConfig) => {
      const newServers = mcpServers.map((s) =>
        s.name === server.name ? { ...s, enabled: !s.enabled } : s
      );
      await save({ mcpServers: newServers });
      void reloadMcp();
    },
    [mcpServers, save, reloadMcp]
  );

  const handleMcpDelete = useCallback(
    async (name: string) => {
      const newServers = mcpServers.filter((s) => s.name !== name);
      await save({ mcpServers: newServers });
      void reloadMcp();
    },
    [mcpServers, save, reloadMcp]
  );

  const handleToggleSkill = useCallback(
    async (skillName: string, enabled: boolean) => {
      const win = window as unknown as {
        electronAPI?: {
          skills?: {
            setEnabled: (name: string, value: boolean) => Promise<{ success: boolean; error?: string }>;
          };
        };
      };
      if (!win.electronAPI?.skills?.setEnabled) return;
      const res = await win.electronAPI.skills.setEnabled(skillName, enabled);
      if (!res.success) setSkillsError(res.error ?? t("extensions.actionFailed"));
      void reloadSkills();
    },
    [reloadSkills, t]
  );

  // ── Plugin detail view ──
  const detailPlugin = useMemo(() => {
    if (!detailPluginId) return null;
    return installed.find((p) => p.id === detailPluginId) ?? null;
  }, [detailPluginId, installed]);

  const detailCatalog = useMemo(() => {
    if (!detailPluginId) return null;
    return catalog.find((c) => c.id === detailPluginId) ?? null;
  }, [detailPluginId, catalog]);

  // ── Counts ──
  const counts: Record<ExtensionTab, number> = {
    plugins: installed.length,
    connections: connections.filter((c) => c.status === "connected").length,
    mcp: mcpServers.length + pluginMCPs.length,
    skills: skills.length,
  };

  const searchPlaceholder = useMemo(() => {
    const map: Record<ExtensionTab, string> = {
      plugins: "extensions.search.plugins",
      connections: "extensions.search.connections",
      mcp: "extensions.search.mcp",
      skills: "extensions.search.skills",
    };
    return t(map[activeTab] as never);
  }, [activeTab, t]);

  // ── Plugin detail inline view ──
  if (detailPlugin) {
    return (
      <div className="settings-page-content">
        <div className="settings-content">
          <PluginDetailView
            installed={detailPlugin}
            catalog={detailCatalog}
            onBack={() => setDetailPluginId(null)}
            onEnable={() =>
              void runPluginAction(detailPlugin.id, () =>
                pluginApi!.registry.enable(detailPlugin.id)
              )
            }
            onDisable={() =>
              void runPluginAction(detailPlugin.id, () =>
                pluginApi!.registry.disable(detailPlugin.id)
              )
            }
            onRemove={() =>
              void runPluginAction(detailPlugin.id, () =>
                pluginApi!.registry.remove({
                  pluginId: detailPlugin.id,
                  deleteData: false,
                })
              )
            }
            busy={busyPluginId === detailPlugin.id}
          />
        </div>
      </div>
    );
  }

  // ── Marketplace plugin detail inline view ──
  if (marketplaceDetailPlugin) {
    return (
      <div className="settings-page-content">
        <div className="settings-content">
          <PluginDetailView
            catalog={marketplaceDetailPlugin}
            onBack={() => setMarketplaceDetailPlugin(null)}
            onInstall={() =>
              void runPluginAction(marketplaceDetailPlugin.id, () =>
                pluginApi!.registry.install({ pluginId: marketplaceDetailPlugin.id })
              )
            }
            busy={busyPluginId === marketplaceDetailPlugin.id}
          />
        </div>
      </div>
    );
  }

  // ── Skill detail view ──
  if (selectedSkill) {
    return (
      <div className="settings-page-content">
        <div className="settings-content">
          <SkillDetailPanel
            skill={selectedSkill}
            onBack={() => setSelectedSkill(null)}
            onToggleEnabled={handleToggleSkill}
          />
        </div>
      </div>
    );
  }

  // ── Main render ──
  const isLoading =
    pluginsLoading && connectionsLoading && mcpLoading && skillsLoading;

  return (
    <div className="settings-page-content">
      <div className="settings-content">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-[1.15rem] font-bold tracking-tight text-foreground">
              {t("settings.extensions" as never)}
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {t("settings.extensions.description" as never)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setMarketplaceOpen(true)}
            >
              <PlugIcon size={14} />
              {t("marketplace.title" as never)}
            </Button>
          </div>
        </div>

        {/* Tabs + search + action */}
        <div className="flex items-center justify-between gap-4 mb-4">
          <ExtensionsTabs
            active={activeTab}
            onChange={setActiveTab}
            counts={counts}
          />
          <div className="flex items-center gap-2">
            {activeTab === "mcp" && (
              <Button variant="primary" size="sm" onClick={() => setMarketplaceOpen(true)}>
                <PlusIcon size={14} />
                {t("extensions.mcp.addServer")}
              </Button>
            )}
            {activeTab === "connections" && (
              <Button variant="secondary" size="sm" onClick={() => setMarketplaceOpen(true)}>
                <PlugIcon size={14} />
                {t("marketplace.title")}
              </Button>
            )}
            {activeTab === "skills" && (
              <div className="relative" ref={skillMenuRef}>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setSkillMenuOpen((prev) => !prev)}
                >
                  <PlusIcon size={14} />
                  {t("extensions.skills.addSkill")}
                </Button>
                {skillMenuOpen && (
                  <div
                    className="absolute right-0 top-full mt-1 w-56 rounded-[10px] shadow-lg border p-1 z-[100]"
                    style={{
                      backgroundColor: "var(--main-bg)",
                      borderColor: "var(--border)",
                      boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
                    }}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void handleCreatePlugin();
                        setSkillMenuOpen(false);
                      }}
                      className="w-full flex items-center justify-start gap-2.5 px-2.5 py-1.5 text-[12.5px] transition-colors rounded-md hover:bg-[var(--surface-hover)]"
                    >
                      <span style={{ color: "var(--muted)" }}>
                        <ChatCircleIcon size={14} />
                      </span>
                      <span style={{ color: "var(--foreground)" }}>
                        {t("extensions.skills.createInChat")}
                      </span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSkillUploadOpen(true);
                        setSkillMenuOpen(false);
                      }}
                      className="w-full flex items-center justify-start gap-2.5 px-2.5 py-1.5 text-[12.5px] transition-colors rounded-md hover:bg-[var(--surface-hover)]"
                    >
                      <span style={{ color: "var(--muted)" }}>
                        <FileIcon size={14} />
                      </span>
                      <span style={{ color: "var(--foreground)" }}>
                        {t("extensions.skills.uploadSkill")}
                      </span>
                    </Button>
                  </div>
                )}
              </div>
            )}
            {uploadSuccess && (
              <span className="text-xs text-emerald-600">{uploadSuccess}</span>
            )}
            <div className="w-64">
              <Input
                type="search"
                placeholder={searchPlaceholder}
                value={searchByTab[activeTab]}
                onChange={(e) =>
                  setSearchByTab((prev) => ({
                    ...prev,
                    [activeTab]: e.target.value,
                  }))
                }
                size="sm"
              />
            </div>
          </div>
        </div>

        {/* Error banner */}
        {(pluginsError || connectionsError || skillsError) && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/[0.05] px-4 py-2 text-xs text-amber-600">
            {pluginsError || connectionsError || skillsError}
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t("extensions.loading")}
          </div>
        )}

        {/* Sub-pages */}
        {!isLoading && activeTab === "plugins" && (
          <PluginsSubPage
            installed={installed}
            catalog={catalog}
            busyPluginId={busyPluginId}
            searchQuery={searchByTab.plugins}
            onPluginClick={(id) => setDetailPluginId(id)}
            onEnable={(id) =>
              void runPluginAction(id, () => pluginApi!.registry.enable(id))
            }
            onDisable={(id) =>
              void runPluginAction(id, () => pluginApi!.registry.disable(id))
            }
            onRemove={(id) =>
              void runPluginAction(id, () =>
                pluginApi!.registry.remove({ pluginId: id, deleteData: false })
              )
            }
            onCreatePlugin={handleCreatePlugin}
          />
        )}

        {!isLoading && activeTab === "connections" && (
          <ConnectionsSubPage
            connections={connections}
            providers={connectionProviders}
            busyProvider={busyProvider}
            searchQuery={searchByTab.connections}
            onConnect={requestConnection}
            onConfigure={(provider) => {
              setConnectionSetupError(null);
              setConnectionSetupProvider(provider);
            }}
            onDisconnect={handleDisconnect}          />
        )}

        {!isLoading && activeTab === "mcp" && (
          <MCPSubPage
            servers={mcpServers}
            pluginMCPs={pluginMCPs}
            searchQuery={searchByTab.mcp}
            onAdd={() => {
              // MCP add/edit dialog delegation: open marketplace as a
              // stand-in until the legacy dialog is extracted.
              setMarketplaceOpen(true);
            }}
            onEdit={() => {
              // Similarly delegated.
            }}
            onDelete={(name) => void handleMcpDelete(name)}
            onToggleEnabled={(server) => void handleMcpToggle(server)}
          />
        )}

        {!isLoading && activeTab === "skills" && (
          <SkillsSubPage
            skills={skills}
            searchQuery={searchByTab.skills}
            onSkillClick={(skill) => {
              const full = skills.find((s) => s.name === skill.name);
              if (full) setSelectedSkill(full);
            }}
            onToggleEnabled={handleToggleSkill}
          />
        )}

        {/* Marketplace modal */}
        <MarketplaceModal
          open={marketplaceOpen}
          onClose={() => setMarketplaceOpen(false)}
          installedPlugins={installed}
          connections={connections}
          providers={connectionProviders}
          onInstallPlugin={(plugin) => setMarketplaceDetailPlugin(plugin)}
          onPluginClick={(plugin) => setMarketplaceDetailPlugin(plugin)}
          onConnectProvider={requestConnection}
          onConfigureProvider={(provider) => {
            setConnectionSetupError(null);
            setConnectionSetupProvider(provider);
            setMarketplaceOpen(false);
          }}
          onDisconnectConnection={handleDisconnect}
          busyProvider={busyProvider}
        />
        <OAuthClientSetupDialog
          provider={connectionSetupProvider}
          busy={busyProvider === connectionSetupProvider?.id}
          error={connectionSetupError}
          onClose={() => {
            if (!busyProvider) setConnectionSetupProvider(null);
          }}
          onSave={(values) => void handleConfigureProvider(values)}
        />
        <ManagedOAuthConnectDialog
          provider={managedConnectionProvider}
          busy={busyProvider === managedConnectionProvider?.id}
          onClose={() => {
            if (!busyProvider) setManagedConnectionProvider(null);
          }}
          onConfirm={() => {
            const provider = managedConnectionProvider;
            if (!provider) return;
            setManagedConnectionProvider(null);
            void handleConnect(provider.id);
          }}
        />

        <SkillUploadDialog
          isOpen={skillUploadOpen}
          onClose={() => setSkillUploadOpen(false)}
          onUploaded={() => {
            setUploadSuccess(t("extensions.skills.uploadSuccess"));
            void reloadSkills();
          }}
        />
      </div>
    </div>
  );
}
