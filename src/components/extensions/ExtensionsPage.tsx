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
  MCPConfiguredServerDTO,
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
import { MCPSubPage } from "./MCPSubPage";
import { SkillsSubPage, type SkillSummary } from "./SkillsSubPage";
import { MarketplaceModal } from "./MarketplaceModal";
import { PluginDetailView } from "@/components/settings/capabilities/PluginDetailView";
import { PluginInstallModal } from "@/components/settings/capabilities/PluginInstallModal";
import { PlugIcon, PlusIcon, ChatCircleIcon, FileIcon } from "@/components/icons";
import { SkillUploadDialog } from "./SkillUploadDialog";

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
    pendingInstall,
    setPendingInstall,
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

  const [
    mcpInventory,
    setMcpInventory,
  ] = useState<MCPInventorySnapshotDTO | null>(null);
  const [mcpLoading, setMcpLoading] = useState(true);

  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);

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
            skills: SkillSummary[];
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

  const handleInstallConfirm = useCallback(async () => {
    if (!pendingInstall || !pluginApi) return;
    const target = pendingInstall;
    setPendingInstall(null);
    await runPluginAction(target.id, () =>
      pluginApi.registry.install({ pluginId: target.id })
    );
  }, [pendingInstall, pluginApi, runPluginAction]);

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
    const fromInventory: MCPConfiguredServerDTO[] =
      mcpInventory?.configuredServers ?? [];
    const fromSettings = settings.mcpServers ?? [];
    // Prefer inventory when available; fall back to settings.
    const source =
      fromInventory.length > 0 || mcpInventory
        ? fromInventory
        : fromSettings;
    return source.map((s) => ({
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
    connections: connectionProviders.length,
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

  // ── Skill detail — delegate to a simple back button for now ──
  if (selectedSkill) {
    return (
      <div className="settings-page-content">
        <div className="settings-content">
          <div className="rounded-lg border border-border/40 bg-[var(--surface)] px-4 py-3">
            <h3 className="text-sm font-semibold text-foreground">
              {selectedSkill.name}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {selectedSkill.description}
            </p>
            {selectedSkill.category && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("extensions.skill.category", { category: selectedSkill.category })}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-4"
            onClick={() => setSelectedSkill(null)}
          >
            {t("extensions.skill.back", { tab: t("extensions.tabs.skills") })}
          </Button>
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
            onConnect={handleConnect}
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
            onSkillClick={(skill) => setSelectedSkill(skill)}
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
          onInstallPlugin={(plugin) => setPendingInstall(plugin)}
          onConnectProvider={handleConnect}
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

        {/* Plugin install modal */}
        {pendingInstall && (
          <PluginInstallModal
            plugin={pendingInstall}
            onInstall={handleInstallConfirm}
            onCancel={() => setPendingInstall(null)}
            busy={busyPluginId === pendingInstall.id}
          />
        )}

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
