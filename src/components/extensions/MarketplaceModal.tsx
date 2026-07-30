"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import { getPluginAPI } from "@/lib/plugin-ipc";
import type { PluginCatalogEntry, PluginRegistryEntry } from "@/lib/plugin-types";
import type { AppConnectionStatusDTO, ProviderId } from "@/lib/app-connection-ipc";

import { OFFICIAL_CONNECTORS } from "./MarketplaceConnectors";

type MarketCategory = "plugins" | "skills" | "connectors";
type MarketSource = "official" | "others";

interface MarketplaceModalProps {
  open: boolean;
  onClose: () => void;
  installedPlugins: PluginRegistryEntry[];
  connections: AppConnectionStatusDTO[];
  onInstallPlugin: (plugin: PluginCatalogEntry) => void;
  onConnectProvider: (provider: ProviderId) => void;
  onDisconnectConnection: (connectionId: string) => void;
  busyProvider: ProviderId | null;
}

export function MarketplaceModal({
  open,
  onClose,
  installedPlugins,
  connections,
  onInstallPlugin,
  onConnectProvider,
  onDisconnectConnection,
  busyProvider,
}: MarketplaceModalProps) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<MarketCategory>("plugins");
  const [source, setSource] = useState<MarketSource>("official");
  const [search, setSearch] = useState("");
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const api = getPluginAPI();
      if (!api) return;
      const res = await api.catalog.list();
      if (res.success) setCatalog(res.data);
    })();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const installedIds = useMemo(
    () => new Set(installedPlugins.map((p) => p.id)),
    [installedPlugins]
  );

  const connectedProviders = useMemo(
    () =>
      new Set(
        connections
          .filter((c) => c.status === "connected")
          .map((c) => c.provider)
      ),
    [connections]
  );

  const filteredCatalog = useMemo(() => {
    if (!search.trim()) return catalog;
    const q = search.toLowerCase();
    return catalog.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.shortDescription?.toLowerCase().includes(q) ||
        c.description?.toLowerCase().includes(q)
    );
  }, [catalog, search]);

  const officialPlugins = useMemo(
    () =>
      filteredCatalog.filter(
        (c) =>
          c.source === 'bundled' ||
          c.developer?.toLowerCase().includes("duya") ||
          c.author?.name?.toLowerCase().includes("duya")
      ),
    [filteredCatalog]
  );
  const otherPlugins = useMemo(
    () => filteredCatalog.filter((c) => !officialPlugins.includes(c)),
    [filteredCatalog, officialPlugins]
  );

  if (!open) return null;

  const categories: { id: MarketCategory; labelKey: string }[] = [
    { id: "plugins", labelKey: "marketplace.categories.plugins" },
    { id: "skills", labelKey: "marketplace.categories.skills" },
    { id: "connectors", labelKey: "marketplace.categories.connectors" },
  ];

  const pluginsToShow = source === "official" ? officialPlugins : otherPlugins;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="relative z-10 flex w-full max-w-4xl max-h-[85vh] bg-[var(--main-bg)] border border-border/50 rounded-xl shadow-xl overflow-hidden">
        {/* Left nav */}
        <nav className="w-48 shrink-0 border-r border-border/40 bg-[var(--surface)]/40 p-3 space-y-1">
          <h3 className="px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t("marketplace.title" as never)}
          </h3>
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategory(cat.id)}
              className={cn(
                "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors",
                category === cat.id
                  ? "bg-accent/10 text-accent font-medium"
                  : "text-foreground hover:bg-muted/40"
              )}
            >
              {t(cat.labelKey as never)}
            </button>
          ))}
        </nav>

        {/* Right content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border/40">
            <h2 className="text-lg font-semibold text-foreground">
              {t(categories.find((c) => c.id === category)!.labelKey as never)}
            </h2>
            <div className="flex items-center gap-2">
              <div className="w-56">
                <Input
                  type="search"
                  placeholder={t("marketplace.search" as never)}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  size="sm"
                />
              </div>
              <IconButton
                variant="ghost"
                size="sm"
                aria-label="Close"
                onClick={onClose}
              >
                ✕
              </IconButton>
            </div>
          </div>

          {/* Source tabs */}
          <div className="flex items-center gap-1 px-5 py-2 border-b border-border/30">
            {(["official", "others"] as MarketSource[]).map((src) => (
              <button
                key={src}
                type="button"
                onClick={() => setSource(src)}
                className={cn(
                  "px-3 py-1.5 text-sm rounded-lg transition-colors",
                  source === src
                    ? "bg-accent/10 text-accent font-medium"
                    : "text-muted-foreground hover:bg-muted/40"
                )}
              >
                {t(
                  (src === "official"
                    ? "marketplace.tabs.official"
                    : "marketplace.tabs.others") as never
                )}
              </button>
            ))}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5">
            {category === "plugins" && (
              <div className="space-y-2">
                {pluginsToShow.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    {t("marketplace.empty" as never)}
                  </p>
                ) : (
                  pluginsToShow.map((plugin) => {
                    const isInstalled = installedIds.has(plugin.id);
                    return (
                      <div
                        key={plugin.id}
                        className="flex items-start gap-3 rounded-lg border border-border/30 px-4 py-3 hover:border-border/50 transition-colors"
                      >
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-sm font-semibold text-accent">
                          {plugin.icon ? (
                            <img src={plugin.icon} alt={plugin.name} className="h-6 w-6 rounded" />
                          ) : (
                            plugin.name.trim().charAt(0).toUpperCase()
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-semibold text-foreground truncate">
                              {plugin.name}
                            </h4>
                            <span className="text-xs text-muted-foreground">v{plugin.version}</span>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                            {plugin.shortDescription || plugin.description}
                          </p>
                        </div>
                        <div className="shrink-0">
                          {isInstalled ? (
                            <span className="flex items-center gap-1 text-xs text-emerald-600">
                              ✓ {t("marketplace.connectors.connected" as never)}
                            </span>
                          ) : (
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => onInstallPlugin(plugin)}
                            >
                              Install
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {category === "connectors" && (
              <ConnectorsPanel
                source={source}
                connections={connections}
                connectedProviders={connectedProviders}
                busyProvider={busyProvider}
                onConnect={onConnectProvider}
                onDisconnect={onDisconnectConnection}
              />
            )}

            {category === "skills" && (
              <div className="text-center py-12">
                <p className="text-sm text-muted-foreground">
                  {t("marketplace.empty" as never)}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ConnectorsPanel({
  source,
  connections,
  connectedProviders,
  busyProvider,
  onConnect,
  onDisconnect,
}: {
  source: MarketSource;
  connections: AppConnectionStatusDTO[];
  connectedProviders: Set<ProviderId>;
  busyProvider: ProviderId | null;
  onConnect: (provider: ProviderId) => void;
  onDisconnect: (connectionId: string) => void;
}) {
  const { t } = useTranslation();

  if (source === "others") {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-muted-foreground">
          {t("marketplace.empty" as never)}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {OFFICIAL_CONNECTORS.map((preset) => {
        const isConnected = connectedProviders.has(preset.provider);
        const connection = connections.find(
          (c) => c.provider === preset.provider && c.status === "connected"
        );
        return (
          <div
            key={preset.provider}
            className="flex items-start gap-3 rounded-lg border border-border/30 px-4 py-3"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-sm font-semibold text-accent">
              {preset.monogram}
            </div>
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-semibold text-foreground">{preset.name}</h4>
              <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                {preset.description}
              </p>
            </div>
            <div className="shrink-0">
              {isConnected && connection ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busyProvider === preset.provider}
                  onClick={() => onDisconnect(connection.id)}
                >
                  {t("marketplace.connectors.disconnect" as never)}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busyProvider === preset.provider}
                  onClick={() => onConnect(preset.provider)}
                >
                  {t("marketplace.connectors.connect" as never)}
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
