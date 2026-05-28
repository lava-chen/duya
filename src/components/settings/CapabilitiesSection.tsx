"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GlobeIcon,
  ArrowCounterClockwiseIcon,
  ShieldCheckIcon,
  CodeIcon,
  CubeIcon,
  SearchIcon,
} from "@/components/icons";
import {
  SettingsSection,
  SettingsCard,
} from "@/components/settings/ui";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import { getPluginAPI } from "@/lib/plugin-ipc";
import type {
  PluginCatalogEntry,
  PluginRegistryEntry,
} from "@/lib/plugin-types";
import { CapabilityBadge, type CapabilityKind } from "./capabilities/CapabilityBadge";
import { RuntimeStatusBadge } from "./capabilities/RuntimeStatusBadge";
import { PluginMarketplaceCard } from "./capabilities/PluginMarketplaceCard";
import { MarketplaceManagementCard } from "./capabilities/MarketplaceManagementCard";

type CapabilityTab = "installed" | "marketplace" | "updates" | "permissions" | "developer" | "markets";

const tabs: { id: CapabilityTab; labelKey: string }[] = [
  { id: "installed", labelKey: "settings.capabilities.tabInstalled" },
  { id: "marketplace", labelKey: "settings.capabilities.tabMarketplace" },
  { id: "updates", labelKey: "settings.capabilities.tabUpdates" },
  { id: "permissions", labelKey: "settings.capabilities.tabPermissions" },
  { id: "developer", labelKey: "settings.capabilities.tabDeveloper" },
  { id: "markets", labelKey: "settings.capabilities.tabMarkets" },
];

const categories: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "productivity", label: "Productivity" },
  { value: "development", label: "Development" },
  { value: "research", label: "Research" },
  { value: "data", label: "Data" },
  { value: "communication", label: "Communication" },
  { value: "media", label: "Media" },
  { value: "automation", label: "Automation" },
];

const sources: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "bundled", label: "Bundled" },
  { value: "builtin-directory", label: "Built-in" },
  { value: "marketplace", label: "Marketplace" },
];

function EmptyState({ tab }: { tab: CapabilityTab }) {
  const { t } = useTranslation();
  const config = {
    installed: {
      icon: <CubeIcon size={48} />,
      title: t("settings.capabilities.emptyInstalledTitle"),
      description: t("settings.capabilities.emptyInstalledDesc"),
    },
    marketplace: {
      icon: <GlobeIcon size={48} />,
      title: t("settings.capabilities.emptyMarketplaceTitle"),
      description: t("settings.capabilities.emptyMarketplaceDesc"),
    },
    updates: {
      icon: <ArrowCounterClockwiseIcon size={48} />,
      title: t("settings.capabilities.emptyUpdatesTitle"),
      description: t("settings.capabilities.emptyUpdatesDesc"),
    },
    permissions: {
      icon: <ShieldCheckIcon size={48} />,
      title: t("settings.capabilities.emptyPermissionsTitle"),
      description: t("settings.capabilities.emptyPermissionsDesc"),
    },
    developer: {
      icon: <CodeIcon size={48} />,
      title: t("settings.capabilities.emptyDeveloperTitle"),
      description: t("settings.capabilities.emptyDeveloperDesc"),
    },
    markets: {
      icon: <GlobeIcon size={48} />,
      title: "Market Sources",
      description: "No known marketplaces configured.",
    },
  }[tab];

  return (
    <SettingsCard>
      <div className="flex flex-col items-center justify-center py-16 px-4">
        <div className="text-muted-foreground mb-4">{config.icon}</div>
        <h3 className="text-lg font-semibold text-foreground mb-2">
          {config.title}
        </h3>
        <p className="text-muted-foreground text-center max-w-sm">
          {config.description}
        </p>
      </div>
    </SettingsCard>
  );
}

function getCapabilityKinds(plugin: PluginCatalogEntry): CapabilityKind[] {
  const kinds: CapabilityKind[] = [];
  const counts = plugin.capabilityCounts;
  if (!counts) return kinds;
  if (counts.skills > 0) kinds.push("skills");
  if (counts.mcpServers > 0) kinds.push("mcpServers");
  if (counts.cli > 0) kinds.push("cli");
  if (counts.ui > 0) kinds.push("ui");
  if (counts.hooks > 0) kinds.push("hooks");
  return kinds;
}

export function CapabilitiesSection() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<CapabilityTab>("installed");
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<PluginRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");

  const pluginApi = useMemo(() => getPluginAPI(), []);

  const reload = useCallback(async () => {
    if (!pluginApi) return;
    setLoading(true);
    setError(null);
    try {
      const [catalogRes, installedRes] = await Promise.all([
        pluginApi.catalog.list({ search: search || undefined, category: categoryFilter || undefined, source: sourceFilter || undefined }),
        pluginApi.registry.list(),
      ]);
      if (catalogRes.success) setCatalog(catalogRes.data);
      else setError(catalogRes.error ?? "Failed to load catalog");

      if (installedRes.success) setInstalled(installedRes.data);
      else if (!catalogRes.success) setError(installedRes.error ?? "Failed to load installed plugins");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [pluginApi, search, categoryFilter, sourceFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (selectedPluginId) return;
    if (activeTab === "installed" && installed[0]) {
      setSelectedPluginId(installed[0].id);
      return;
    }
    if (activeTab === "marketplace" && catalog[0]) {
      setSelectedPluginId(catalog[0].id);
    }
  }, [activeTab, catalog, installed, selectedPluginId]);

  const installedIds = useMemo(() => new Set(installed.map((p) => p.id)), [installed]);

  const updates = useMemo(() => {
    return installed.filter((p) => {
      const catalogEntry = catalog.find((c) => c.id === p.id);
      return catalogEntry && catalogEntry.version !== p.version;
    });
  }, [installed, catalog]);

  const filteredCatalog = useMemo(() => {
    let results = catalog;
    if (search) {
      const q = search.toLowerCase();
      results = results.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q)
      );
    }
    if (categoryFilter) {
      results = results.filter((p) => p.category === categoryFilter);
    }
    if (sourceFilter) {
      results = results.filter((p) => p.source === sourceFilter);
    }
    return results;
  }, [catalog, search, categoryFilter, sourceFilter]);

  const permissionIssues = useMemo(
    () => installed.filter(
      (p) => p.runtimeStatus === "needs_setup" || p.runtimeStatus === "failed_to_load"
    ),
    [installed]
  );

  const developerPlugins = useMemo(
    () => installed.filter((p) => p.source === "local"),
    [installed]
  );

  const selectedPlugin = useMemo(() => {
    if (!selectedPluginId) return null;
    return (
      installed.find((item) => item.id === selectedPluginId) ??
      catalog.find((item) => item.id === selectedPluginId) ??
      null
    );
  }, [catalog, installed, selectedPluginId]);

  if (!pluginApi) {
    return (
      <SettingsSection
        title={t("settings.capabilities.title")}
        description={t("settings.capabilities.description")}
      >
        <SettingsCard>
          <div className="py-8 text-sm text-muted-foreground text-center">
            Plugin API not available
          </div>
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (activeTab === "markets") {
    return <MarketplaceManagementCard />;
  }

  const renderInstalled = () => {
    if (installed.length === 0) return <EmptyState tab="installed" />;

    return (
      <div className="space-y-2">
        {installed.map((item) => {
          const catalogEntry = catalog.find((c) => c.id === item.id);
          const kinds = catalogEntry ? getCapabilityKinds(catalogEntry) : [];
          const isSelected = selectedPluginId === item.id;

          return (
            <SettingsCard
              key={item.id}
              className={cn(
                "border transition-all",
                isSelected ? "border-accent/45 bg-accent/[0.03]" : "border-border/50"
              )}
            >
              <div className="flex items-center justify-between gap-4">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setSelectedPluginId(item.id)}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-medium text-foreground truncate">{item.name}</h3>
                    <span className="text-xs text-muted-foreground">
                      v{item.version}
                    </span>
                    <RuntimeStatusBadge status={item.runtimeStatus} />
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {kinds.map((kind) => (
                      <CapabilityBadge key={kind} kind={kind} />
                    ))}
                    <span className="text-[11px] text-muted-foreground">
                      {item.id}
                    </span>
                  </div>
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="px-2 py-1 text-xs rounded-md border border-border/60 text-muted-foreground hover:text-foreground disabled:opacity-50"
                    disabled={busyPluginId === item.id}
                    onClick={async () => {
                      setBusyPluginId(item.id);
                      const res = item.enabled
                        ? await pluginApi.registry.disable(item.id)
                        : await pluginApi.registry.enable(item.id);
                      if (!res.success) setError(res.error ?? "Failed to update plugin state");
                      await reload();
                      setBusyPluginId(null);
                    }}
                  >
                    {item.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    className="px-2 py-1 text-xs rounded-md border border-border/60 text-muted-foreground hover:text-foreground disabled:opacity-50"
                    disabled={busyPluginId === item.id}
                    onClick={async () => {
                      setBusyPluginId(item.id);
                      const res = await pluginApi.registry.remove({ pluginId: item.id, deleteData: false });
                      if (!res.success) setError(res.error ?? "Failed to remove plugin");
                      await reload();
                      setBusyPluginId(null);
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </SettingsCard>
          );
        })}
      </div>
    );
  };

  const renderMarketplace = () => {
    if (filteredCatalog.length === 0) {
      return search || categoryFilter || sourceFilter
        ? (
          <SettingsCard>
            <div className="py-8 text-sm text-muted-foreground text-center">
              No plugins match your filters.
            </div>
          </SettingsCard>
        )
        : <EmptyState tab="marketplace" />;
    }

    return (
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {filteredCatalog.map((item) => (
          <PluginMarketplaceCard
            key={item.id}
            plugin={item}
            isInstalled={installedIds.has(item.id)}
            selected={selectedPluginId === item.id}
            onInstall={async (pluginId) => {
              setBusyPluginId(pluginId);
              const res = await pluginApi.registry.install({ pluginId });
              if (!res.success) setError(res.error ?? "Failed to install plugin");
              await reload();
              setSelectedPluginId(pluginId);
              setBusyPluginId(null);
            }}
            onClick={async (pluginId) => {
              setSelectedPluginId(pluginId);
              const installedPlugin = installed.find((p) => p.id === pluginId);
              if (!installedPlugin) return;
              setBusyPluginId(pluginId);
              const res = installedPlugin.enabled
                ? await pluginApi.registry.disable(pluginId)
                : await pluginApi.registry.enable(pluginId);
              if (!res.success) setError(res.error ?? "Failed to update plugin state");
              await reload();
              setBusyPluginId(null);
            }}
          />
        ))}
      </div>
    );
  };

  const renderUpdates = () => {
    if (updates.length === 0) return <EmptyState tab="updates" />;

    return (
      <div className="space-y-2">
        {updates.map((item) => {
          const catalogEntry = catalog.find((c) => c.id === item.id);
          return (
            <SettingsCard key={item.id}>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium text-foreground">{item.name}</h3>
                    <span className="text-xs text-muted-foreground">
                      {item.version} &rarr; {catalogEntry?.version ?? "?"}
                    </span>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    {item.id}
                  </span>
                </div>
              </div>
            </SettingsCard>
          );
        })}
      </div>
    );
  };

  const renderPermissions = () => {
    if (permissionIssues.length === 0) return <EmptyState tab="permissions" />;

    return (
      <div className="space-y-2">
        {permissionIssues.map((item) => (
          <SettingsCard key={item.id}>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-foreground">{item.name}</h3>
                  <RuntimeStatusBadge status={item.runtimeStatus} />
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {item.permissionDenied.length > 0
                    ? `Denied: ${item.permissionDenied.join(", ")}`
                    : "Setup required"}
                </div>
              </div>
            </div>
          </SettingsCard>
        ))}
      </div>
    );
  };

  const renderDeveloper = () => {
    if (developerPlugins.length === 0) return <EmptyState tab="developer" />;

    return (
      <div className="space-y-2">
        {developerPlugins.map((item) => (
          <SettingsCard key={item.id}>
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <h3 className="font-medium text-foreground">{item.name}</h3>
                <span className="text-[11px] text-muted-foreground">
                  {item.installPath}
                </span>
              </div>
              <RuntimeStatusBadge status={item.runtimeStatus} />
            </div>
          </SettingsCard>
        ))}
      </div>
    );
  };

  const renderTabContent = () => {
    if (loading) {
      return (
        <SettingsCard>
          <div className="py-8 text-sm text-muted-foreground text-center">
            {t("settings.capabilities.loading" as never)}
          </div>
        </SettingsCard>
      );
    }

    switch (activeTab) {
      case "installed":
        return renderInstalled();
      case "marketplace":
        return renderMarketplace();
      case "updates":
        return renderUpdates();
      case "permissions":
        return renderPermissions();
      case "developer":
        return renderDeveloper();
      default:
        return <EmptyState tab="installed" />;
    }
  };

  return (
    <SettingsSection
      title={t("settings.capabilities.title")}
      description={t("settings.capabilities.description")}
    >
      <div className="rounded-2xl border border-border/60 bg-surface/70 overflow-hidden">
        <div className="border-b border-border/50 px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex border border-border/60 rounded-xl p-1 bg-muted/20">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "px-3.5 py-1.5 text-sm font-medium transition-colors relative rounded-lg",
                  "hover:text-foreground",
                  activeTab === tab.id
                    ? "text-foreground bg-background shadow-sm"
                    : "text-muted-foreground"
                )}
              >
                {t(tab.labelKey as never)}
              </button>
            ))}
            </div>
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded-md border border-border/60 text-muted-foreground hover:text-foreground"
              onClick={() => void reload()}
              disabled={loading}
            >
              {t("settings.capabilities.actionRefresh" as never)}
            </button>
          </div>

          {activeTab === "marketplace" && (
            <div className="flex items-center gap-2 mt-3">
              <div className="relative flex-1">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("settings.capabilities.searchPlaceholder" as never)}
                  className="w-full pl-8 pr-3 py-2 text-sm rounded-md bg-background border border-border/50 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent/50"
            />
              </div>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="px-3 py-1.5 text-sm rounded-md bg-background border border-border/50 text-foreground focus:outline-none focus:border-accent/50"
            >
              {categories.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="px-3 py-1.5 text-sm rounded-md bg-background border border-border/50 text-foreground focus:outline-none focus:border-accent/50"
            >
              {sources.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          )}
        </div>

        {error ? (
          <div className="px-5 pt-4">
            <SettingsCard variant="danger">
              <div className="py-3 text-sm text-red-400">{error}</div>
            </SettingsCard>
          </div>
        ) : null}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] gap-0">
          <div className="p-5">{renderTabContent()}</div>
          <div className="border-l border-border/50 p-5 bg-muted/[0.16]">
            {selectedPlugin ? (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="text-lg font-semibold text-foreground">
                      {selectedPlugin.name}
                    </h4>
                    {"version" in selectedPlugin && (
                      <span className="text-xs text-muted-foreground">
                        v{selectedPlugin.version}
                      </span>
                    )}
                  </div>
                  {"description" in selectedPlugin && (
                    <p className="text-sm text-muted-foreground">
                      {selectedPlugin.description}
                    </p>
                  )}
                </div>

                {"runtimeStatus" in selectedPlugin && (
                  <div className="flex items-center gap-2">
                    <RuntimeStatusBadge status={selectedPlugin.runtimeStatus} />
                    <span className="text-xs text-muted-foreground">
                      {selectedPlugin.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                )}

                {"capabilityCounts" in selectedPlugin && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {getCapabilityKinds(selectedPlugin).map((kind) => (
                      <CapabilityBadge key={kind} kind={kind} size="md" />
                    ))}
                  </div>
                )}

                {"manifest" in selectedPlugin && (
                  <div className="space-y-3">
                    <div>
                      <h5 className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                        Permissions
                      </h5>
                      <div className="text-sm text-foreground">
                        {(selectedPlugin.permissionsGranted ?? []).length} granted / {(selectedPlugin.permissionDenied ?? []).length} denied
                      </div>
                    </div>
                    <div>
                      <h5 className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                        Install path
                      </h5>
                      <div className="text-xs text-muted-foreground break-all">
                        {selectedPlugin.installPath}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="h-full min-h-[220px] flex items-center justify-center text-sm text-muted-foreground text-center px-5">
                Select a plugin to inspect details.
              </div>
            )}
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
