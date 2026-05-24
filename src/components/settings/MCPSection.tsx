"use client";

import { useState, useCallback, useEffect } from "react";
import {
  PlusIcon,
  TrashIcon,
  NotePencilIcon,
  PowerIcon,
  PowerOffIcon,
  ServerIcon,
  XIcon,
  CheckIcon,
  DownloadSimpleIcon,
} from "@/components/icons";
import { useSettings } from "@/hooks/useSettings";
import type { MCPServerConfig } from "@/types";
import { cn } from "@/lib/utils";
import { parseMcpInput, isMultiConfig } from "@/lib/mcp-parser";
import type { ParsedMCPConfig } from "@/lib/mcp-parser";
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

  useEffect(() => {
    listAgentProfiles().then(setAgentProfiles).catch(() => setAgentProfiles([]));
  }, []);

  const servers = settings.mcpServers || [];

  const existingServerIds = new Set(servers.map((s) => s.name));

  const filteredPresets = PRESET_MCP_SERVERS.filter((p) => {
    if (presetCategory && p.category !== presetCategory) return false;
    if (presetSearch) {
      const q = presetSearch.toLowerCase();
      return p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
    }
    return true;
  });

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
        <button
          className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/50 transition-colors rounded-lg"
          onClick={() => setPresetExpanded(!presetExpanded)}
        >
          <span className="font-medium text-sm">Recommended MCP Servers</span>
          <span className="text-xs text-muted-foreground">
            {PRESET_MCP_SERVERS.length} available
            <span className="ml-2">{presetExpanded ? '▴' : '▾'}</span>
          </span>
        </button>
        {presetExpanded && (
          <div className="px-4 pb-4">
            <div className="flex gap-2 mb-3 flex-wrap">
              <button
                className={cn(
                  "px-3 py-1 text-xs rounded-full transition-colors",
                  !presetCategory
                    ? "bg-accent text-accent-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/70"
                )}
                onClick={() => setPresetCategory(null)}
              >
                All
              </button>
              {MCP_CATEGORIES.map((cat) => (
                <button
                  key={cat.key}
                  className={cn(
                    "px-3 py-1 text-xs rounded-full transition-colors",
                    presetCategory === cat.key
                      ? "bg-accent text-accent-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/70"
                  )}
                  onClick={() =>
                    setPresetCategory(presetCategory === cat.key ? null : cat.key)
                  }
                >
                  {cat.label}
                </button>
              ))}
            </div>
            <div className="mb-3">
              <input
                type="text"
                placeholder="Search presets..."
                value={presetSearch}
                onChange={(e) => setPresetSearch(e.target.value)}
                className="w-full px-3 py-1.5 text-sm rounded-lg border bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent border-border/50"
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
                      <button
                        className={cn(
                          "ml-3 px-3 py-1 text-xs rounded-lg transition-colors shrink-0",
                          isAdded
                            ? "bg-muted text-muted-foreground cursor-not-allowed"
                            : "bg-accent text-accent-foreground hover:bg-accent/90"
                        )}
                        disabled={isAdded}
                        onClick={() => handleAddPreset(preset.id)}
                      >
                        {isAdded ? 'Added' : 'Add'}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </SettingsCard>

      {servers.length === 0 ? (
        <SettingsCard>
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <ServerIcon className="h-12 w-12 text-muted-foreground mb-4" size={48} />
            <p className="text-muted-foreground text-center">
              No MCP servers configured yet.
              <br />
              Add a server to extend agent capabilities with external tools.
            </p>
            <div className="flex gap-2 mt-4">
              <button
                className="px-4 py-2 bg-accent text-accent-foreground rounded-lg flex items-center gap-2 hover:bg-accent/90 transition-colors"
                onClick={handleAdd}
              >
                <PlusIcon size={16} />
                Add Your First Server
              </button>
              <button
                className="px-4 py-2 border border-border/50 rounded-lg flex items-center gap-2 hover:bg-muted transition-colors"
                onClick={handleImportOpen}
              >
                <DownloadSimpleIcon size={16} />
                Import from text
              </button>
            </div>
          </div>
        </SettingsCard>
      ) : (
        <>
          {servers.map((server) => (
            <SettingsCard key={server.name} className="mb-4">
              <div className="px-4 py-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn(
                        "w-10 h-10 rounded-lg flex items-center justify-center",
                        server.enabled
                          ? "bg-green-500/10 text-green-600"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      <ServerIcon size={20} />
                    </div>
                    <div>
                      <h3 className="font-medium text-foreground">{server.name}</h3>
                      <p className="text-sm text-muted-foreground font-mono mt-0.5">
                        {server.command} {stringifyArgs(server.args)}
                      </p>
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
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      className={cn(
                        "p-2 rounded-lg transition-colors",
                        server.enabled
                          ? "text-green-600 hover:bg-green-500/10"
                          : "text-muted-foreground hover:bg-muted"
                      )}
                      onClick={() => handleToggleEnabled(server)}
                      title={server.enabled ? "Disable" : "Enable"}
                    >
                      {server.enabled ? <PowerIcon size={18} /> : <PowerOffIcon size={18} />}
                    </button>
                    <button
                      className="p-2 rounded-lg hover:bg-muted transition-colors text-foreground"
                      onClick={() => handleEdit(server)}
                      title="Edit"
                    >
                      <NotePencilIcon size={18} />
                    </button>
                    <button
                      className="p-2 rounded-lg hover:bg-destructive/10 transition-colors text-destructive"
                      onClick={() => handleDelete(server.name)}
                      title="Delete"
                    >
                      <TrashIcon size={18} />
                    </button>
                  </div>
                </div>
              </div>
            </SettingsCard>
          ))}
          <div className="flex justify-end gap-2">
            <button
              className="px-4 py-2 bg-accent text-accent-foreground rounded-lg flex items-center gap-2 hover:bg-accent/90 transition-colors"
              onClick={handleAdd}
            >
              <PlusIcon size={16} />
              Add Server
            </button>
            <button
              className="px-4 py-2 border border-border/50 rounded-lg flex items-center gap-2 hover:bg-muted transition-colors"
              onClick={handleImportOpen}
            >
              <DownloadSimpleIcon size={16} />
              Import from text
            </button>
          </div>
        </>
      )}

      {/* Import Dialog */}
      {isImportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-surface rounded-xl border border-border shadow-lg w-full max-w-lg mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Import MCP Server</h2>
                <button
                  onClick={handleImportClose}
                  className="p-1 rounded-lg hover:bg-muted transition-colors"
                >
                  <XIcon size={20} />
                </button>
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
                    <button
                      key={idx}
                      className="w-full px-4 py-3 rounded-lg border border-border/50 hover:bg-muted transition-colors text-left"
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
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button
                onClick={handleImportClose}
                className="px-4 py-2 rounded-lg border border-border/50 hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleParse}
                disabled={!importText.trim()}
                className="px-4 py-2 bg-accent text-accent-foreground rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                <CheckIcon size={16} />
                Parse
              </button>
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
                <button
                  onClick={handleDialogClose}
                  className="p-1 rounded-lg hover:bg-muted transition-colors"
                >
                  <XIcon size={20} />
                </button>
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
                <input
                  type="text"
                  placeholder="e.g., filesystem, github"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, name: e.target.value }))
                  }
                  disabled={!!editingServer}
                  className={cn(
                    "w-full px-3 py-2 rounded-lg border bg-surface text-foreground",
                    "focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                    "border-border/50",
                    formErrors.name && "border-red-500 focus:ring-red-500/50 focus:border-red-500"
                  )}
                />
                {formErrors.name && (
                  <p className="text-sm text-red-500 mt-1">{formErrors.name}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Command <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g., npx, node, python"
                  value={formData.command}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, command: e.target.value }))
                  }
                  className={cn(
                    "w-full px-3 py-2 rounded-lg border bg-surface text-foreground",
                    "focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent",
                    "border-border/50",
                    formErrors.command && "border-red-500 focus:ring-red-500/50 focus:border-red-500"
                  )}
                />
                {formErrors.command && (
                  <p className="text-sm text-red-500 mt-1">{formErrors.command}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Arguments (space-separated)
                </label>
                <input
                  type="text"
                  placeholder="e.g., -y @modelcontextprotocol/server-filesystem"
                  value={formData.args}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, args: e.target.value }))
                  }
                  className="w-full px-3 py-2 rounded-lg border bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent border-border/50"
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
              <button
                onClick={handleDialogClose}
                className="px-4 py-2 rounded-lg border border-border/50 hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={loading}
                className="px-4 py-2 bg-accent text-accent-foreground rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                <CheckIcon size={16} />
                {editingServer ? "Save Changes" : "Add Server"}
              </button>
            </div>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
