"use client";

import { useState } from "react";
import {
  PlusIcon,
  GearSixIcon,
  ServerIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Switch } from "@/components/ui/Switch";
import { MCPSettingsDialog } from "./MCPSettingsDialog";
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

function ServerRow({
  name,
  actions,
  className,
}: {
  name: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-4 py-3 border-b border-border/30 last:border-b-0",
        className
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <ServerIcon size={18} className="shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
      </div>
      {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
    </div>
  );
}

function ServerList({
  title,
  emptyText,
  children,
  action,
}: {
  title: string;
  emptyText?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const hasChildren = children !== null && children !== undefined &&
    (Array.isArray(children) ? children.length > 0 : true);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {action}
      </div>
      {hasChildren ? (
        <div className="rounded-xl border border-border/40 bg-[var(--surface)] overflow-hidden">
          {children}
        </div>
      ) : emptyText ? (
        <div className="rounded-xl border border-border/40 bg-[var(--surface)] px-4 py-8 text-center text-sm text-muted-foreground">
          {emptyText}
        </div>
      ) : null}
    </div>
  );
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
  const [editingServer, setEditingServer] = useState<MCPServerConfig | null>(null);

  const filteredServers = searchQuery.trim()
    ? servers.filter((s) => s.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : servers;

  const filteredPluginMCPs = searchQuery.trim()
    ? pluginMCPs.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : pluginMCPs;

  return (
    <div className="space-y-8">
      <ServerList
        title={t("extensions.mcp.table.name")}
        emptyText={t("extensions.empty.mcp")}
        action={
          <Button variant="primary" size="sm" onClick={onAdd}>
            <PlusIcon size={14} />
            {t("extensions.mcp.addServer")}
          </Button>
        }
      >
        {filteredServers.map((server) => (
          <ServerRow
            key={server.name}
            name={server.name}
            actions={
              <>
                <IconButton
                  variant="ghost"
                  size="sm"
                  shape="square"
                  aria-label={t("extensions.actions.edit")}
                  title={t("extensions.actions.edit")}
                  onClick={() => setEditingServer(server)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <GearSixIcon size={16} />
                </IconButton>
                <Switch
                  checked={server.enabled !== false}
                  onCheckedChange={() => onToggleEnabled(server)}
                  ariaLabel={
                    server.enabled !== false
                      ? t("extensions.actions.disable")
                      : t("extensions.actions.enable")
                  }
                />
              </>
            }
          />
        ))}
      </ServerList>

      {filteredPluginMCPs.length > 0 && (
        <ServerList
          title={t("extensions.mcp.fromPluginsTitle")}
          emptyText={undefined}
        >
          {filteredPluginMCPs.map((pmcp) => (
            <ServerRow
              key={`${pmcp.pluginId}-${pmcp.name}`}
              name={pmcp.name}
            />
          ))}
        </ServerList>
      )}

      <MCPSettingsDialog
        server={editingServer}
        onClose={() => setEditingServer(null)}
        onSave={(updated) => {
          // Name changes require deleting the old entry to avoid duplicates
          // in settings that are keyed by server name.
          if (updated.name !== editingServer?.name) {
            if (editingServer) onDelete(editingServer.name);
          }
          onEdit(updated);
          setEditingServer(null);
        }}
      />
    </div>
  );
}