"use client";

import { useMemo } from "react";
import { IconButton } from "@/components/ui/IconButton";
import { Switch } from "@/components/ui/Switch";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import { TrashIcon } from "@/components/icons";
import type { PluginCatalogEntry, PluginRegistryEntry } from "@/lib/plugin-types";
import { normalizeManifestComponents } from "@/lib/plugin-types";

interface PluginsSubPageProps {
  installed: PluginRegistryEntry[];
  catalog: PluginCatalogEntry[];
  busyPluginId: string | null;
  searchQuery: string;
  onPluginClick: (pluginId: string) => void;
  onEnable: (pluginId: string) => void;
  onDisable: (pluginId: string) => void;
  onRemove: (pluginId: string) => void;
  onCreatePlugin: () => void;
}

interface CapabilityCounts {
  skills: number;
  mcp: number;
  connectors: number;
}

function countCapabilities(plugin: PluginRegistryEntry): CapabilityCounts {
  const manifest = plugin.manifest;
  if (!manifest) return { skills: 0, mcp: 0, connectors: 0 };
  const components = normalizeManifestComponents(manifest);
  return {
    skills: components.skills.length,
    mcp: components.mcpServers.length,
    connectors: components.appConnections.length,
  };
}

function formatContents(counts: CapabilityCounts): string {
  const parts: string[] = [];
  if (counts.skills > 0) {
    parts.push(`${counts.skills} skill${counts.skills === 1 ? "" : "s"}`);
  }
  if (counts.mcp > 0) {
    parts.push(`${counts.mcp} mcp${counts.mcp === 1 ? "" : "s"}`);
  }
  if (counts.connectors > 0) {
    parts.push(`${counts.connectors} connector${counts.connectors === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

function formatDateLabel(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

export function PluginsSubPage({
  installed,
  busyPluginId,
  searchQuery,
  onPluginClick,
  onEnable,
  onDisable,
  onRemove,
}: PluginsSubPageProps) {
  const { t } = useTranslation();

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return installed;
    const q = searchQuery.toLowerCase();
    return installed.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q)
    );
  }, [installed, searchQuery]);

  if (installed.length === 0) {
    return (
      <div className="rounded-xl border border-border/40 bg-[var(--surface)] px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          {t("extensions.empty.plugins")}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/40 bg-[var(--surface)] overflow-hidden">
      {/* Header */}
      <div
        className="grid items-center gap-4 px-4 py-2 text-xs font-medium text-muted-foreground border-b border-border/30"
        style={{ gridTemplateColumns: "2fr 200px 120px 100px" }}
      >
        <div>{t("extensions.table.plugin")}</div>
        <div>{t("extensions.table.contents")}</div>
        <div>{t("extensions.table.updated")}</div>
        <div className="text-right">{t("extensions.table.actions")}</div>
      </div>

      {/* Rows */}
      {filtered.map((item) => {
        const busy = busyPluginId === item.id;
        const contents = formatContents(countCapabilities(item));
        return (
          <div
            key={item.id}
            className={cn(
              "grid items-center gap-4 px-4 py-3 text-sm border-b border-border/20 transition-colors last:border-b-0",
              "hover:bg-[var(--surface-hover)]"
            )}
            style={{ gridTemplateColumns: "2fr 200px 120px 100px" }}
          >
            <button
              type="button"
              onClick={() => onPluginClick(item.id)}
              className="text-left font-medium text-foreground hover:text-accent truncate"
            >
              {item.name}
            </button>
            <div className="truncate text-muted-foreground">
              {contents || "—"}
            </div>
            <div className="text-muted-foreground">
              {formatDateLabel(item.updatedAt || item.installedAt)}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Switch
                checked={item.enabled}
                disabled={busy}
                ariaLabel={item.enabled ? t("extensions.actions.disable") : t("extensions.actions.enable")}
                onCheckedChange={() =>
                  item.enabled ? onDisable(item.id) : onEnable(item.id)
                }
              />
              <IconButton
                variant="ghost"
                size="sm"
                shape="square"
                aria-label={t("extensions.actions.remove")}
                title={t("extensions.actions.remove")}
                disabled={busy}
                onClick={() => onRemove(item.id)}
              >
                <TrashIcon size={14} />
              </IconButton>
            </div>
          </div>
        );
      })}
    </div>
  );
}
