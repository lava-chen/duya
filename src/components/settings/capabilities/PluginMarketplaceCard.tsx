"use client";

import { SettingsCard } from "@/components/settings/ui";
import { useTranslation } from "@/hooks/useTranslation";
import { CapabilityBadge, type CapabilityKind } from "./CapabilityBadge";
import type { PluginCatalogEntry } from "@/lib/plugin-types";

interface PluginMarketplaceCardProps {
  plugin: PluginCatalogEntry;
  isInstalled: boolean;
  selected?: boolean;
  onInstall: (pluginId: string) => void;
  onClick: (pluginId: string) => void;
}

export function PluginMarketplaceCard({
  plugin,
  isInstalled,
  selected = false,
  onInstall,
  onClick,
}: PluginMarketplaceCardProps) {
  const { t } = useTranslation();

  const capabilityKinds: CapabilityKind[] = [];
  const counts = plugin.capabilityCounts ?? { skills: 0, mcpServers: 0, cli: 0, ui: 0, hooks: 0 };
  if (counts.skills > 0) capabilityKinds.push("skills");
  if (counts.mcpServers > 0) capabilityKinds.push("mcpServers");
  if (counts.cli > 0) capabilityKinds.push("cli");
  if (counts.ui > 0) capabilityKinds.push("ui");
  if (counts.hooks > 0) capabilityKinds.push("hooks");

  const authorName = plugin.author?.name ?? "";
  const monogram = plugin.name.trim().charAt(0).toUpperCase();

  return (
    <SettingsCard
      className={`cursor-pointer border transition-all ${
        selected
          ? "border-white/14 bg-white/[0.045] shadow-[0_0_0_1px_rgba(255,255,255,0.02)]"
          : "border-white/6 bg-transparent hover:border-white/12 hover:bg-white/[0.025]"
      }`}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => onClick(plugin.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick(plugin.id);
          }
        }}
        className="w-full text-left"
      >
        <div className="flex min-h-[118px] items-start gap-4 px-4 py-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-[linear-gradient(160deg,rgba(84,93,122,0.28),rgba(34,37,48,0.48))] text-base font-semibold text-white/90">
            {monogram}
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-[15px] font-semibold text-foreground">
                    {plugin.name}
                  </h3>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    v{plugin.version}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/80">
                  <span>{plugin.source}</span>
                  <span className="h-1 w-1 rounded-full bg-white/20" />
                  <span>{plugin.category}</span>
                  {authorName && (
                    <>
                      <span className="h-1 w-1 rounded-full bg-white/20" />
                      <span className="normal-case tracking-normal text-muted-foreground">
                        {authorName}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="shrink-0">
                {isInstalled ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs text-emerald-300">
                    &#x2713; {t("settings.capabilities.actionInstalled" as never)}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full bg-accent px-3.5 py-1.5 text-xs font-medium text-black transition-opacity hover:opacity-90"
                    onClick={(e) => {
                      e.stopPropagation();
                      onInstall(plugin.id);
                    }}
                  >
                    {t("settings.capabilities.actionInstall" as never)}
                  </button>
                )}
              </div>
            </div>

            <p className="mb-3 max-w-[52ch] text-sm leading-6 text-muted-foreground line-clamp-2">
              {plugin.description}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              {capabilityKinds.map((kind) => (
                <CapabilityBadge key={kind} kind={kind} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </SettingsCard>
  );
}
