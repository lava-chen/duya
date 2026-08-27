"use client";

import { useState, useCallback, useEffect } from "react";
import type React from "react";
import {
  PlusIcon,
  TrashIcon,
  NotePencilIcon,
  PowerIcon,
  PowerOffIcon,
  AiGatewayIcon,
  XIcon,
  CheckIcon,
  DownloadSimpleIcon,
} from "@/components/icons";
import { useSettings } from "@/hooks/useSettings";
import type { MCPServerConfig } from "@/types";
import { cn } from "@/lib/utils";
import { parseMcpInput, isMultiConfig } from "@/lib/mcp-parser";
import type { ParsedMCPConfig } from "@/lib/mcp-parser";
import { fetchMCPInventorySnapshot, hasMCPInventoryAPI } from "@/lib/mcp-inventory-ipc";
import { getConfigValue, setConfig } from "@/lib/config-port-bus";
import type { MCPInventorySnapshotDTO, MCPPluginDeclaredServerDTO } from "@/lib/mcp-inventory-types";
import {
  PRESET_MCP_SERVERS,
  MCP_CATEGORIES,
  presetToMCPServerConfig,
} from "@/data/preset-mcp-servers";
import type { MCPCategory } from "@/data/preset-mcp-servers";
import { listAgentProfiles } from "@/lib/agent-profile-ipc";
import type { AgentProfile } from "@/lib/agent-profile-ipc";
import {
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
} from "@/components/settings/ui";
import { useTranslation } from "@/hooks/useTranslation";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";

interface MCPServerFormData {
  name: string;
  command: string;
  args: string;
  env: string;
  enabled: boolean;
  allowedAgentIds: string[];
}

function parseArgs(argsStr: string): string[] {
  if (!argsStr.trim()) return [];
  return argsStr.split(/\s+/).filter(Boolean);
}

function stringifyArgs(args: string[] | undefined): string {
  if (!args || args.length === 0) return "";
  return args.join(" ");
}

function parseEnv(envStr: string): Record<string, string> {
  if (!envStr.trim()) return {};
  const env: Record<string, string> = {};
  envStr.split("\n").forEach((line) => {
    const [key, ...valueParts] = line.split("=");
    if (key && valueParts.length > 0) {
      env[key.trim()] = valueParts.join("=").trim();
    }
  });
  return env;
}

function stringifyEnv(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function emptyFormData(): MCPServerFormData {
    return {
      name: '',
      command: '',
      args: '',
      env: '',
      enabled: true,
      allowedAgentIds: [],
    };
  }

function serverToFormData(server: MCPServerConfig): MCPServerFormData {
  return {
    name: server.name,
    command: server.command,
    args: server.args ? server.args.join(' ') : '',
    env: server.env
      ? Object.entries(server.env)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')
      : '',
    enabled: server.enabled !== false,
    allowedAgentIds: server.allowedAgentIds || [],
  };
}

function formDataToServer(formData: MCPServerFormData): MCPServerConfig {
  return {
    name: formData.name.trim(),
    command: formData.command.trim(),
    args: parseArgs(formData.args),
    env: parseEnv(formData.env),
    enabled: formData.enabled,
    allowedAgentIds: formData.allowedAgentIds.length > 0 ? formData.allowedAgentIds : undefined,
  };
}

// ============================================================================
// Phase 3 (MCP runtime status UI) helpers
// ============================================================================

type McpConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error' | 'unknown';

function statusColor(status: McpConnectionStatus | undefined): {
  bg: string;
  fg: string;
  border: string;
} {
  switch (status) {
    case 'connected':
      return { bg: 'bg-green-500/15', fg: 'text-green-700 dark:text-green-400', border: 'border-green-500/30' };
    case 'connecting':
      return { bg: 'bg-amber-500/15', fg: 'text-amber-700 dark:text-amber-400', border: 'border-amber-500/30' };
    case 'error':
      return { bg: 'bg-red-500/15', fg: 'text-red-700 dark:text-red-400', border: 'border-red-500/30' };
    case 'disconnected':
      return { bg: 'bg-zinc-500/15', fg: 'text-zinc-600 dark:text-zinc-400', border: 'border-zinc-500/30' };
    default:
      return { bg: 'bg-muted', fg: 'text-muted-foreground', border: 'border-border/50' };
  }
}

function statusLabel(status: McpConnectionStatus | undefined): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'error':
      return 'Failed';
    case 'disconnected':
      return 'Disconnected';
    default:
      return 'Unknown';
  }
}

function StatusDot({ status }: { status: McpConnectionStatus | undefined }): React.ReactElement {
  const dot =
    status === 'connected'
      ? 'bg-green-500'
      : status === 'connecting'
        ? 'bg-amber-500'
        : status === 'error'
          ? 'bg-red-500'
          : status === 'disconnected'
            ? 'bg-zinc-500'
            : 'bg-zinc-400';
  return (
    <span
      aria-label={`mcp status ${status ?? 'unknown'}`}
      title={statusLabel(status)}
      className={cn(
        'inline-block h-2.5 w-2.5 rounded-full ring-2',
        dot,
        status === 'connected' ? 'ring-green-500/20' : 'ring-transparent',
      )}
    />
  );
}

function ToolAnnotationBadge({
  annotations,
}: {
  annotations: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean } | undefined;
}): React.ReactElement | null {
  if (!annotations) return null;
  const tags: Array<{ key: string; label: string; cls: string }> = [];
  if (annotations.readOnly) {
    tags.push({ key: 'read-only', label: 'read-only', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20' });
  }
  if (annotations.destructive) {
    tags.push({ key: 'destructive', label: 'destructive', cls: 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20' });
  }
  if (annotations.openWorld) {
    tags.push({ key: 'open-world', label: 'open-world', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20' });
  }
  if (tags.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {tags.map((t) => (
        <span
          key={t.key}
          className={cn('inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium', t.cls)}
        >
          {t.label}
        </span>
      ))}
    </span>
  );
}

export function MCPSection() {
  const { t } = useTranslation();
  const { settings, save, loading } = useSettings();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServerConfig | null>(null);
  const [formData, setFormData] = useState<MCPServerFormData>(emptyFormData());
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  const [importConfigs, setImportConfigs] = useState<ParsedMCPConfig[]>([]);

  const [presetExpanded, setPresetExpanded] = useState(false);
  const [presetCategory, setPresetCategory] = useState<MCPCategory | null>(null);
  const [presetSearch, setPresetSearch] = useState("");

  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([]);
  const [inventory, setInventory] = useState<MCPInventorySnapshotDTO | null>(null);

  // Plan 452 Phase A: global tool-exposure switch. Default OFF = Direct
  // (MCP + connector tool schemas ride every request); ON = on-demand
  // discovery (tools register discoverable, surfaced via tool_search).
  // Persisted at `tools.on_demand_discovery` in ~/.duya/config.toml; the
  // agent worker re-reads it on every MCP/connector (re)registration.
  const [onDemandDiscovery, setOnDemandDiscovery] = useState(false);
  useEffect(() => {
    getConfigValue('tools.on_demand_discovery')
      .then((v) => setOnDemandDiscovery(v === true))
      .catch(() => undefined);
  }, []);
  const handleToggleOnDemand = useCallback(() => {
    setOnDemandDiscovery((prev) => {
      const next = !prev;
      setConfig('tools.on_demand_discovery', next);
      return next;
    });
  }, []);
  // Phase 3 (MCP runtime status UI): track which server cards are
  // expanded so the tool list is lazy. Reconnect button state is
  // local to each row to debounce double-clicks.
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [reconnecting, setReconnecting] = useState<Set<string>>(new Set());

  useEffect(() => {
    listAgentProfiles().then(setAgentProfiles).catch(() => setAgentProfiles([]));
  }, []);

  useEffect(() => {
    if (!hasMCPInventoryAPI()) return;
    fetchMCPInventorySnapshot().then((snapshot) => {
      setInventory(snapshot);
    }).catch(() => setInventory(null));
  }, [settings.mcpServers]);

  // Phase 3: also refresh inventory when the SSE `mcp:reloaded` /
  // `mcp:status:snapshot` events arrive. The capability-management
  // hook above handles the snapshot; this picks up the lightweight
  // `mcp:reloaded` summary that does not carry the full payload.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const api = (window as unknown as {
      electronAPI?: { sse?: { onAgentServerEvent?: (cb: (e: { type: string }) => void) => () => void } };
    }).electronAPI;
    if (!api?.sse?.onAgentServerEvent) return;
    return api.sse.onAgentServerEvent((event) => {
      if (
        event.type === 'mcp:reloaded' ||
        event.type === 'mcp:status:snapshot' ||
        event.type === 'mcp:reload:error'
      ) {
        fetchMCPInventorySnapshot().then(setInventory).catch(() => setInventory(null));
      }
    });
  }, []);

  // mcp.toml is the writable source. Inventory deliberately omits spawn
  // details, so using it here would erase command/env data on the next save.
  const servers = (settings.mcpServers ?? []).map((server) => ({
    ...server,
    enabled: server.enabled !== false,
  })) as MCPServerConfig[];
  const pluginMCPs: MCPPluginDeclaredServerDTO[] = inventory?.pluginDeclaredServers ?? [];

  // Phase 3: per-server runtime status from the worker's
  // `mcp:status:snapshot` SSE event (sourced via the
  // capability-management aggregator). Keyed by display name.
  type RuntimeRow = {
    connectionStatus: McpConnectionStatus;
    toolCount: number;
    tools?: Array<{
      name: string;
      description: string;
      annotations?: {
        readOnly?: boolean;
        destructive?: boolean;
        openWorld?: boolean;
        [key: string]: unknown;
      };
    }>;
    lastIssue?: { phase: 'connection' | 'registration' | 'discovery'; humanMessage: string; severity: 'critical' | 'warning' | 'info' };
  };
  const runtimeByName = new Map<string, RuntimeRow>();
  for (const eff of inventory?.effectiveServers ?? []) {
    if (!eff.name) continue;
    runtimeByName.set(eff.name, {
      connectionStatus: eff.connectionStatus,
      toolCount: eff.tools?.length ?? 0,
      tools: eff.tools,
      lastIssue: eff.lastIssue,
    });
  }

  const toggleExpanded = useCallback((name: string) => {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleReconnect = useCallback(async (name: string) => {
    setReconnecting((prev) => new Set(prev).add(name));
    try {
      const api = (window as unknown as {
        electronAPI?: { settings?: { reloadMcp?: () => Promise<unknown> } };
      }).electronAPI;
      await api?.settings?.reloadMcp?.();
    } catch (err) {
      console.warn('[MCPSection] reconnect failed:', err);
    } finally {
      setReconnecting((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  }, []);

  const existingServerIds = new Set(servers.map((s) => s.name));

  const filteredPresets = PRESET_MCP_SERVERS.filter((p) => {
    if (presetCategory && p.category !== presetCategory) return false;
    if (presetSearch) {
      const q = presetSearch.toLowerCase();
      return p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
    }
    return true;
  });

  const availablePresetCount = PRESET_MCP_SERVERS.length;

  const validateForm = useCallback((): boolean => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = "Server name is required";
    } else if (!/^[a-zA-Z0-9_-]+$/.test(formData.name.trim())) {
      errors.name = "Name can only contain letters, numbers, hyphens, and underscores";
    }

    if (!formData.command.trim()) {
      errors.command = "Command is required";
    }

    // Check for duplicate names when adding new server
    if (!editingServer) {
      const existingNames = servers.map((s) => s.name.toLowerCase());
      if (existingNames.includes(formData.name.trim().toLowerCase())) {
        errors.name = "A server with this name already exists";
      }
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }, [formData, editingServer, servers]);

  const handleSave = useCallback(async () => {
    if (!validateForm()) return;

    const newServer = formDataToServer(formData);
    let newServers: MCPServerConfig[];

    if (editingServer) {
      // Update existing server
      newServers = servers.map((s) =>
        s.name === editingServer.name ? newServer : s
      );
    } else {
      // Add new server
      newServers = [...servers, newServer];
    }

    await save({ mcpServers: newServers });
    setIsDialogOpen(false);
    setEditingServer(null);
    setFormData(emptyFormData());
  }, [formData, editingServer, servers, save, validateForm]);

  const handleEdit = useCallback((server: MCPServerConfig) => {
    setEditingServer(server);
    setFormData(serverToFormData(server));
    setFormErrors({});
    setIsDialogOpen(true);
  }, []);

  const handleAdd = useCallback(() => {
    setEditingServer(null);
    setFormData(emptyFormData());
    setFormErrors({});
    setIsDialogOpen(true);
  }, []);

  const handleDelete = useCallback(
    async (serverName: string) => {
      const newServers = servers.filter((s) => s.name !== serverName);
      await save({ mcpServers: newServers });
    },
    [servers, save]
  );

  const handleToggleEnabled = useCallback(
    async (server: MCPServerConfig) => {
      const newServers = servers.map((s) =>
        s.name === server.name ? { ...s, enabled: !s.enabled } : s
      );
      await save({ mcpServers: newServers });
    },
    [servers, save]
  );

  const handleDialogClose = useCallback(() => {
    setEditingServer(null);
    setFormData(emptyFormData());
    setFormErrors({});
    setIsDialogOpen(false);
  }, []);

  const handleImportOpen = useCallback(() => {
    setImportText("");
    setImportError("");
    setImportConfigs([]);
    setIsImportOpen(true);
  }, []);

  const handleImportClose = useCallback(() => {
    setImportText("");
    setImportError("");
    setImportConfigs([]);
    setIsImportOpen(false);
  }, []);

  const handleParse = useCallback(() => {
    setImportError("");
    setImportConfigs([]);

    const result = parseMcpInput(importText);
    if ('error' in result) {
      setImportError(result.error);
      return;
    }

    if (isMultiConfig(result)) {
      setImportConfigs(result.configs);
      return;
    }

    selectImportResult(result);
  }, [importText]);

  const selectImportResult = useCallback((config: ParsedMCPConfig) => {
    setEditingServer(null);
    setFormErrors({});
    setFormData({
      name: config.name,
      command: config.command,
      args: config.args.join(' '),
      env: config.env
        ? Object.entries(config.env).map(([k, v]) => `${k}=${v}`).join('\n')
        : '',
      enabled: true,
      allowedAgentIds: [],
    });
    setIsImportOpen(false);
    setImportText("");
    setImportError("");
    setImportConfigs([]);
    setIsDialogOpen(true);
  }, []);

  const handleAddPreset = useCallback(
    async (presetId: string) => {
      const preset = PRESET_MCP_SERVERS.find((p) => p.id === presetId);
      if (!preset) return;
      const config = presetToMCPServerConfig(preset);
      const newServers = [...servers, config];
      await save({ mcpServers: newServers });
    },
    [servers, save]
  );

  return (
    <SettingsSection
      title={t('settings.mcp')}
      description="Manage Model Context Protocol (MCP) servers for extended capabilities"
    >
      {/* Preset MCP Marketplace */}
      <SettingsCard className="mb-4">
        <Button
          variant="ghost"
          className="w-full py-3 flex items-center justify-between hover:bg-muted/50 transition-colors rounded-lg"
          onClick={() => setPresetExpanded(!presetExpanded)}
        >
          <span className="font-medium text-sm">Recommended MCP Servers</span>
          <span className="text-xs text-muted-foreground">
            {availablePresetCount} available
            <span className="ml-2">{presetExpanded ? '▴' : '▾'}</span>
          </span>
        </Button>
        {presetExpanded && (
          <div className="px-4 pb-4">
            <div className="flex gap-2 mb-3 flex-wrap">
              <Button
                variant={!presetCategory ? "primary" : "secondary"}
                size="sm"
                className="rounded-full"
                onClick={() => setPresetCategory(null)}
              >
                All
              </Button>
              {MCP_CATEGORIES.map((cat) => (
                <Button
                  key={cat.key}
                  variant={presetCategory === cat.key ? "primary" : "secondary"}
                  size="sm"
                  className="rounded-full"
                  onClick={() =>
                    setPresetCategory(presetCategory === cat.key ? null : cat.key)
                  }
                >
                  {cat.label}
                </Button>
              ))}
            </div>
            <div className="mb-3">
              <Input
                type="text"
                placeholder="Search presets..."
                value={presetSearch}
                onChange={(e) => setPresetSearch(e.target.value)}
                size="sm"
              />
            </div>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {filteredPresets.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No presets match your search.
                </p>
              ) : (
                filteredPresets.map((preset) => {
                  const isAdded = existingServerIds.has(preset.id);
                  return (
                    <div
                      key={preset.id}
                      className="flex items-center justify-between px-3 py-2 rounded-lg border border-border/30 hover:border-border/50 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm">{preset.name}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {preset.description}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                          {preset.command} {preset.args.join(' ')}
                        </div>
                      </div>
                      <Button
                        variant={isAdded ? "secondary" : "primary"}
                        size="sm"
                        className="ml-3 shrink-0"
                        disabled={isAdded}
                        onClick={() => handleAddPreset(preset.id)}
                      >
                        {isAdded ? 'Added' : 'Add'}
                      </Button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </SettingsCard>

      {/* Plan 452 Phase A: global tool-exposure switch. Tools are Direct by
          default (schemas ride every request); on-demand discovery flips
          them to tool_search-only for a lean prompt. */}
      <SettingsCard className="mb-4">
        <div className="py-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-medium text-foreground">按需工具发现 (On-demand tool discovery)</h3>
            <p className="text-xs text-muted-foreground mt-1">
              关闭（默认）：MCP 与应用连接器的工具直接进入每轮请求，无需搜索即可调用。
              开启：工具注册为可发现状态，模型通过 tool_search 按需加载，prompt 更精简但多一跳。
              修改后重新连接 MCP 服务器生效。
            </p>
          </div>
          <IconButton
            variant="default"
            size="sm"
            aria-label={onDemandDiscovery ? 'Disable on-demand discovery' : 'Enable on-demand discovery'}
            title={onDemandDiscovery ? 'Switch to direct exposure (default)' : 'Switch to on-demand discovery'}
            className={onDemandDiscovery ? '' : 'text-green-600 hover:bg-green-500/10'}
            onClick={handleToggleOnDemand}
          >
            {onDemandDiscovery ? <PowerOffIcon size={18} /> : <PowerIcon size={18} />}
          </IconButton>
        </div>
      </SettingsCard>

      {servers.length === 0 ? (
        <SettingsCard>
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <AiGatewayIcon className="h-12 w-12 text-muted-foreground mb-4" size={48} />
            <p className="text-muted-foreground text-center">
              No manually configured MCP servers yet.
              <br />
              Add a server to extend agent capabilities with external tools.
              {pluginMCPs.length > 0 ? (
                <>
                  <br />
                  Plugin-provided MCP servers are listed below.
                </>
              ) : null}
            </p>
            <div className="flex gap-2 mt-4">
              <Button
                variant="primary"
                onClick={handleAdd}
              >
                <PlusIcon size={16} />
                Add Your First Server
              </Button>
              <Button
                variant="secondary"
                onClick={handleImportOpen}
              >
                <DownloadSimpleIcon size={16} />
                Import from text
              </Button>
            </div>
          </div>
        </SettingsCard>
      ) : (
        <>
          {servers.map((server) => {
            const runtime = runtimeByName.get(server.name);
            const isExpanded = expandedServers.has(server.name);
            const isReconnecting = reconnecting.has(server.name);
            const runtimeStatus = runtime?.connectionStatus;
            const showReconnect =
              server.enabled && (runtimeStatus === 'error' || runtimeStatus === 'disconnected');
            return (
            <SettingsCard key={server.name} className="mb-4">
              <div className="py-4">
                <div className="flex items-start justify-between">
                  <button
                    type="button"
                    className="flex items-center gap-3 flex-1 min-w-0 text-left hover:bg-muted/30 rounded-lg -m-2 p-2 transition-colors"
                    onClick={() => toggleExpanded(server.name)}
                    aria-expanded={isExpanded}
                    aria-controls={`mcp-tools-${server.name}`}
                  >
                    <div
                      className={cn(
                        "w-10 h-10 rounded-lg flex items-center justify-center relative",
                        server.enabled
                          ? "bg-green-500/10 text-green-600"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      <AiGatewayIcon size={20} />
                      <span className="absolute -bottom-0.5 -right-0.5">
                        <StatusDot status={runtimeStatus} />
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-foreground truncate">{server.name}</h3>
                        {runtime && (
                          <span className={cn(
                            "text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0",
                            statusColor(runtimeStatus).bg,
                            statusColor(runtimeStatus).fg,
                            statusColor(runtimeStatus).border,
                          )}>
                            {statusLabel(runtimeStatus)}
                          </span>
                        )}
                        {typeof runtime?.toolCount === 'number' && runtime.toolCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                            {runtime.toolCount} tool{runtime.toolCount === 1 ? '' : 's'}
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                          {isExpanded ? '▴' : '▾'}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground font-mono mt-0.5 truncate">
                        {server.command} {stringifyArgs(server.args)}
                      </p>
                      {runtime?.lastIssue && runtimeStatus !== 'connected' && (
                        <p className="text-xs mt-1 text-red-600 dark:text-red-400 truncate" title={runtime.lastIssue.humanMessage}>
                          {runtime.lastIssue.humanMessage}
                        </p>
                      )}
                      {server.env && Object.keys(server.env).length > 0 && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Env: {Object.keys(server.env).join(", ")}
                        </p>
                      )}
                      {server.allowedAgentIds && server.allowedAgentIds.length > 0 && (
                        <div className="flex items-center gap-1 mt-1 flex-wrap">
                          <span className="text-xs text-muted-foreground">Assigned to:</span>
                          {server.allowedAgentIds.map((id) => {
                            const profile = agentProfiles.find((p) => p.id === id);
                            return (
                              <span
                                key={id}
                                className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent-foreground"
                              >
                                {profile?.name || id}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    {showReconnect && (
                      <IconButton
                        variant="default"
                        size="sm"
                        aria-label="Reconnect"
                        title="Reconnect"
                        disabled={isReconnecting}
                        className="text-amber-600 hover:bg-amber-500/10"
                        onClick={() => handleReconnect(server.name)}
                      >
                        <AiGatewayIcon size={18} />
                      </IconButton>
                    )}
                    <IconButton
                      variant="default"
                      size="sm"
                      aria-label={server.enabled ? "Disable" : "Enable"}
                      title={server.enabled ? "Disable" : "Enable"}
                      className={server.enabled ? "text-green-600 hover:bg-green-500/10" : ""}
                      onClick={() => handleToggleEnabled(server)}
                    >
                      {server.enabled ? <PowerIcon size={18} /> : <PowerOffIcon size={18} />}
                    </IconButton>
                    <IconButton
                      variant="default"
                      size="sm"
                      aria-label="Edit"
                      title="Edit"
                      onClick={() => handleEdit(server)}
                    >
                      <NotePencilIcon size={18} />
                    </IconButton>
                    <IconButton
                      variant="danger"
                      size="sm"
                      aria-label="Delete"
                      title="Delete"
                      onClick={() => handleDelete(server.name)}
                    >
                      <TrashIcon size={18} />
                    </IconButton>
                  </div>
                </div>
                {isExpanded && (
                  <div id={`mcp-tools-${server.name}`} className="mt-3 pl-12">
                    {runtime?.tools && runtime.tools.length > 0 ? (
                      <div className="space-y-1.5">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Tools ({runtime.tools.length})
                        </div>
                        {runtime.tools.map((tool) => (
                          <div
                            key={tool.name}
                            className="rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5"
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-xs">{tool.name}</span>
                              <ToolAnnotationBadge annotations={tool.annotations} />
                            </div>
                            {tool.description && (
                              <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                                {tool.description}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground italic">
                        {runtimeStatus === 'connected'
                          ? 'No tools advertised by this server.'
                          : runtimeStatus === 'error' || runtimeStatus === 'disconnected'
                            ? 'Tools unavailable while the server is not connected.'
                            : 'Tool list not yet received (waiting for the next status snapshot).'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </SettingsCard>
            );
          })}
          <div className="flex justify-end gap-2">
            <Button
              variant="primary"
              onClick={handleAdd}
            >
              <PlusIcon size={16} />
              Add Server
            </Button>
            <Button
              variant="secondary"
              onClick={handleImportOpen}
            >
              <DownloadSimpleIcon size={16} />
              Import from text
            </Button>
          </div>
        </>
      )}

      {/* Plugin MCP Servers */}
      {pluginMCPs.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-muted-foreground mb-3">
            MCP Servers from Plugins
          </h3>
          {pluginMCPs.map((pmcp) => {
            const runtime = runtimeByName.get(pmcp.name);
            const isExpanded = expandedServers.has(pmcp.name);
            const isReconnecting = reconnecting.has(pmcp.name);
            const runtimeStatus = runtime?.connectionStatus;
            const showReconnect =
              pmcp.effective && (runtimeStatus === 'error' || runtimeStatus === 'disconnected');
            return (
            <SettingsCard key={`${pmcp.pluginId}-${pmcp.name}`} className="mb-3">
              <div className="py-4">
                <div className="flex items-start justify-between">
                  <button
                    type="button"
                    className="flex items-center gap-3 flex-1 min-w-0 text-left hover:bg-muted/30 rounded-lg -m-2 p-2 transition-colors"
                    onClick={() => toggleExpanded(pmcp.name)}
                    aria-expanded={isExpanded}
                    aria-controls={`mcp-tools-plugin-${pmcp.name}`}
                  >
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-blue-500/10 text-blue-600 relative">
                      <AiGatewayIcon size={20} />
                      <span className="absolute -bottom-0.5 -right-0.5">
                        <StatusDot status={runtimeStatus} />
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium text-foreground truncate">{pmcp.name}</h3>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 font-medium">
                          Plugin
                        </span>
                        {runtime && (
                          <span className={cn(
                            "text-[10px] px-1.5 py-0.5 rounded border font-medium",
                            statusColor(runtimeStatus).bg,
                            statusColor(runtimeStatus).fg,
                            statusColor(runtimeStatus).border,
                          )}>
                            {statusLabel(runtimeStatus)}
                          </span>
                        )}
                        {typeof runtime?.toolCount === 'number' && runtime.toolCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            {runtime.toolCount} tool{runtime.toolCount === 1 ? '' : 's'}
                          </span>
                        )}
                        {pmcp.effective ? (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 font-medium">
                            Effective
                          </span>
                        ) : (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 font-medium">
                            Shadowed
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                          {isExpanded ? '▴' : '▾'}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground font-mono mt-0.5 truncate">
                        {pmcp.command} {pmcp.args.join(' ')}
                      </p>
                      {runtime?.lastIssue && runtimeStatus !== 'connected' && (
                        <p className="text-xs mt-1 text-red-600 dark:text-red-400 truncate" title={runtime.lastIssue.humanMessage}>
                          {runtime.lastIssue.humanMessage}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        Provided by: {pmcp.pluginName}
                        {!pmcp.providerEnabled ? ' (plugin disabled)' : ''}
                      </p>
                      {Object.keys(pmcp.env).length > 0 && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Env: {Object.keys(pmcp.env).join(', ')}
                        </p>
                      )}
                    </div>
                  </button>
                  {showReconnect && (
                    <IconButton
                      variant="default"
                      size="sm"
                      aria-label="Reconnect"
                      title="Reconnect"
                      disabled={isReconnecting}
                      className="text-amber-600 hover:bg-amber-500/10 shrink-0"
                      onClick={() => handleReconnect(pmcp.name)}
                    >
                      <AiGatewayIcon size={18} />
                    </IconButton>
                  )}
                </div>
                {isExpanded && (
                  <div id={`mcp-tools-plugin-${pmcp.name}`} className="mt-3 pl-12">
                    {runtime?.tools && runtime.tools.length > 0 ? (
                      <div className="space-y-1.5">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Tools ({runtime.tools.length})
                        </div>
                        {runtime.tools.map((tool) => (
                          <div
                            key={tool.name}
                            className="rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5"
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-xs">{tool.name}</span>
                              <ToolAnnotationBadge annotations={tool.annotations} />
                            </div>
                            {tool.description && (
                              <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                                {tool.description}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground italic">
                        {runtimeStatus === 'connected'
                          ? 'No tools advertised by this server.'
                          : runtimeStatus === 'error' || runtimeStatus === 'disconnected'
                            ? 'Tools unavailable while the server is not connected.'
                            : 'Tool list not yet received (waiting for the next status snapshot).'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </SettingsCard>
            );
          })}
        </div>
      )}

      {/* Import Dialog */}
      {isImportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-surface rounded-xl border border-border shadow-lg w-full max-w-lg mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Import MCP Server</h2>
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label="Close"
                  onClick={handleImportClose}
                >
                  <XIcon size={20} />
                </IconButton>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Paste a JSON config or CLI command from documentation to auto-fill the form.
              </p>
            </div>

            <div className="px-6 py-4 space-y-4">
              <div>
                <textarea
                  rows={10}
                  placeholder={`Paste a JSON config:\n{\n  "mcpServers": {\n    "brave-search": {\n      "command": "npx",\n      "args": ["-y", "@anthropic/mcp-server-brave"]\n    }\n  }\n}\n\nOr a CLI command:\nnpx -y @anthropic/mcp-server-brave`}
                  value={importText}
                  onChange={(e) => {
                    setImportText(e.target.value);
                    setImportError("");
                    setImportConfigs([]);
                  }}
                  className="w-full px-3 py-2 rounded-lg border bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent border-border/50 resize-none font-mono text-sm"
                />
              </div>

              {importError && (
                <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                  {importError}
                </div>
              )}

              {importConfigs.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Multiple servers found. Select one:</p>
                  {importConfigs.map((cfg, idx) => (
                    <Button
                      key={idx}
                      variant="ghost"
                      className="w-full py-3 rounded-lg border border-border/50 hover:bg-muted transition-colors text-left"
                      onClick={() => selectImportResult(cfg)}
                    >
                      <div className="font-medium">{cfg.name}</div>
                      <div className="text-sm text-muted-foreground font-mono mt-0.5">
                        {cfg.command} {cfg.args.join(' ')}
                      </div>
                      {cfg.env && Object.keys(cfg.env).length > 0 && (
                        <div className="text-xs text-muted-foreground mt-1">
                          Env: {Object.keys(cfg.env).join(', ')}
                        </div>
                      )}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={handleImportClose}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleParse}
                disabled={!importText.trim()}
              >
                <CheckIcon size={16} />
                Parse
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit Dialog */}
      {isDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-surface rounded-xl border border-border shadow-lg w-full max-w-lg mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">
                  {editingServer ? "Edit MCP Server" : "Add MCP Server"}
                </h2>
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label="Close"
                  onClick={handleDialogClose}
                >
                  <XIcon size={20} />
                </IconButton>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Configure a new MCP server to extend agent capabilities with external tools.
              </p>
            </div>

            <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Server Name <span className="text-red-500">*</span>
                </label>
                <Input
                  type="text"
                  placeholder="e.g., filesystem, github"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, name: e.target.value }))
                  }
                  disabled={!!editingServer}
                  error={!!formErrors.name}
                />
                {formErrors.name && (
                  <p className="text-sm text-red-500 mt-1">{formErrors.name}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Command <span className="text-red-500">*</span>
                </label>
                <Input
                  type="text"
                  placeholder="e.g., npx, node, python"
                  value={formData.command}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, command: e.target.value }))
                  }
                  error={!!formErrors.command}
                />
                {formErrors.command && (
                  <p className="text-sm text-red-500 mt-1">{formErrors.command}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Arguments (space-separated)
                </label>
                <Input
                  type="text"
                  placeholder="e.g., -y @modelcontextprotocol/server-filesystem"
                  value={formData.args}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, args: e.target.value }))
                  }
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Environment Variables (one per line, KEY=VALUE)
                </label>
                <textarea
                  rows={3}
                  placeholder="GITHUB_TOKEN=your_token&#10;API_KEY=your_key"
                  value={formData.env}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, env: e.target.value }))
                  }
                  className="w-full px-3 py-2 rounded-lg border bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent border-border/50 resize-none"
                />
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={formData.enabled}
                  onClick={() =>
                    setFormData((prev) => ({ ...prev, enabled: !prev.enabled }))
                  }
                  className={cn(
                    "relative w-11 h-6 rounded-full transition-colors",
                    formData.enabled ? "bg-accent" : "bg-muted"
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform",
                      formData.enabled ? "translate-x-5" : "translate-x-0"
                    )}
                  />
                </button>
                <span className="text-sm font-medium">Enabled</span>
              </div>

              {agentProfiles.length > 0 && (
                <div>
                  <label className="block text-sm font-medium mb-1.5">
                    Agent Assignment
                  </label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Leave empty to allow all agents to use this server. Select specific agents to restrict access.
                  </p>
                  <div className="space-y-1 max-h-32 overflow-y-auto border border-border/30 rounded-lg p-2">
                    {agentProfiles.map((profile) => {
                      const isChecked = formData.allowedAgentIds.includes(profile.id);
                      return (
                        <label
                          key={profile.id}
                          className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              setFormData((prev) => ({
                                ...prev,
                                allowedAgentIds: isChecked
                                  ? prev.allowedAgentIds.filter((id) => id !== profile.id)
                                  : [...prev.allowedAgentIds, profile.id],
                              }));
                            }}
                            className="rounded"
                          />
                          <span className="text-sm">{profile.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={handleDialogClose}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSave}
                disabled={loading}
              >
                <CheckIcon size={16} />
                {editingServer ? "Save Changes" : "Add Server"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
