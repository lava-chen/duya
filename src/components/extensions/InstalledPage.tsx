"use client";

// InstalledPage — the "installed" half of the extensions page.
//
// Visual reference: ZCode's plugin settings list. Each section renders a
// single rounded surface container with hairline-separated rows: a 36px
// avatar, name, one-line description, and right-aligned controls (the
// destructive action is revealed on row hover). Everything the user has
// installed lives here, grouped into four sections, each with an on/off
// toggle:
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
import { TrashIcon, AiGatewayIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

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

/** Brand tile: real icon when one resolved, tinted monogram otherwise. */
function TileIcon({
  iconUrl,
  letter,
  color,
  className = "h-9 w-9",
}: {
  iconUrl?: string;
  letter: string;
  color?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cn(
        "flex shrink-0 select-none items-center justify-center overflow-hidden rounded-xl text-sm font-semibold",
        className
      )}
      style={{
        backgroundColor: color ? `${color}1F` : "var(--surface-hover)",
        color: color ?? "var(--accent)",
      }}
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
        letter
      )}
    </span>
  );
}

function McpTileIcon() {
  return (
    <span className="flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-xl bg-[var(--surface-hover)]">
      <AiGatewayIcon size={18} className="text-muted-foreground" />
    </span>
  );
}

function DashedEmpty({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

/** Section header (title + subtle count) — ZCode settings style. */
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
      <h3 className="flex h-7 items-center gap-1.5 text-sm font-medium text-foreground">
        {title}
        <span className="text-[13px] font-normal text-muted-foreground">{count}</span>
      </h3>
      <div className="mt-2">{children ?? <DashedEmpty label={emptyLabel} />}</div>
    </section>
  );
}

/** Rounded surface container with hairline separators between rows. */
function RowList({ rows }: { rows: React.ReactNode[] }) {
  return (
    <div className="overflow-hidden rounded-xl bg-[var(--surface)]">
      {rows.map((row, index) => (
        <div key={index}>
          {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
          {row}
        </div>
      ))}
    </div>
  );
}

/**
 * One settings row: avatar, name + optional badge, one-line description,
 * right-aligned controls. The destructive hover action fades in on row
 * hover (ZCode row behaviour) while toggles stay always visible.
 */
function SettingsRow({
  icon,
  title,
  badge,
  description,
  onClick,
  actions,
  hoverAction,
  dimmed,
}: {
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  description?: string;
  onClick?: () => void;
  /** Always-visible right-side controls (switches). */
  actions?: React.ReactNode;
  /** Hover-revealed destructive action (rendered left of `actions`). */
  hoverAction?: React.ReactNode;
  dimmed?: boolean;
}) {
  const interactive = Boolean(onClick);
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onClick) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      className={cn(
        "group/row flex min-w-0 items-center gap-3 px-4 py-3 transition-colors",
        interactive && "cursor-pointer",
        "hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      )}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "min-w-0 truncate text-sm font-medium text-foreground",
              dimmed && "text-muted-foreground"
            )}
          >
            {title}
          </span>
          {badge}
        </div>
        {description ? (
          <div className="mt-0.5 line-clamp-1 text-[13px] text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      <div
        className="flex shrink-0 items-center gap-1.5"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {hoverAction}
        {actions}
      </div>
    </div>
  );
}

/** Subtle rounded-full pill for scope / status hints. */
function RowBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-[var(--surface-hover)] px-2 py-0.5 text-[11px] font-medium leading-none text-muted-foreground">
      {children}
    </span>
  );
}

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
      <DashedEmpty
        label={q ? t("marketplace.empty") : t("extensions.empty.plugins")}
      />
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
        <RowList
          rows={filteredPlugins.map((plugin) => {
            const busy = busyPluginId === plugin.id;
            const iconUrl = plugin.icon ?? catalogIconById.get(plugin.id);
            return (
              <SettingsRow
                key={plugin.id}
                icon={
                  <TileIcon
                    iconUrl={iconUrl}
                    letter={plugin.name.trim().charAt(0).toUpperCase() || "?"}
                  />
                }
                title={plugin.name}
                badge={<RowBadge>v{plugin.version}</RowBadge>}
                description={plugin.description}
                onClick={() => onPluginClick(plugin.id)}
                dimmed={!plugin.enabled}
                hoverAction={
                  <span className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
                    <IconButton
                      variant="ghost"
                      size="sm"
                      shape="square"
                      aria-label={t("extensions.actions.remove")}
                      title={t("extensions.actions.remove")}
                      disabled={busy}
                      className="text-[var(--error)] hover:bg-[var(--error-soft)]"
                      onClick={() => onPluginRemove(plugin.id)}
                    >
                      <TrashIcon size={14} />
                    </IconButton>
                  </span>
                }
                actions={
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
                }
              />
            );
          })}
        />
      </Section>

      {/* ── App connections ── */}
      <Section
        title={t("extensions.installed.sections.connections")}
        count={filteredConnections.length}
        emptyLabel={t("extensions.empty.connections")}
      >
        <RowList
          rows={filteredConnections.map((conn) => {
            const provider = providerById.get(conn.provider);
            const connected = conn.status === "connected";
            return (
              <SettingsRow
                key={conn.id}
                icon={
                  <span className="relative">
                    <TileIcon
                      letter={(provider?.monogram ?? conn.provider).charAt(0).toUpperCase()}
                    />
                    <span
                      className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--main-bg)]"
                      style={{ backgroundColor: connected ? "var(--success)" : "var(--muted)" }}
                    />
                  </span>
                }
                title={provider?.label ?? conn.provider}
                badge={conn.accountLabel ? <RowBadge>{conn.accountLabel}</RowBadge> : undefined}
                description={
                  connected
                    ? undefined
                    : conn.lastError ?? t("marketplace.connectors.disconnected")
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
        />
      </Section>

      {/* ── MCP · manual ── */}
      <Section
        title={t("extensions.installed.sections.mcpManual")}
        count={filteredMcpManual.length}
        emptyLabel={t("extensions.empty.mcp")}
      >
        <RowList
          rows={filteredMcpManual.map((server) => (
            <SettingsRow
              key={server.name}
              icon={<McpTileIcon />}
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
        />
      </Section>

      {/* ── MCP · from plugins ── */}
      <Section
        title={t("extensions.installed.sections.mcpPlugins")}
        count={filteredMcpPlugins.length}
        emptyLabel={t("extensions.empty.mcp")}
      >
        <RowList
          rows={filteredMcpPlugins.map((server) => (
            <SettingsRow
              key={`${server.pluginId}-${server.name}`}
              icon={<McpTileIcon />}
              title={server.name}
              badge={server.pluginName ? <RowBadge>{server.pluginName}</RowBadge> : undefined}
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
        />
      </Section>

      {/* ── Skills ── */}
      <Section
        title={t("extensions.installed.sections.skills")}
        count={filteredSkills.length}
        emptyLabel={t("extensions.empty.skills" as never)}
      >
        <RowList
          rows={filteredSkills.map((skill) => {
            const enabled = skill.enabled !== false;
            return (
              <SettingsRow
                key={skill.name}
                icon={
                  <TileIcon letter={skill.name.trim().charAt(0).toUpperCase() || "?"} />
                }
                title={skill.name}
                description={skill.description}
                onClick={() => onSkillClick(skill)}
                dimmed={!enabled}
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
        />
      </Section>
    </div>
  );
}
