"use client";

import { useState, useCallback } from "react";
import {
  PlusIcon,
  TrashIcon,
  NotePencilIcon,
  PowerIcon,
  PowerOffIcon,
  ServerIcon,
  XIcon,
  CheckIcon,
} from "@/components/icons";
import { useSettings } from "@/hooks/useSettings";
import type { MCPServerConfig } from "@/types";
import { cn } from "@/lib/utils";
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
    name: "",
    command: "",
    args: "",
    env: "",
    enabled: true,
  };
}

function serverToFormData(server: MCPServerConfig): MCPServerFormData {
  return {
    name: server.name,
    command: server.command,
    args: stringifyArgs(server.args),
    env: stringifyEnv(server.env),
    enabled: server.enabled,
  };
}

function formDataToServer(formData: MCPServerFormData): MCPServerConfig {
  return {
    name: formData.name.trim(),
    command: formData.command.trim(),
    args: parseArgs(formData.args),
    env: parseEnv(formData.env),
    enabled: formData.enabled,
  };
}

export function MCPSection() {
  const { t } = useTranslation();
  const { settings, save, loading } = useSettings();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServerConfig | null>(null);
  const [formData, setFormData] = useState<MCPServerFormData>(emptyFormData());
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const servers = settings.mcpServers || [];

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

  return (
    <SettingsSection
      title={t('settings.mcp')}
      description="Manage Model Context Protocol (MCP) servers for extended capabilities"
    >
      {servers.length === 0 ? (
        <SettingsCard>
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <ServerIcon className="h-12 w-12 text-muted-foreground mb-4" size={48} />
            <p className="text-muted-foreground text-center">
              No MCP servers configured yet.
              <br />
              Add a server to extend agent capabilities with external tools.
            </p>
            <button
              className="mt-4 px-4 py-2 bg-accent text-accent-foreground rounded-lg flex items-center gap-2 hover:bg-accent/90 transition-colors"
              onClick={handleAdd}
            >
              <PlusIcon size={16} />
              Add Your First Server
            </button>
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
          <div className="flex justify-end">
            <button
              className="px-4 py-2 bg-accent text-accent-foreground rounded-lg flex items-center gap-2 hover:bg-accent/90 transition-colors"
              onClick={handleAdd}
            >
              <PlusIcon size={16} />
              Add Server
            </button>
          </div>
        </>
      )}

      {/* Dialog */}
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
