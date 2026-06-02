"use client";

import { PlusIcon, CheckIcon, WarningIcon, ProhibitIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { PluginCatalogEntry } from "@/lib/plugin-types";

interface PluginCardProps {
  plugin: PluginCatalogEntry;
  isInstalled: boolean;
  isEnabled: boolean;
  hasIssues: boolean;
  onInstallClick: (plugin: PluginCatalogEntry) => void;
  onClick: (plugin: PluginCatalogEntry) => void;
}

export function PluginCard({
  plugin,
  isInstalled,
  isEnabled,
  hasIssues,
  onInstallClick,
  onClick,
}: PluginCardProps) {
  const monogram = plugin.name.trim().charAt(0).toUpperCase();

  const renderActionButton = () => {
    if (hasIssues) {
      return (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-amber-500/20 bg-amber-500/10 text-amber-500">
          <WarningIcon size={16} />
        </div>
      );
    }
    if (isInstalled && isEnabled) {
      return (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <CheckIcon size={16} />
        </div>
      );
    }
    if (isInstalled && !isEnabled) {
      return (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-muted-foreground">
          <ProhibitIcon size={16} />
        </div>
      );
    }
    return (
      <div
        role="button"
        tabIndex={0}
        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-surface/60 text-muted-foreground transition-all hover:border-accent/40 hover:bg-accent/10 hover:text-accent"
        onClick={(e) => {
          e.stopPropagation();
          onInstallClick(plugin);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            e.preventDefault();
            onInstallClick(plugin);
          }
        }}
        aria-label={`Install ${plugin.name}`}
      >
        <PlusIcon size={16} />
      </div>
    );
  };

  return (
    <button
      type="button"
      className={cn(
        "group w-full rounded-xl border px-4 py-4 text-left transition-all duration-150",
        "border-border/40 bg-surface/40",
        "hover:border-accent/20 hover:bg-surface/60"
      )}
      onClick={() => onClick(plugin)}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-sm font-semibold text-accent">
          {plugin.icon ? (
            <img src={plugin.icon} alt={plugin.name} className="h-6 w-6 rounded" />
          ) : (
            monogram
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground truncate">
              {plugin.name}
            </h3>
            {isInstalled && (
              <span className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                isEnabled
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground"
              )}>
                {isEnabled ? "Enabled" : "Disabled"}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
            {plugin.shortDescription || plugin.description}
          </p>
        </div>

        <div className="shrink-0 self-center">
          {renderActionButton()}
        </div>
      </div>
    </button>
  );
}