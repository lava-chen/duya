"use client";

import { ArrowLeftIcon, WarningIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { PluginRegistryEntry, PluginCatalogEntry } from "@/lib/plugin-types";
import { RuntimeStatusBadge } from "./RuntimeStatusBadge";

interface PluginManagementViewProps {
  installed: PluginRegistryEntry[];
  catalog: PluginCatalogEntry[];
  updates: PluginRegistryEntry[];
  issues: PluginRegistryEntry[];
  onBack: () => void;
  onPluginClick: (pluginId: string) => void;
  onEnable: (pluginId: string) => void;
  onDisable: (pluginId: string) => void;
  onRemove: (pluginId: string) => void;
  busyPluginId: string | null;
}

export function PluginManagementView({
  installed,
  catalog,
  updates,
  issues,
  onBack,
  onPluginClick,
  onEnable,
  onDisable,
  onRemove,
  busyPluginId,
}: PluginManagementViewProps) {
  return (
    <div className="space-y-6">
      {/* Back button */}
      <button
        type="button"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        onClick={onBack}
      >
        <ArrowLeftIcon size={16} />
        Back to Plugins
      </button>

      {/* Issues section */}
      {issues.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-amber-500 mb-3 flex items-center gap-2">
            <WarningIcon size={16} />
            Issues ({issues.length})
          </h3>
          <div className="space-y-2">
            {issues.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.03] px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{item.name}</span>
                    <RuntimeStatusBadge status={item.runtimeStatus} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {item.runtimeStatus === "needs_setup"
                      ? "Requires setup"
                      : item.runtimeStatus === "failed_to_load"
                      ? "Failed to load"
                      : (item.permissionDenied?.length ?? 0) > 0
                      ? `${item.permissionDenied?.length} permission(s) denied`
                      : "Needs attention"}
                  </p>
                </div>
                <button
                  type="button"
                  className="text-xs text-accent hover:underline shrink-0"
                  onClick={() => onPluginClick(item.id)}
                >
                  View details
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Updates section */}
      {updates.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">
            Updates Available ({updates.length})
          </h3>
          <div className="space-y-2">
            {updates.map((item) => {
              const catalogEntry = catalog.find((c) => c.id === item.id);
              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-surface/40 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{item.name}</span>
                      <span className="text-xs text-muted-foreground">v{item.version}</span>
                      {catalogEntry && (
                        <span className="text-xs text-accent">&rarr; v{catalogEntry.version}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Installed plugins */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">
          Installed Plugins ({installed.length})
        </h3>
        {installed.length === 0 ? (
          <div className="rounded-lg border border-border/40 bg-surface/40 px-4 py-8 text-center text-sm text-muted-foreground">
            No plugins installed yet.
          </div>
        ) : (
          <div className="space-y-2">
            {installed.map((item) => {
              const catalogEntry = catalog.find((c) => c.id === item.id);
              const monogram = item.name.trim().charAt(0).toUpperCase();
              const hasIssues =
                item.runtimeStatus === "needs_setup" ||
                item.runtimeStatus === "failed_to_load" ||
                (item.permissionDenied?.length ?? 0) > 0;

              return (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors cursor-pointer",
                    hasIssues
                      ? "border-amber-500/20 bg-amber-500/[0.02] hover:bg-amber-500/[0.04]"
                      : "border-border/40 bg-surface/40 hover:bg-surface/60"
                  )}
                  onClick={() => onPluginClick(item.id)}
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-xs font-semibold text-accent">
                    {monogram}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{item.name}</span>
                      <span className="text-xs text-muted-foreground">v{item.version}</span>
                      <RuntimeStatusBadge status={item.runtimeStatus} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {catalogEntry?.shortDescription || catalogEntry?.description || item.description}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="px-2 py-1 text-xs rounded-md border border-border/60 text-muted-foreground hover:text-foreground disabled:opacity-50"
                      disabled={busyPluginId === item.id}
                      onClick={() =>
                        item.enabled ? onDisable(item.id) : onEnable(item.id)
                      }
                    >
                      {item.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      className="px-2 py-1 text-xs rounded-md text-muted-foreground/60 hover:text-red-500 disabled:opacity-50"
                      disabled={busyPluginId === item.id}
                      onClick={() => onRemove(item.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}