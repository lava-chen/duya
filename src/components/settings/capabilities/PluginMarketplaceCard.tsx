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

  return (
    <SettingsCard className={`cursor-pointer transition-colors ${selected ? "border-accent/45 bg-accent/[0.03]" : "hover:border-border/70"}`}>
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
      <div className="flex items-start justify-between gap-4 min-h-[104px]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-foreground truncate">{plugin.name}</h3>
            <span className="text-xs text-muted-foreground shrink-0">
              v{plugin.version}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-500/10 text-zinc-400 uppercase shrink-0">
              {plugin.source}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mb-2 line-clamp-2">
            {plugin.description}
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            {capabilityKinds.map((kind) => (
              <CapabilityBadge key={kind} kind={kind} />
            ))}
            {authorName && (
              <span className="text-[11px] text-muted-foreground">
                {authorName}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0">
          {isInstalled ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-emerald-500/15 text-emerald-400">
              &#x2713; {t("settings.capabilities.actionInstalled" as never)}
            </span>
          ) : (
            <button
              type="button"
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md bg-accent text-black hover:opacity-90 transition-opacity"
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
      </div>
    </SettingsCard>
  );
}
