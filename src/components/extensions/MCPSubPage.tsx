"use client";

import { useMemo } from "react";
import {
  TrashIcon,
  NotePencilIcon,
  PowerIcon,
  PowerOffIcon,
  ServerIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import type { MCPServerConfig } from "@/types";
import type { MCPPluginDeclaredServerDTO } from "@/lib/mcp-inventory-types";

interface MCPSubPageProps {
  servers: MCPServerConfig[];
  pluginMCPs: MCPPluginDeclaredServerDTO[];
  searchQuery: string;
  onAdd: () => void;
  onEdit: (server: MCPServerConfig) => void;
  onDelete: (name: string) => void;
  onToggleEnabled: (server: MCPServerConfig) => void;
}

interface MCPRow {
  id: string;
  name: string;
  source: "manual" | "plugin";
  pluginName?: string;
  command: string;
  enabled: boolean;
  config?: MCPServerConfig;
  pluginMeta?: MCPPluginDeclaredServerDTO;
}

export function MCPSubPage({
  servers,
  pluginMCPs,
  searchQuery,
  onAdd,
  onEdit,
  onDelete,
  onToggleEnabled,
}: MCPSubPageProps) {
  const { t } = useTranslation();

  const rows: MCPRow[] = useMemo(() => {
    const manual: MCPRow[] = servers.map((s) => ({
      id: `manual-${s.name}`,
      name: s.name,
      source: "manual",
      command: `${s.command ?? ""} ${(s.args ?? []).join(" ")}`.trim(),
      enabled: s.enabled,
      config: s,
    }));
    const fromPlugins: MCPRow[] = pluginMCPs.map((p) => ({
      id: `plugin-${p.pluginId}-${p.name}`,
      name: p.name,
      source: "plugin",
      pluginName: p.pluginName,
      command: `${p.command} ${(p.args ?? []).join(" ")}`.trim(),
      enabled: p.effective,
      pluginMeta: p,
    }));
    const all = [...manual, ...fromPlugins];
    if (!searchQuery.trim()) return all;
    const q = searchQuery.toLowerCase();
    return all.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.command.toLowerCase().includes(q)
    );
  }, [servers, pluginMCPs, searchQuery]);

  const totalMcp = servers.length + pluginMCPs.length;

  return (
    <div className="space-y-3">
      {totalMcp === 0 ? (
        <div className="rounded-xl border border-border/40 bg-[var(--surface)] px-4 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {t("extensions.empty.mcp")}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border/40 bg-[var(--surface)] overflow-hidden">
          {/* Header */}
          <div
            className="grid items-center gap-4 px-4 py-2 text-xs font-medium text-muted-foreground border-b border-border/30"
            style={{ gridTemplateColumns: "1.5fr 120px 2fr 120px" }}
          >
            <div>{t("extensions.mcp.table.name")}</div>
            <div>{t("extensions.mcp.table.source")}</div>
            <div>{t("extensions.mcp.table.command")}</div>
            <div className="text-right">{t("extensions.table.actions")}</div>
          </div>

          {/* Rows */}
          {rows.map((row) => (
            <div
              key={row.id}
              className={cn(
                "grid items-center gap-4 px-4 py-3 text-sm border-b border-border/20 transition-colors last:border-b-0",
                "hover:bg-[var(--surface-hover)]"
              )}
              style={{ gridTemplateColumns: "1.5fr 120px 2fr 120px" }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <ServerIcon size={16} className="shrink-0 text-muted-foreground" />
                <span className="font-medium text-foreground truncate">{row.name}</span>
              </div>
              <div>
                {row.source === "plugin" ? (
                  <span className="inline-flex items-center rounded-md bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600">
                    {row.pluginName || t("extensions.mcp.pluginBadge")}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{t("extensions.mcp.table.manual")}</span>
                )}
              </div>
              <div className="truncate text-muted-foreground font-mono text-xs" title={row.command}>
                {row.command}
              </div>
              <div className="flex items-center justify-end gap-0.5">
                {row.source === "manual" && row.config ? (
                  <>
                    <IconButton
                      variant="default"
                      size="sm"
                      aria-label={row.enabled ? t("extensions.actions.disable") : t("extensions.actions.enable")}
                      title={row.enabled ? t("extensions.actions.disable") : t("extensions.actions.enable")}
                      className={row.enabled ? "text-emerald-600 hover:bg-emerald-500/10" : ""}
                      onClick={() => onToggleEnabled(row.config!)}
                    >
                      {row.enabled ? <PowerIcon size={14} /> : <PowerOffIcon size={14} />}
                    </IconButton>
                    <IconButton
                      variant="default"
                      size="sm"
                      aria-label={t("extensions.actions.edit")}
                      title={t("extensions.actions.edit")}
                      onClick={() => onEdit(row.config!)}
                    >
                      <NotePencilIcon size={14} />
                    </IconButton>
                    <IconButton
                      variant="danger"
                      size="sm"
                      aria-label={t("extensions.actions.delete")}
                      title={t("extensions.actions.delete")}
                      onClick={() => onDelete(row.name)}
                    >
                      <TrashIcon size={14} />
                    </IconButton>
                  </>
                ) : (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
                      row.enabled
                        ? "bg-emerald-500/10 text-emerald-600"
                        : "bg-amber-500/10 text-amber-600"
                    )}
                  >
                    {row.enabled ? t("extensions.mcp.effective") : t("extensions.mcp.overridden")}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}