"use client";

// MarketplacePage — the marketplace half of the extensions page.
//
// Scope (user decision): the marketplace surfaces PLUGINS only. The other
// marketplace kinds (standalone skills, connectors, source management) live
// under the "Installed" tab or behind the collapsed source manager, so this
// page stays a single, dense plugin grid that fills the available width.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import { getPluginAPI } from "@/lib/plugin-ipc";
import type { MarketplaceViewDTO } from "@/lib/plugin-ipc";
import type { PluginCatalogEntry, PluginRegistryEntry } from "@/lib/plugin-types";
import { MarketplaceRowItem } from "./MarketplaceRowItem";
import { GlobeSimpleIcon } from "@/components/icons";

type MarketSource = "official" | "others";

interface MarketplacePageProps {
  installedPlugins: PluginRegistryEntry[];
  busyPluginId: string | null;
  /** Uninstalled plugin clicked → open the install-and-connect dialog. */
  onOpenInstall: (plugin: PluginCatalogEntry) => void;
  /** Installed plugin clicked → open the existing detail page. */
  onOpenDetail: (pluginId: string) => void;
}

export function MarketplacePage({
  installedPlugins,
  busyPluginId,
  onOpenInstall,
  onOpenDetail,
}: MarketplacePageProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState<MarketSource>("official");
  const [search, setSearch] = useState("");
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  // Marketplace source management state.
  const [marketplaces, setMarketplaces] = useState<MarketplaceViewDTO[]>([]);
  const [marketplaceBusy, setMarketplaceBusy] = useState<string | null>(null);
  const [sourceInput, setSourceInput] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);

  const reloadCatalog = useCallback(async () => {
    const api = getPluginAPI();
    if (!api) return;
    const res = await api.catalog.list();
    if (res.success) setCatalog(res.data);
  }, []);

  const reloadMarketplaces = useCallback(async () => {
    const api = getPluginAPI();
    if (!api) return;
    const res = await api.registry.marketplace.list();
    if (res.success) setMarketplaces(res.data);
  }, []);

  useEffect(() => {
    void reloadCatalog();
    void reloadMarketplaces();
  }, [reloadCatalog, reloadMarketplaces]);

  const installedIds = useMemo(
    () => new Set(installedPlugins.map((p) => p.id)),
    [installedPlugins]
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

  // Attribution-based source tabs: builtin plugins and anything from the
  // official marketplace are "official"; other marketplaces and local
  // installs are "others". Skills are excluded here — the marketplace
  // tab is plugins-only by design.
  const officialPlugins = useMemo(
    () =>
      filteredCatalog.filter(
        (c) =>
          c.kind !== "skill" &&
          (c.source === "bundled" || c.marketplace === "official")
      ),
    [filteredCatalog]
  );
  const otherPlugins = useMemo(
    () =>
      filteredCatalog.filter(
        (c) => c.kind !== "skill" && !officialPlugins.includes(c)
      ),
    [filteredCatalog, officialPlugins]
  );

  const openPlugin = useCallback(
    (plugin: PluginCatalogEntry) => {
      if (installedIds.has(plugin.id)) {
        onOpenDetail(plugin.id);
      } else {
        onOpenInstall(plugin);
      }
    },
    [installedIds, onOpenDetail, onOpenInstall]
  );

  const pluginsToShow = source === "official" ? officialPlugins : otherPlugins;

  return (
    <div className="flex flex-col min-w-0">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-1">
          {(["official", "others"] as MarketSource[]).map((src) => (
            <button
              key={src}
              type="button"
              onClick={() => setSource(src)}
              className={cn(
                "px-3 py-1.5 text-[13px] rounded-lg transition-colors",
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
        <div className="flex items-center gap-2">
          <div className="w-64">
            <Input
              type="search"
              placeholder={t("marketplace.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              size="sm"
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setSourcesOpen((v) => !v)}
          >
            <GlobeSimpleIcon size={14} />
            {t("marketplace.categories.sources")}
          </Button>
        </div>
      </div>

      {/* Marketplace source manager (collapsed by default) */}
      {sourcesOpen && (
        <div className="mb-4">
          <SourcesPanel
            marketplaces={marketplaces}
            busy={marketplaceBusy}
            sourceInput={sourceInput}
            sourceError={sourceError}
            onSourceInputChange={setSourceInput}
            onAdd={async (src) => {
              const api = getPluginAPI();
              if (!api) return;
              setSourceError(null);
              setMarketplaceBusy("__adding");
              try {
                const res = await api.registry.marketplace.add({ source: src });
                if (res.success) {
                  setSourceInput("");
                  await Promise.all([reloadMarketplaces(), reloadCatalog()]);
                } else {
                  setSourceError(res.error ?? t("extensions.actionFailed"));
                }
              } finally {
                setMarketplaceBusy(null);
              }
            }}
            onRefresh={async (name) => {
              const api = getPluginAPI();
              if (!api) return;
              setMarketplaceBusy(name ?? "__all");
              try {
                await api.registry.marketplace.refresh(name);
                await Promise.all([reloadMarketplaces(), reloadCatalog()]);
              } finally {
                setMarketplaceBusy(null);
              }
            }}
            onRemove={async (name) => {
              const api = getPluginAPI();
              if (!api) return;
              setMarketplaceBusy(name);
              try {
                const res = await api.registry.marketplace.remove(name);
                if (!res.success) {
                  setSourceError(res.error ?? t("extensions.actionFailed"));
                } else {
                  setSourceError(null);
                }
                await Promise.all([reloadMarketplaces(), reloadCatalog()]);
              } finally {
                setMarketplaceBusy(null);
              }
            }}
          />
        </div>
      )}

      {/* Plugin grid — full width, auto-fill columns */}
      <MarketplaceGrid
        plugins={pluginsToShow}
        installedIds={installedIds}
        busyPluginId={busyPluginId}
        emptyLabel={t("marketplace.empty")}
        onOpen={openPlugin}
      />
    </div>
  );
}

/** Two-column row list of plugin entries — wide windows show two per row. */
function MarketplaceGrid({
  plugins,
  installedIds,
  busyPluginId,
  emptyLabel,
  onOpen,
}: {
  plugins: PluginCatalogEntry[];
  installedIds: Set<string>;
  busyPluginId: string | null;
  emptyLabel: string;
  onOpen: (plugin: PluginCatalogEntry) => void;
}) {
  const { t } = useTranslation();
  if (plugins.length === 0) {
    return (
      <div className="rounded-[14px] border border-border/40 bg-[var(--surface)] px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
      {plugins.map((plugin) => {
        const installed = installedIds.has(plugin.id);
        return (
          <MarketplaceRowItem
            key={`${plugin.marketplace ?? "local"}:${plugin.id}`}
            icon={<CardIcon plugin={plugin} />}
            title={plugin.name}
            description={plugin.shortDescription || plugin.description}
            onClick={() => onOpen(plugin)}
            onAdd={() => onOpen(plugin)}
            added={installed}
            busy={busyPluginId === plugin.id}
            addLabel={t("marketplace.install")}
          />
        );
      })}
    </div>
  );
}

/**
 * Brand icon with monogram fallback — fixes broken-image glyphs when a
 * `duya-file://` asset fails to load (plan 455 follow-up): `onError`
 * swaps to a tinted letter block instead of the browser broken icon.
 */
export function CardIcon({
  plugin,
  size = 44,
}: {
  plugin: PluginCatalogEntry;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const iconUrl = plugin.icon;
  // A card can be reused for a different plugin (the grid key is stable, but
  // the detail/install dialogs are not). Reset the failure latch whenever the
  // asset URL changes, otherwise a plugin whose icon resolves later would stay
  // stuck on the monogram.
  useEffect(() => {
    setFailed(false);
    setRetryTick(0);
  }, [iconUrl]);
  const iface =
    plugin.manifest?.schemaVersion === "duya.plugin.v2"
      ? plugin.manifest.interface
      : undefined;
  const brand = iface?.brandColor;
  // `name` is declared optional upstream; never let a blank name blank the tile.
  const letter = (plugin.name ?? "").trim().charAt(0).toUpperCase() || "?";

  // Some SVGs load slowly over the custom duya-file protocol; retry once
  // before falling back to the monogram so a transient read failure doesn't
  // hide a valid icon.
  const handleError = useCallback(() => {
    if (retryTick === 0) {
      setRetryTick((tick) => tick + 1);
    } else {
      setFailed(true);
    }
  }, [retryTick]);

  const src = retryTick > 0 && iconUrl ? `${iconUrl}#retry=${retryTick}` : iconUrl;

  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[10px] overflow-hidden"
      style={{
        width: size,
        height: size,
        backgroundColor: brand ? `${brand}1F` : "var(--surface-hover)",
      }}
    >
      {iconUrl && !failed ? (
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
          className="text-sm font-semibold"
          style={{ color: brand ?? "var(--accent)" }}
        >
          {letter}
        </span>
      )}
    </div>
  );
}

/**
 * Marketplace source management. Lists configured git/local marketplaces
 * with their sync status; add accepts owner/repo shorthand, https git URLs
 * (optional #ref), and local directory paths.
 */
function SourcesPanel({
  marketplaces,
  busy,
  sourceInput,
  sourceError,
  onSourceInputChange,
  onAdd,
  onRefresh,
  onRemove,
}: {
  marketplaces: MarketplaceViewDTO[];
  busy: string | null;
  sourceInput: string;
  sourceError: string | null;
  onSourceInputChange: (value: string) => void;
  onAdd: (source: string) => Promise<void>;
  onRefresh: (name?: string) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      {/* Add source */}
      <div className="rounded-[14px] border border-border/40 bg-[var(--surface)] p-4 space-y-2">
        <p className="text-sm font-medium text-foreground">
          {t("marketplace.sources.addTitle")}
        </p>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Input
              type="text"
              placeholder={t("marketplace.sources.addPlaceholder")}
              value={sourceInput}
              onChange={(e) => onSourceInputChange(e.target.value)}
              size="sm"
              disabled={busy !== null}
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            disabled={!sourceInput.trim() || busy !== null}
            onClick={() => void onAdd(sourceInput.trim())}
          >
            {busy === "__adding" ? t("marketplace.sources.adding") : t("marketplace.sources.add")}
          </Button>
        </div>
        {sourceError && (
          <p className="text-xs text-red-500 break-all">{sourceError}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("marketplace.sources.addHint")}
        </p>
      </div>

      {/* Marketplace list */}
      {marketplaces.length === 0 ? (
        <div className="rounded-[14px] border border-border/40 bg-[var(--surface)] px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t("marketplace.sources.empty")}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {marketplaces.map((market) => {
            const isBusy = busy === market.name || busy === "__all";
            return (
              <div
                key={market.name}
                className="rounded-[14px] border border-border/40 bg-[var(--surface)] p-4 flex items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">
                      {market.displayName || market.name}
                    </span>
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted/60 text-muted-foreground">
                      {market.kind === "git"
                        ? t("marketplace.sources.kindGit")
                        : t("marketplace.sources.kindLocal")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("marketplace.sources.pluginCount", {
                        count: market.pluginCount,
                      })}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-1">
                    {market.kind === "git" ? market.url : market.path}
                  </p>
                  {market.error && (
                    <p className="text-xs text-amber-600 mt-1 break-all">
                      {t("marketplace.sources.syncError")}: {market.error}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isBusy || busy !== null || market.kind !== "git"}
                    title={market.kind !== "git" ? t("marketplace.sources.localNoRefresh") : undefined}
                    onClick={() => void onRefresh(market.name)}
                  >
                    {t("marketplace.sources.refresh")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isBusy || busy !== null}
                    onClick={() => void onRemove(market.name)}
                  >
                    {t("marketplace.sources.remove")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
