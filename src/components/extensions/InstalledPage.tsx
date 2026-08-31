"use client";

// InstalledPage — the "installed" half of the extensions page.
//
// Everything the user has actually installed lives here, grouped into four
// sections, each with an on/off toggle:
//   1. Plugins
//   2. App connections (OAuth connectors)
//   3. MCP servers — split into manually configured and plugin-declared
//      (both are local stdio servers)
//   4. Skills

import { useMemo, useState } from "react";
import { IconButton } from "@/components/ui/IconButton";
import { Switch } from "@/components/ui/Switch";
import { useTranslation } from "@/hooks/useTranslation";
import type { PluginCatalogEntry, PluginRegistryEntry } from "@/lib/plugin-types";
import type {
  AppConnectionProviderDTO,
  AppConnectionStatusDTO,
  ProviderId,
} from "@/lib/app-connection-ipc";
import type { MCPServerConfig } from "@/types";
import type { MCPPluginDeclaredServerDTO } from "@/lib/mcp-inventory-types";
import { ExtensionCard } from "./ExtensionCard";
import { TrashIcon, AiGatewayIcon } from "@/components/icons";

export interface SkillSummary {
  name: string;
  description: string;
  category?: string;
  source?: string;
  enabled?: boolean;
  updatedAt?: string;
}

interface InstalledPageProps {
  searchQuery: string;
  // ── Plugins ──
  installed: PluginRegistryEntry[];
  catalog: PluginCatalogEntry[];
  busyPluginId: string | null;
  onPluginClick: (pluginId: string) => void;
  onPluginToggle: (plugin: PluginRegistryEntry, enabled: boolean) => void;
  onPluginRemove: (pluginId: string) => void;
  // ── App connections ──
  connections: AppConnectionStatusDTO[];
  providers: AppConnectionProviderDTO[];
  busyProvider: ProviderId | null;
  onConnectionToggle: (connection: AppConnectionStatusDTO, enabled: boolean) => void;
  // ── MCP ──
  mcpManual: MCPServerConfig[];
  mcpFromPlugins: MCPPluginDeclaredServerDTO[];
  onMcpToggle: (server: MCPServerConfig, enabled: boolean) => void;
  onMcpPluginToggle: (server: MCPPluginDeclaredServerDTO, enabled: boolean) => void;
  // ── Skills ──
  skills: SkillSummary[];
  onSkillClick: (skill: SkillSummary) => void;
  onSkillToggle: (skillName: string, enabled: boolean) => void;
}

/** Small brand tile: real icon when one resolved, tinted monogram otherwise. */
function TileIcon({
  iconUrl,
  letter,
  color,
}: {
  iconUrl?: string;
  letter: string;
  color?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] overflow-hidden"
      style={{ backgroundColor: color ? `${color}1F` : "var(--surface-hover)" }}
    >
      {iconUrl && !failed ? (
        <img
          src={iconUrl}
          alt=""
          draggable={false}
          decoding="async"
          className="h-[62%] w-[62%] object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="text-sm font-semibold"
          style={{ color: color ?? "var(--accent)" }}
        >
          {letter}
        </span>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  emptyLabel,
  children,
}: {
  title: string;
  count: number;
  emptyLabel: string;
  children?: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="mb-7 last:mb-0">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
        <span className="rounded-md bg-[var(--surface-hover)] px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
          {count}
        </span>
      </div>
      {children ?? (
        <div className="rounded-[14px] border border-border/40 bg-[var(--surface)] px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        </div>
      )}
    </section>
  );
}

const GRID = "grid gap-3 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]";

export function InstalledPage({
  searchQuery,
  installed,
  catalog,
  busyPluginId,
  onPluginClick,
  onPluginToggle,
  onPluginRemove,
  connections,
  providers,
  busyProvider,
  onConnectionToggle,
  mcpManual,
  mcpFromPlugins,
  onMcpToggle,
  onMcpPluginToggle,
  skills,
  onSkillClick,
  onSkillToggle,
}: InstalledPageProps) {
  const { t } = useTranslation();

  const q = searchQuery.trim().toLowerCase();
  const matches = (...fields: (string | undefined)[]) =>
    !q || fields.some((f) => f?.toLowerCase().includes(q));

  const catalogIconById = useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const entry of catalog) map.set(entry.id, entry.icon);
    return map;
  }, [catalog]);

  const providerById = useMemo(() => {
    const map = new Map<ProviderId, AppConnectionProviderDTO>();
    for (const p of providers) map.set(p.id, p);
    return map;
  }, [providers]);

  const filteredPlugins = installed.filter((p) =>
    matches(p.name, p.description)
  );
  const filteredConnections = connections.filter((c) => {
    const provider = providerById.get(c.provider);
    return matches(c.accountLabel, provider?.label, c.provider);
  });
  const filteredMcpManual = mcpManual.filter((s) => matches(s.name));
  const filteredMcpPlugins = mcpFromPlugins.filter((s) =>
    matches(s.name, s.pluginName)
  );
  const filteredSkills = skills.filter((s) =>
    matches(s.name, s.description)
  );

  const total =
    filteredPlugins.length +
    filteredConnections.length +
    filteredMcpManual.length +
    filteredMcpPlugins.length +
    filteredSkills.length;

  if (total === 0) {
    return (
      <div className="rounded-[14px] border border-border/40 bg-[var(--surface)] px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          {q ? t("marketplace.empty") : t("extensions.empty.plugins")}
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {/* ── Plugins ── */}
      <Section
        title={t("extensions.installed.sections.plugins")}
        count={filteredPlugins.length}
        emptyLabel={t("extensions.empty.plugins")}
      >
        <div className={GRID}>
          {filteredPlugins.map((plugin) => {
            const busy = busyPluginId === plugin.id;
            const iconUrl = plugin.icon ?? catalogIconById.get(plugin.id);
            return (
              <ExtensionCard
                key={plugin.id}
                cardIcon={
                  <TileIcon
                    iconUrl={iconUrl}
                    letter={plugin.name.trim().charAt(0).toUpperCase() || "?"}
                  />
                }
                title={plugin.name}
                description={plugin.description}
                onClick={() => onPluginClick(plugin.id)}
                actions={
                  <div className="flex items-center gap-1">
                    <Switch
                      checked={plugin.enabled}
                      disabled={busy}
                      ariaLabel={
                        plugin.enabled
                          ? t("extensions.actions.disable")
                          : t("extensions.actions.enable")
                      }
                      onCheckedChange={() => onPluginToggle(plugin, !plugin.enabled)}
                    />
                    <IconButton
                      variant="ghost"
                      size="sm"
                      shape="square"
                      aria-label={t("extensions.actions.remove")}
                      title={t("extensions.actions.remove")}
                      disabled={busy}
                      onClick={() => onPluginRemove(plugin.id)}
                    >
                      <TrashIcon size={14} />
                    </IconButton>
                  </div>
                }
              />
            );
          })}
        </div>
      </Section>

      {/* ── App connections ── */}
      <Section
        title={t("extensions.installed.sections.connections")}
        count={filteredConnections.length}
        emptyLabel={t("extensions.empty.connections")}
      >
        <div className={GRID}>
          {filteredConnections.map((conn) => {
            const provider = providerById.get(conn.provider);
            const connected = conn.status === "connected";
            return (
              <ExtensionCard
                key={conn.id}
                cardIcon={
                  <TileIcon
                    letter={(provider?.monogram ?? conn.provider).charAt(0).toUpperCase()}
                  />
                }
                title={provider?.label ?? conn.provider}
                subtitle={conn.accountLabel}
                description={
                  connected
                    ? undefined
                    : conn.lastError ?? t("marketplace.connectors.disconnected")
                }
                statusDot={
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface)]"
                    style={{ backgroundColor: connected ? "var(--success)" : "var(--muted)" }}
                  />
                }
                actions={
                  <Switch
                    checked={connected}
                    disabled={busyProvider === conn.provider}
                    ariaLabel={
                      connected
                        ? t("marketplace.connectors.disconnect")
                        : t("marketplace.connectors.connect")
                    }
                    onCheckedChange={() => onConnectionToggle(conn, !connected)}
                  />
                }
              />
            );
          })}
        </div>
      </Section>

      {/* ── MCP · manual ── */}
      <Section
        title={t("extensions.installed.sections.mcpManual")}
        count={filteredMcpManual.length}
        emptyLabel={t("extensions.empty.mcp")}
      >
        <div className={GRID}>
          {filteredMcpManual.map((server) => (
            <ExtensionCard
              key={server.name}
              cardIcon={<McpTileIcon />}
              title={server.name}
              description={`${server.command} ${(server.args ?? []).join(" ")}`.trim()}
              actions={
                <Switch
                  checked={server.enabled !== false}
                  ariaLabel={
                    server.enabled !== false
                      ? t("extensions.actions.disable")
                      : t("extensions.actions.enable")
                  }
                  onCheckedChange={() => onMcpToggle(server, !(server.enabled !== false))}
                />
              }
            />
          ))}
        </div>
      </Section>

      {/* ── MCP · from plugins ── */}
      <Section
        title={t("extensions.installed.sections.mcpPlugins")}
        count={filteredMcpPlugins.length}
        emptyLabel={t("extensions.empty.mcp")}
      >
        <div className={GRID}>
          {filteredMcpPlugins.map((server) => (
            <ExtensionCard
              key={`${server.pluginId}-${server.name}`}
              cardIcon={<McpTileIcon />}
              title={server.name}
              subtitle={server.pluginName}
              description={server.command}
              actions={
                <Switch
                  checked={server.providerEnabled}
                  ariaLabel={
                    server.providerEnabled
                      ? t("extensions.actions.disable")
                      : t("extensions.actions.enable")
                  }
                  onCheckedChange={() =>
                    onMcpPluginToggle(server, !server.providerEnabled)
                  }
                />
              }
            />
          ))}
        </div>
      </Section>

      {/* ── Skills ── */}
      <Section
        title={t("extensions.installed.sections.skills")}
        count={filteredSkills.length}
        emptyLabel={t("extensions.empty.skills" as never)}
      >
        <div className={GRID}>
          {filteredSkills.map((skill) => {
            const enabled = skill.enabled !== false;
            return (
              <ExtensionCard
                key={skill.name}
                cardIcon={
                  <TileIcon letter={skill.name.trim().charAt(0).toUpperCase() || "?"} />
                }
                title={skill.name}
                description={skill.description}
                onClick={() => onSkillClick(skill)}
                actions={
                  <Switch
                    checked={enabled}
                    ariaLabel={
                      enabled
                        ? t("extensions.actions.disable")
                        : t("extensions.actions.enable")
                    }
                    onCheckedChange={() => onSkillToggle(skill.name, !enabled)}
                  />
                }
              />
            );
          })}
        </div>
      </Section>
    </div>
  );
}

function McpTileIcon() {
  return (
    <div
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px]"
      style={{ backgroundColor: "var(--surface-hover)" }}
    >
      <AiGatewayIcon size={20} className="text-muted-foreground" />
    </div>
  );
}
