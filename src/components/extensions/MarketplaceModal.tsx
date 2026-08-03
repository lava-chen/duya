"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import { getPluginAPI } from "@/lib/plugin-ipc";
import type { PluginCatalogEntry, PluginRegistryEntry } from "@/lib/plugin-types";
import type {
  AppConnectionProviderDTO,
  AppConnectionStatusDTO,
  ProviderId,
} from "@/lib/app-connection-ipc";
import { ExtensionCard } from "./ExtensionCard";
import { ConnectorIcon } from "./connector-icons";
import {
  PlugIcon,
  ListChecksIcon,
  SquaresFourIcon,
  XIcon,
} from "@/components/icons";


type MarketCategory = "plugins" | "skills" | "connectors";
type MarketSource = "official" | "others";

interface MarketplaceModalProps {
  open: boolean;
  onClose: () => void;
  installedPlugins: PluginRegistryEntry[];
  connections: AppConnectionStatusDTO[];
  providers: AppConnectionProviderDTO[];
  onInstallPlugin: (plugin: PluginCatalogEntry) => void;
  onPluginClick: (plugin: PluginCatalogEntry) => void;
  onConnectProvider: (provider: AppConnectionProviderDTO) => void;
  onConfigureProvider: (provider: AppConnectionProviderDTO) => void;
  onDisconnectConnection: (connectionId: string) => void;
  busyProvider: ProviderId | null;
}

const CATEGORY_META: Record<MarketCategory, { labelKey: string; icon: ReactNode }> = {
  plugins: { labelKey: "marketplace.categories.plugins", icon: <PlugIcon size={18} /> },
  skills: { labelKey: "marketplace.categories.skills", icon: <ListChecksIcon size={18} /> },
  connectors: { labelKey: "marketplace.categories.connectors", icon: <SquaresFourIcon size={18} /> },
};

export function MarketplaceModal({
  open,
  onClose,
  installedPlugins,
  connections,
  providers,
  onInstallPlugin,
  onPluginClick,
  onConnectProvider,
  onConfigureProvider,
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
          c.source === "bundled" ||
          c.developer?.toLowerCase().includes("duya") ||
          c.author?.name?.toLowerCase().includes("duya")
      ),
    [filteredCatalog]
  );
  const otherPlugins = useMemo(
    () => filteredCatalog.filter((c) => !officialPlugins.includes(c)),
    [filteredCatalog, officialPlugins]
  );

  const skillCatalog = useMemo(
    () => filteredCatalog.filter((c) => c.kind === "skill"),
    [filteredCatalog]
  );

  if (!open) return null;

  const categories = Object.entries(CATEGORY_META).map(([id, meta]) => ({
    id: id as MarketCategory,
    ...meta,
  }));

  const pluginsToShow = source === "official" ? officialPlugins : otherPlugins;
  const currentLabelKey = CATEGORY_META[category].labelKey;

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
        <nav className="w-52 shrink-0 border-r border-border/40 bg-[var(--surface)]/40 p-3 space-y-1">
          <h3 className="px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t("marketplace.directory")}
          </h3>
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategory(cat.id)}
              className={cn(
                "w-full flex items-center gap-2.5 text-left px-3 py-2 rounded-lg text-sm transition-colors",
                category === cat.id
                  ? "bg-accent/10 text-accent font-medium"
                  : "text-foreground hover:bg-muted/40"
              )}
            >
              <span className={cn("shrink-0", category === cat.id ? "text-accent" : "text-muted-foreground")}>
                {cat.icon}
              </span>
              {t(cat.labelKey as never)}
            </button>
          ))}
        </nav>

        {/* Right content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border/40">
            <h2 className="text-lg font-semibold text-foreground">
              {t(currentLabelKey as never)}
            </h2>
            <div className="flex items-center gap-2">
              <div className="w-56">
                <Input
                  type="search"
                  placeholder={t("marketplace.search")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  size="sm"
                />
              </div>
              <IconButton
                variant="ghost"
                size="sm"
                shape="square"
                aria-label={t("marketplace.close")}
                title={t("marketplace.close")}
                onClick={onClose}
              >
                <XIcon size={18} />
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
                  src === "official"
                    ? "marketplace.tabs.official"
                    : "marketplace.tabs.others"
                )}
              </button>
            ))}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5">
            {category === "plugins" && (
              <div className="space-y-4">
                {pluginsToShow.length === 0 ? (
                  <div className="rounded-xl border border-border/40 bg-[var(--surface)] px-4 py-12 text-center">
                    <p className="text-sm text-muted-foreground">
                      {t("marketplace.empty")}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {pluginsToShow.map((plugin) => {
                      const installed = installedIds.has(plugin.id);
                      const publisher = plugin.author?.name || plugin.developer || t("marketplace.unknownPublisher");
                      return (
                        <ExtensionCard
                          key={plugin.id}
                          icon={
                            plugin.icon ? (
                              <img
                                src={plugin.icon}
                                alt={plugin.name}
                                className="h-6 w-6 rounded"
                              />
                            ) : undefined
                          }
                          monogram={plugin.icon ? undefined : plugin.name.trim().charAt(0).toUpperCase()}
                          title={plugin.name}
                          subtitle={
                            <>
                              <span className="truncate">{publisher}</span>
                              <span className="text-muted-foreground/60">•</span>
                              <span>v{plugin.version}</span>
                            </>
                          }
                          description={plugin.shortDescription || plugin.description}
                          onClick={() => onPluginClick(plugin)}
                          onAdd={() => onPluginClick(plugin)}
                          added={installed}
                          addLabel={t("marketplace.install")}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {category === "connectors" && (
              <ConnectorsPanel
                source={source}
                connections={connections}
                providers={providers}
                connectedProviders={connectedProviders}
                busyProvider={busyProvider}
                onConnect={onConnectProvider}
                onConfigure={onConfigureProvider}
                onDisconnect={onDisconnectConnection}
              />
            )}

            {category === "skills" && (
              <div className="space-y-4">
                {source === "others" || skillCatalog.length === 0 ? (
                  <div className="rounded-xl border border-border/40 bg-[var(--surface)] px-4 py-12 text-center">
                    <p className="text-sm text-muted-foreground">
                      {t("marketplace.empty")}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {skillCatalog.map((skill) => {
                      const installed = installedIds.has(skill.id);
                      return (
                        <ExtensionCard
                          key={skill.id}
                          monogram={skill.name.trim().charAt(0).toUpperCase()}
                          title={skill.name}
                          subtitle={
                            <>
                              <span className="truncate">DUYA Team</span>
                              <span className="text-muted-foreground/60">•</span>
                              <span>v{skill.version}</span>
                            </>
                          }
                          description={skill.description}
                          onClick={() => onPluginClick(skill)}
                          onAdd={() => onPluginClick(skill)}
                          added={installed}
                          addLabel={t("marketplace.install")}
                        />
                      );
                    })}
                  </div>
                )}
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
  providers,
  connectedProviders,
  busyProvider,
  onConnect,
  onConfigure,
  onDisconnect,
}: {
  source: MarketSource;
  connections: AppConnectionStatusDTO[];
  providers: AppConnectionProviderDTO[];
  connectedProviders: Set<ProviderId>;
  busyProvider: ProviderId | null;
  onConnect: (provider: AppConnectionProviderDTO) => void;
  onConfigure: (provider: AppConnectionProviderDTO) => void;
  onDisconnect: (connectionId: string) => void;
}) {
  const { t } = useTranslation();

  if (source === "others") {
    return (
      <div className="rounded-xl border border-border/40 bg-[var(--surface)] px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          {t("marketplace.empty")}
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {providers.map((provider) => {
        const isConnected = connectedProviders.has(provider.id);
        const connection = connections.find(
          (c) => c.provider === provider.id && c.status === "connected"
        );
        return (
          <ExtensionCard
            key={provider.id}
            icon={<ConnectorIcon provider={provider.id} size={24} />}
            title={provider.label}
            subtitle={
              isConnected ? (
                <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-emerald-500/10 text-emerald-600">
                  {t("marketplace.connectors.connected")}
                </span>
              ) : null
            }
            description={provider.description}
            actions={
              !provider.configured && provider.supportsManualConfiguration ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busyProvider === provider.id}
                  onClick={() => onConfigure(provider)}
                >
                  {t("marketplace.connectors.configure")}
                </Button>
              ) : isConnected && connection ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busyProvider === provider.id}
                  onClick={() => onDisconnect(connection.id)}
                >
                  {t("marketplace.connectors.disconnect")}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!provider.configured || busyProvider === provider.id}
                  title={provider.configurationHint}
                  onClick={() => onConnect(provider)}
                >
                  {t("marketplace.connectors.connect")}
                </Button>
              )
            }
          />
        );
      })}
    </div>
  );
}
