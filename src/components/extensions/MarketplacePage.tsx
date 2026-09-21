"use client";

// MarketplacePage — the marketplace half of the extensions page.
//
// Visual reference: ZCode's plugin store. A search field on top, a
// horizontally-scrolling strip of installed-plugin avatars, Official /
// Personal segment pills, then sections (Featured, categories for the
// official pool; per-source groups for personal pools) of two-column
// store cards. Rows hover with a soft surface tint; actions live on the
// right edge of each card.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { IconButton } from "@/components/ui/IconButton";
import { Modal } from "@/components/ui/page";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import { getPluginAPI } from "@/lib/plugin-ipc";
import type { MarketplaceViewDTO } from "@/lib/plugin-ipc";
import type { PluginCatalogEntry, PluginRegistryEntry } from "@/lib/plugin-types";
import { I18nContext } from "@/components/layout/I18nProvider";
import {
  ArrowsClockwiseIcon,
  DotsThreeIcon,
  GearSixIcon,
  GlobeSimpleIcon,
  PowerIcon,
  SpinnerGapIcon,
  TrashIcon,
  WarningIcon,
} from "@/components/icons";

type Segment = "official" | "personal";
type PluginCategoryKey =
  | "development"
  | "productivity"
  | "automation"
  | "research"
  | "data"
  | "communication"
  | "media"
  | "other";

/** Categories rendered in this order; unknown values fall into "other". */
const CATEGORY_ORDER: PluginCategoryKey[] = [
  "development",
  "productivity",
  "automation",
  "research",
  "data",
  "communication",
  "media",
  "other",
];

/** Categories show this many cards before collapsing behind "see more". */
const CATEGORY_VISIBLE_LIMIT = 6;

interface MarketplacePageProps {
  installedPlugins: PluginRegistryEntry[];
  busyPluginId: string | null;
  /** Uninstalled plugin clicked → open the install-and-connect dialog. */
  onOpenInstall: (plugin: PluginCatalogEntry) => void;
  /** Installed plugin clicked → open the existing detail page. */
  onOpenDetail: (pluginId: string) => void;
  /** Installed-strip "manage" action → jump to the Installed tab. */
  onManageInstalled: () => void;
  onPluginToggle: (pluginId: string, enabled: boolean) => void;
  onPluginRemove: (pluginId: string) => void;
}

export function MarketplacePage({
  installedPlugins,
  busyPluginId,
  onOpenInstall,
  onOpenDetail,
  onManageInstalled,
  onPluginToggle,
  onPluginRemove,
}: MarketplacePageProps) {
  const { t } = useTranslation();
  const { locale } = useContext(I18nContext);
  const [segment, setSegment] = useState<Segment>("official");
  const [search, setSearch] = useState("");
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
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

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([reloadCatalog(), reloadMarketplaces()]);
    } finally {
      setRefreshing(false);
    }
  }, [reloadCatalog, reloadMarketplaces]);

  const installedIds = useMemo(
    () => new Set(installedPlugins.map((p) => p.id)),
    [installedPlugins]
  );
  const installedById = useMemo(() => {
    const map = new Map<string, PluginRegistryEntry>();
    for (const p of installedPlugins) map.set(p.id, p);
    return map;
  }, [installedPlugins]);

  // Official sources are the pre-seeded ones; every registry name ends in
  // "official" (official, claude-plugins-official, codex-official, …).
  const officialNames = useMemo(
    () =>
      new Set(
        marketplaces
          .map((m) => m.name)
          .filter((name) => /official$/i.test(name))
      ),
    [marketplaces]
  );

  const isOfficialEntry = useCallback(
    (entry: PluginCatalogEntry) =>
      !entry.marketplace || officialNames.has(entry.marketplace),
    [officialNames]
  );

  const searchPool = useCallback(
    (pool: PluginCatalogEntry[]) => {
      const q = search.trim().toLowerCase();
      if (!q) return pool;
      return pool.filter((c) =>
        [c.name, c.displayName_zh, c.shortDescription, c.shortDescription_zh, c.description, c.description_zh]
          .some((field) => field?.toLowerCase().includes(q))
      );
    },
    [search]
  );

  const pluginsFor = useCallback(
    (seg: Segment) =>
      catalog.filter(
        (c) => c.kind !== "skill" && (seg === "official" ? isOfficialEntry(c) : !isOfficialEntry(c))
      ),
    [catalog, isOfficialEntry]
  );

  const officialCount = useMemo(() => pluginsFor("official").length, [pluginsFor]);
  const personalCount = useMemo(() => pluginsFor("personal").length, [pluginsFor]);

  // Hide the segment pills entirely when one side has nothing to show —
  // same behaviour as the store's Public/Personal segments.
  const showSegments = officialCount > 0 && personalCount > 0;
  const activeSegment: Segment =
    !showSegments && personalCount === 0 ? "official" : segment;

  const searching = search.trim().length > 0;

  const searchResults = useMemo(
    () => searchPool(catalog.filter((c) => c.kind !== "skill")),
    [catalog, searchPool]
  );

  const featured = useMemo(
    () =>
      searchPool(pluginsFor("official").filter((c) => c.featured)),
    [pluginsFor, searchPool]
  );

  const categoryGroups = useMemo(() => {
    const groups = new Map<PluginCategoryKey, PluginCatalogEntry[]>();
    for (const entry of searchPool(pluginsFor("official"))) {
      const key = (CATEGORY_ORDER as string[]).includes(entry.category)
        ? (entry.category as PluginCategoryKey)
        : "other";
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
    return CATEGORY_ORDER.filter((key) => groups.has(key)).map((key) => ({
      key,
      items: groups.get(key)!,
    }));
  }, [pluginsFor, searchPool]);

  const personalGroups = useMemo(() => {
    const byName = new Map<string, MarketplaceViewDTO>();
    for (const m of marketplaces) byName.set(m.name, m);
    const groups = new Map<string, PluginCatalogEntry[]>();
    for (const entry of searchPool(pluginsFor("personal"))) {
      const key = entry.marketplace || "personal";
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
    return [...groups.entries()].map(([name, items]) => ({
      key: name,
      title:
        byName.get(name)?.displayName ?? byName.get(name)?.name ?? name,
      items,
    }));
  }, [marketplaces, pluginsFor, searchPool]);

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

  const renderGrid = useCallback(
    (items: PluginCatalogEntry[]) => (
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {items.map((plugin) => (
          <StoreCard
            key={`${plugin.marketplace ?? "local"}:${plugin.id}`}
            plugin={plugin}
            locale={locale}
            installed={installedIds.has(plugin.id)}
            enabled={installedById.get(plugin.id)?.enabled ?? false}
            busy={busyPluginId === plugin.id}
            onOpen={() => openPlugin(plugin)}
            onInstall={() => {
              if (!installedIds.has(plugin.id)) onOpenInstall(plugin);
            }}
            onToggle={(enabled) => onPluginToggle(plugin.id, enabled)}
            onRemove={() => onPluginRemove(plugin.id)}
          />
        ))}
      </div>
    ),
    [busyPluginId, installedById, installedIds, locale, onOpenDetail, onOpenInstall, onPluginRemove, onPluginToggle, openPlugin]
  );

  return (
    <div className="flex flex-col min-w-0">
      {/* Toolbar: search left, refresh + sources right */}
      <div className="mb-4 flex items-center gap-2">
        <div className="w-full max-w-xs">
          <Input
            type="search"
            placeholder={t("marketplace.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="sm"
          />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <IconButton
            variant="ghost"
            size="sm"
            shape="square"
            aria-label={t("marketplace.sources.refresh")}
            title={t("marketplace.sources.refresh")}
            disabled={refreshing}
            onClick={() => void handleRefresh()}
          >
            <ArrowsClockwiseIcon
              size={15}
              className={cn(refreshing && "animate-spin")}
            />
          </IconButton>
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

      {/* Installed strip — avatar row with a manage action, only when
          something is installed (ZCode store behaviour). */}
      {installedPlugins.length > 0 && !searching && (
        <section className="mb-5">
          <div className="flex items-center justify-between border-b border-border pb-2">
            <h2 className="flex items-baseline gap-2 text-[15px] font-semibold text-foreground">
              {t("marketplace.installed.strip")}
              <span className="text-[13px] font-normal text-muted-foreground">
                {installedPlugins.length}
              </span>
            </h2>
            <button
              type="button"
              onClick={onManageInstalled}
              className="flex items-center gap-1 rounded-full px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground"
            >
              <GearSixIcon size={13} />
              {t("marketplace.installed.manage")}
            </button>
          </div>
          <div className="scrollbar-hide flex items-center gap-3 overflow-x-auto px-2 pb-1 pt-2 sm:-mx-2">
            {installedPlugins.map((plugin) => (
              <button
                key={plugin.id}
                type="button"
                title={plugin.name}
                aria-label={plugin.name}
                onClick={() => onOpenDetail(plugin.id)}
                className="shrink-0 rounded-xl outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <StoreAvatar name={plugin.name} icon={plugin.icon} />
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Official / Personal segment pills */}
      {showSegments && (
        <div className="mb-4 flex items-center gap-1">
          <SegmentPill
            active={activeSegment === "official"}
            label={t("marketplace.segment.official")}
            onClick={() => setSegment("official")}
          />
          <SegmentPill
            active={activeSegment === "personal"}
            label={t("marketplace.segment.personal")}
            onClick={() => setSegment("personal")}
          />
        </div>
      )}

      {/* Sections */}
      {searching ? (
        <StoreSection
          title={t("marketplace.searchResults", { count: searchResults.length })}
          count={searchResults.length}
        >
          {searchResults.length > 0 ? (
            renderGrid(searchResults)
          ) : (
            <DashedEmpty label={t("marketplace.empty")} />
          )}
        </StoreSection>
      ) : activeSegment === "official" ? (
        <>
          {officialCount === 0 ? (
            <DashedEmpty label={t("marketplace.empty")} />
          ) : (
            <>
              {featured.length > 0 && (
                <StoreSection
                  title={t("marketplace.featured")}
                  count={featured.length}
                >
                  {renderGrid(featured)}
                </StoreSection>
              )}
              {categoryGroups.map((group) => (
                <CategorySection key={group.key} title={t(`marketplace.category.${group.key}` as never)} count={group.items.length}>
                  {(open) => renderGrid(open ? group.items : group.items.slice(0, CATEGORY_VISIBLE_LIMIT))}
                </CategorySection>
              ))}
            </>
          )}
        </>
      ) : (
        <>
          {personalGroups.length === 0 ? (
            <DashedEmpty label={t("marketplace.personal.empty")} />
          ) : (
            personalGroups.map((group) => (
              <StoreSection key={group.key} title={group.title} count={group.items.length}>
                {renderGrid(group.items)}
              </StoreSection>
            ))
          )}
        </>
      )}

      {/* Marketplace source manager — opens as a centered modal so the
          plugin grid stays full-width underneath. */}
      <Modal
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        size="lg"
        title={t("marketplace.sources.manageTitle")}
        description={t("marketplace.sources.manageDescription")}
      >
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
      </Modal>
    </div>
  );
}

/** Rounded-full segment pill (ZCode store "Public / Personal" control). */
function SegmentPill({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        active
          ? "bg-[var(--surface-hover)] text-foreground"
          : "text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground"
      )}
    >
      {label}
    </button>
  );
}

/** Section header + divider + content, matching the store's group style. */
function StoreSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6 last:mb-0">
      <div className="flex items-baseline gap-2 border-b border-border pb-2">
        <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
        <span className="text-[13px] text-muted-foreground">{count}</span>
      </div>
      <div className="pt-2">{children}</div>
    </section>
  );
}

/**
 * Category section with collapse: shows the first CATEGORY_VISIBLE_LIMIT
 * cards, then a text toggle to reveal the rest (ZCode store behaviour).
 */
function CategorySection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: (open: boolean) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const collapsible = count > CATEGORY_VISIBLE_LIMIT;
  return (
    <section className="mb-6 last:mb-0">
      <div className="flex items-baseline gap-2 border-b border-border pb-2">
        <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
        <span className="text-[13px] text-muted-foreground">{count}</span>
      </div>
      <div className="pt-2">{children(open || !collapsible)}</div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 rounded-full px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground"
        >
          {open
            ? t("marketplace.seeLess")
            : t("marketplace.seeMore", { count: count - CATEGORY_VISIBLE_LIMIT })}
        </button>
      )}
    </section>
  );
}

/** Dashed empty / loading placeholder (ZCode store empty states). */
function DashedEmpty({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

/** 40px avatar tile used by the installed strip. */
function StoreAvatar({ name, icon }: { name: string; icon?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [icon]);
  const letter = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="flex h-10 w-10 shrink-0 select-none items-center justify-center overflow-hidden rounded-xl bg-[var(--surface-hover)]">
      {icon && !failed ? (
        <img
          src={icon}
          alt=""
          draggable={false}
          decoding="async"
          className="h-[62%] w-[62%] object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-sm font-semibold text-muted-foreground">{letter}</span>
      )}
    </span>
  );
}

/**
 * Store card — ZCode plugin-store card: icon, name, one-line description,
 * install pill for uninstalled entries, hover-reveal "…" menu (toggle /
 * remove) for installed ones.
 */
function StoreCard({
  plugin,
  locale,
  installed,
  enabled,
  busy,
  onOpen,
  onInstall,
  onToggle,
  onRemove,
}: {
  plugin: PluginCatalogEntry;
  locale: string;
  installed: boolean;
  enabled: boolean;
  busy: boolean;
  onOpen: () => void;
  onInstall: () => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const displayName =
    locale === "zh" ? plugin.displayName_zh || plugin.name : plugin.name;
  const description =
    locale === "zh"
      ? plugin.shortDescription_zh || plugin.shortDescription || plugin.description_zh || plugin.description
      : plugin.shortDescription || plugin.description;
  const installLabel = t("marketplace.install");

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onOpen();
      }
    },
    [onOpen]
  );

  return (
    <div
      role="button"
      tabIndex={0}
      className="group/card flex min-w-0 cursor-pointer items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      onClick={onOpen}
      onKeyDown={handleKeyDown}
    >
      <CardIcon plugin={plugin} size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-semibold text-foreground">
            {displayName}
          </span>
        </div>
        {description ? (
          <div className="mt-0.5 truncate text-[13px] text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      <div
        className="flex shrink-0 items-center gap-1.5"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {installed ? (
          <CardMenu
            enabled={enabled}
            busy={busy}
            onToggle={onToggle}
            onRemove={onRemove}
          />
        ) : (
          <button
            type="button"
            disabled={busy}
            aria-label={installLabel}
            onClick={onInstall}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3.5 py-1 text-[13px] font-medium transition-colors",
              "bg-[var(--surface-hover)] text-foreground hover:bg-[var(--surface)]",
              "disabled:cursor-not-allowed disabled:opacity-60"
            )}
          >
            {busy ? (
              <>
                <SpinnerGapIcon size={13} className="animate-spin" />
                <span>{t("marketplace.dialog.installing")}</span>
              </>
            ) : (
              <span>{installLabel}</span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/** Hover-reveal "…" menu with toggle / remove actions (installed cards). */
function CardMenu({
  enabled,
  busy,
  onToggle,
  onRemove,
}: {
  enabled: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <IconButton
        variant="ghost"
        size="sm"
        shape="square"
        aria-label={t("extensions.actions.more")}
        title={t("extensions.actions.more")}
        disabled={busy}
        className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/card:opacity-100 data-[open]:opacity-100"
        data-open={open || undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <DotsThreeIcon size={16} />
      </IconButton>
      {open && (
        <div
          className="absolute right-0 top-full z-20 mt-1 w-36 rounded-[10px] border p-1 shadow-lg"
          style={{
            backgroundColor: "var(--main-bg)",
            borderColor: "var(--border)",
            boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
          }}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onToggle(!enabled);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            <PowerIcon size={13} className="text-muted-foreground" />
            {enabled ? t("extensions.actions.disable") : t("extensions.actions.enable")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--error)] transition-colors hover:bg-[var(--error-soft)] disabled:opacity-50"
          >
            <TrashIcon size={13} />
            {t("extensions.actions.remove")}
          </button>
        </div>
      )}
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
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-xl"
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
 * Marketplace source management (ZCode "Marketplace sources" dialog style):
 * rows with name, plugin count and per-row refresh / remove icon buttons;
 * add accepts owner/repo shorthand, https git URLs (optional #ref), and
 * local directory paths.
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
      <div className="space-y-2 rounded-xl border border-dashed border-border p-4">
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
            {busy === "__adding" ? (
              <>
                <SpinnerGapIcon size={13} className="animate-spin" />
                {t("marketplace.sources.adding")}
              </>
            ) : (
              t("marketplace.sources.add")
            )}
          </Button>
        </div>
        {sourceError && (
          <p className="whitespace-pre-wrap break-all text-xs text-[var(--error)]">{sourceError}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("marketplace.sources.addHint")}
        </p>
      </div>

      {/* Marketplace list */}
      {marketplaces.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t("marketplace.sources.empty")}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {marketplaces.map((market) => {
            const isBusy = busy === market.name || busy === "__all";
            const isOfficial = /official$/i.test(market.name);
            return (
              <div
                key={market.name}
                className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--surface-hover)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {market.displayName || market.name}
                    </span>
                    <span className="shrink-0 rounded-full bg-[var(--surface-hover)] px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {market.kind === "git"
                        ? t("marketplace.sources.kindGit")
                        : t("marketplace.sources.kindLocal")}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t("marketplace.sources.pluginCount", {
                        count: market.pluginCount,
                      })}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {market.kind === "git" ? market.url : market.path}
                  </p>
                  {market.error && (
                    <p className="mt-0.5 flex items-center gap-1 break-all text-xs text-[var(--error)]">
                      <WarningIcon size={12} className="shrink-0" />
                      {t("marketplace.sources.syncError")}: {market.error}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconButton
                    variant="ghost"
                    size="sm"
                    shape="square"
                    disabled={isBusy || busy !== null || market.kind !== "git"}
                    title={
                      market.kind !== "git"
                        ? t("marketplace.sources.localNoRefresh")
                        : t("marketplace.sources.refresh")
                    }
                    aria-label={t("marketplace.sources.refresh")}
                    onClick={() => void onRefresh(market.name)}
                  >
                    {isBusy ? (
                      <SpinnerGapIcon size={14} className="animate-spin" />
                    ) : (
                      <ArrowsClockwiseIcon size={14} />
                    )}
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    shape="square"
                    disabled={isBusy || busy !== null || isOfficial}
                    title={
                      isOfficial
                        ? t("marketplace.sources.officialNoRemove")
                        : t("marketplace.sources.remove")
                    }
                    aria-label={t("marketplace.sources.remove")}
                    className="text-[var(--error)] hover:bg-[var(--error-soft)]"
                    onClick={() => void onRemove(market.name)}
                  >
                    <TrashIcon size={14} />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
