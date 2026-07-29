"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SettingsSection, SettingsCard } from "@/components/settings/ui";
import { Button } from "@/components/ui/Button";
import { useTranslation } from "@/hooks/useTranslation";
import { getPluginAPI } from "@/lib/plugin-ipc";
import { useConversationStore } from "@/stores/conversation-store";
import type {
  PluginCatalogEntry,
  PluginRegistryEntry,
} from "@/lib/plugin-types";
import { PluginCard } from "./capabilities/PluginCard";
import { PluginInstallModal } from "./capabilities/PluginInstallModal";
import { PluginDetailView } from "./capabilities/PluginDetailView";
import { PluginManagementView } from "./capabilities/PluginManagementView";
import { CapabilityBanner } from "./capabilities/CapabilityBanner";
import { CapabilityByPluginView } from "./capabilities/CapabilityByPluginView";
import { fetchCapabilityManagementSnapshot, hasCapabilityManagementAPI } from "@/lib/capability-management-ipc";
import { useCapabilityManagementSnapshot } from "@/lib/useCapabilityManagementSnapshot";
import type { CapabilityManagementSnapshot } from "@/lib/capability-management-types";
import { fetchMCPInventorySnapshot, hasMCPInventoryAPI } from "@/lib/mcp-inventory-ipc";
import type { MCPInventorySnapshotDTO } from "@/lib/mcp-inventory-types";

type PageView = "discover" | "detail" | "manage";

export function CapabilitiesSection() {
  const { t } = useTranslation();
  const createThread = useConversationStore((s) => s.createThread);
  const setActiveThread = useConversationStore((s) => s.setActiveThread);
  const setCurrentView = useConversationStore((s) => s.setCurrentView);

  const [view, setView] = useState<PageView>("discover");
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [pendingInstallPlugin, setPendingInstallPlugin] =
    useState<PluginCatalogEntry | null>(null);

  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<PluginRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);

  const [capabilitySnapshot, setCapabilitySnapshot] =
    useState<CapabilityManagementSnapshot | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [mcpInventory, setMcpInventory] = useState<MCPInventorySnapshotDTO | null>(null);

  const pluginApi = useMemo(() => getPluginAPI(), []);
  const capabilityApiAvailable = useMemo(() => hasCapabilityManagementAPI(), []);
  const mcpInventoryApiAvailable = useMemo(() => hasMCPInventoryAPI(), []);

  const reload = useCallback(async () => {
    if (!pluginApi) return;
    setLoading(true);
    setError(null);
    try {
      const [catalogRes, installedRes] = await Promise.all([
        pluginApi.catalog.list(),
        pluginApi.registry.list(),
      ]);
      if (catalogRes.success) setCatalog(catalogRes.data);
      else setError(catalogRes.error ?? "Failed to load catalog");
      if (installedRes.success) setInstalled(installedRes.data);
      else if (!catalogRes.success)
        setError(installedRes.error ?? "Failed to load installed plugins");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [pluginApi]);

  const reloadCapabilities = useCallback(async () => {
    if (!capabilityApiAvailable) return;
    setCapabilityLoading(true);
    setCapabilityError(null);
    try {
      const snap = await fetchCapabilityManagementSnapshot();
      setCapabilitySnapshot(snap);
    } catch (err) {
      setCapabilityError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapabilityLoading(false);
    }
  }, [capabilityApiAvailable]);

  const reloadMcpInventory = useCallback(async () => {
    if (!mcpInventoryApiAvailable) return;
    try {
      const snapshot = await fetchMCPInventorySnapshot();
      setMcpInventory(snapshot);
    } catch {
      setMcpInventory(null);
    }
  }, [mcpInventoryApiAvailable]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void reloadCapabilities();
  }, [reloadCapabilities]);

  useEffect(() => {
    void reloadMcpInventory();
  }, [reloadMcpInventory]);

  // Phase 3: refetch the snapshot whenever the agent server broadcasts
  // an MCP / skills reload event. The hook owns its own subscription
  // and a no-op cleanup if the SSE bridge is not available.
  useCapabilityManagementSnapshot({
    onSnapshot: (snapshot) => {
      setCapabilitySnapshot(snapshot);
      void reloadMcpInventory();
    },
  });

  const installedMap = useMemo(
    () => new Map(installed.map((p) => [p.id, p])),
    [installed]
  );

  const runRegistryAction = useCallback(
    async (
      pluginId: string,
      action: () => Promise<{ success: boolean; error?: string }>
    ) => {
      setBusyPluginId(pluginId);
      const res = await action();
      if (!res.success) setError(res.error ?? "Action failed");
      await reload();
      setBusyPluginId(null);
    },
    [reload]
  );

  const updates = useMemo(() => {
    return installed.filter((p) => {
      const catalogEntry = catalog.find((c) => c.id === p.id);
      return catalogEntry && catalogEntry.version !== p.version;
    });
  }, [installed, catalog]);

  const issues = useMemo(
    () =>
      installed.filter(
        (p) =>
          p.runtimeStatus === "needs_setup" ||
          p.runtimeStatus === "failed_to_load"
      ),
    [installed]
  );

  const handleInstallClick = useCallback(
    (plugin: PluginCatalogEntry) => {
      setPendingInstallPlugin(plugin);
    },
    []
  );

  const handleInstallConfirm = useCallback(async () => {
    if (!pendingInstallPlugin || !pluginApi) return;
    await runRegistryAction(pendingInstallPlugin.id, () =>
      pluginApi.registry.install({ pluginId: pendingInstallPlugin.id })
    );
    setPendingInstallPlugin(null);
  }, [pendingInstallPlugin, pluginApi, runRegistryAction]);

  const handlePluginClick = useCallback(
    (plugin: PluginCatalogEntry) => {
      const inst = installedMap.get(plugin.id);
      if (inst) {
        setSelectedPluginId(plugin.id);
        setView("detail");
      } else {
        setPendingInstallPlugin(plugin);
      }
    },
    [installedMap]
  );

  const handleCreatePlugin = useCallback(async () => {
    if (!pluginApi) return;
    try {
      const thread = await createThread();
      if (thread) {
        setActiveThread(thread.id);
        setCurrentView("chat");
      }
    } catch {
      void 0;
    }
  }, [createThread, setActiveThread, setCurrentView, pluginApi]);

  // Plan 311 — navigate to chat after a workflow template is launched.
  // The detail view already dispatched the prefill event (which stashes
  // the prompt as pending); here we just create a fresh session and
  // switch views so `MessageInput` mounts and consumes the stash.
  const handleLaunchWorkflow = useCallback(
    async (_prompt: string) => {
      try {
        const thread = await createThread();
        if (thread) {
          setActiveThread(thread.id);
          setCurrentView("chat");
        }
      } catch {
        void 0;
      }
    },
    [createThread, setActiveThread, setCurrentView],
  );

  const handleBackToDiscover = useCallback(() => {
    setView("discover");
    setSelectedPluginId(null);
  }, []);

  if (!pluginApi) {
    return (
      <SettingsSection
        title={t("settings.plugins.title" as never)}
        description={t("settings.plugins.description" as never)}
      >
        <SettingsCard divided={false} className="py-8 text-sm text-muted-foreground text-center">
          Plugin API not available
        </SettingsCard>
      </SettingsSection>
    );
  }

  // ── Manage View ──
  if (view === "manage") {
    return (
      <SettingsSection
        title={t("settings.plugins.title" as never)}
        description={t("settings.plugins.description" as never)}
      >
        <div className="space-y-6">
          <PluginManagementView
            installed={installed}
            catalog={catalog}
            updates={updates}
            issues={issues}
            onBack={handleBackToDiscover}
            onPluginClick={(id) => {
              setSelectedPluginId(id);
              setView("detail");
            }}
            onEnable={(id) =>
              void runRegistryAction(id, () => pluginApi.registry.enable(id))
            }
            onDisable={(id) =>
              void runRegistryAction(id, () => pluginApi.registry.disable(id))
            }
            onRemove={(id) =>
              void runRegistryAction(id, () =>
                pluginApi.registry.remove({ pluginId: id, deleteData: false })
              )
            }
            busyPluginId={busyPluginId}
          />
          {capabilityApiAvailable ? (
            capabilityLoading && !capabilitySnapshot ? (
              <SettingsCard divided={false} className="text-xs text-muted-foreground">
                Loading capabilities…
              </SettingsCard>
            ) : capabilityError ? (
              <SettingsCard variant="danger" divided={false} className="text-xs text-red-500">
                Capability snapshot failed: {capabilityError}
              </SettingsCard>
            ) : capabilitySnapshot ? (
              <CapabilityByPluginView snapshot={capabilitySnapshot} />
            ) : null
          ) : null}
        </div>
      </SettingsSection>
    );
  }

  // ── Detail View ──
  if (view === "detail" && selectedPluginId) {
    const inst = installedMap.get(selectedPluginId);
    if (!inst) {
      return (
        <SettingsSection
          title={t("settings.plugins.title" as never)}
          description={t("settings.plugins.description" as never)}
        >
          <SettingsCard divided={false} className="py-8 text-sm text-muted-foreground text-center">
            Plugin not found
          </SettingsCard>
        </SettingsSection>
      );
    }

    const catEntry = catalog.find((c) => c.id === selectedPluginId) ?? null;

    return (
      <SettingsSection
        title={t("settings.plugins.title" as never)}
        description={t("settings.plugins.description" as never)}
      >
        <PluginDetailView
          installed={inst}
          catalog={catEntry}
          onBack={handleBackToDiscover}
          onEnable={() =>
            void runRegistryAction(selectedPluginId, () =>
              pluginApi.registry.enable(selectedPluginId)
            )
          }
          onDisable={() =>
            void runRegistryAction(selectedPluginId, () =>
              pluginApi.registry.disable(selectedPluginId)
            )
          }
          onRemove={() =>
            void runRegistryAction(selectedPluginId, () =>
              pluginApi.registry.remove({
                pluginId: selectedPluginId,
                deleteData: false,
              })
            )
          }
          busy={busyPluginId === selectedPluginId}
          onLaunchWorkflow={(prompt) => void handleLaunchWorkflow(prompt)}
        />
      </SettingsSection>
    );
  }

  // ── Discover Home ──
  return (
    <SettingsSection
      title="Plugins"
      description="Add tools and workflows to help Duya research, write, and build."
      action={
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setView("manage")}
          >
            Manage
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleCreatePlugin}
          >
            Create plugin
          </Button>
        </div>
      }
    >
      {error ? (
        <SettingsCard variant="danger" divided={false} className="mb-4 text-sm text-red-500">
          {error}
        </SettingsCard>
      ) : null}

      {capabilityApiAvailable ? (
        capabilityLoading && !capabilitySnapshot ? (
          <SettingsCard divided={false} className="mb-3 text-xs text-muted-foreground">
            Loading capabilities…
          </SettingsCard>
        ) : capabilityError ? (
          <SettingsCard variant="danger" divided={false} className="mb-3 text-xs text-red-500">
            Capability snapshot failed: {capabilityError}
          </SettingsCard>
        ) : capabilitySnapshot ? (
          <CapabilityBanner
            snapshot={capabilitySnapshot}
            mcpInventory={mcpInventory}
            onOpenManage={() => setView("manage")}
          />
        ) : null
      ) : null}

      {loading ? (
        <SettingsCard divided={false} className="py-8 text-sm text-muted-foreground text-center">
          {t("settings.capabilities.loading" as never)}
        </SettingsCard>
      ) : catalog.length === 0 ? (
        <SettingsCard divided={false} className="py-8 text-center text-sm text-muted-foreground">
          {t("settings.capabilities.emptyMarketplaceDesc" as never)}
        </SettingsCard>
      ) : (
        <div className="space-y-2">
          {catalog.map((item) => {
            const inst = installedMap.get(item.id);
            const isInstalled = !!inst;
            const isEnabled = inst?.enabled ?? false;
            const hasIssues = inst
              ? inst.runtimeStatus === "needs_setup" ||
                inst.runtimeStatus === "failed_to_load"
              : false;

            return (
              <PluginCard
                key={item.id}
                plugin={item}
                isInstalled={isInstalled}
                isEnabled={isEnabled}
                hasIssues={hasIssues}
                onInstallClick={handleInstallClick}
                onClick={handlePluginClick}
              />
            );
          })}
        </div>
      )}

      {/* Pre-install modal */}
      {pendingInstallPlugin && (
        <PluginInstallModal
          plugin={pendingInstallPlugin}
          onInstall={handleInstallConfirm}
          onCancel={() => setPendingInstallPlugin(null)}
          busy={busyPluginId === pendingInstallPlugin.id}
        />
      )}
    </SettingsSection>
  );
}
