/**
 * mcp-config.ts — user-managed MCP list access, backed by ConfigStore.
 *
 * Plan 334 moved user MCPs from mcp.toml into config.toml (`mcp_servers.*`,
 * env secrets split into secrets.json) and deleted mcp.toml. This module keeps
 * the historical `readUserMcpToml`/`writeUserMcpToml` signatures so all five
 * call sites (collect-main, db-handlers, cli/handlers/mcps) keep working while
 * the storage moves to ConfigStore.
 */

import type { UserMcpTomlServer } from '@duya/plugin-core/src/mcp/user-config.js';
import { getConfigStore } from '../config/store-instance';
import type { McpServerEntry } from '../config/schema';
import { notifyMcpConfigChanged } from './mcp-write-reload';

/** Record<string, McpServerEntry> (ConfigStore shape) -> UserMcpTomlServer[] (legacy shape). */
export function mcpServersToServerList(
  mcpServers: Record<string, McpServerEntry> | undefined,
): UserMcpTomlServer[] {
  if (!mcpServers) return [];
  return Object.values(mcpServers).map((entry) => ({
    name: entry.name,
    transport: entry.transport,
    command: entry.command,
    args: entry.args ? [...entry.args] : undefined,
    env: entry.env ? { ...entry.env } : undefined,
    url: entry.url,
    headers: entry.headers ? { ...entry.headers } : undefined,
    enabled: entry.enabled,
    allowedAgentIds: entry.allowedAgentIds ? [...entry.allowedAgentIds] : undefined,
  }));
}

/** UserMcpTomlServer[] -> Record<string, McpServerEntry> (ConfigStore shape). */
export function serverListToMcpServers(
  servers: readonly UserMcpTomlServer[],
): Record<string, McpServerEntry> {
  const out: Record<string, McpServerEntry> = {};
  for (const s of servers) {
    out[s.name] = {
      name: s.name,
      transport: s.transport,
      command: s.command,
      args: s.args ? [...s.args] : undefined,
      env: s.env ? { ...s.env } : undefined,
      url: s.url,
      headers: s.headers ? { ...s.headers } : undefined,
      enabled: s.enabled,
      allowedAgentIds: s.allowedAgentIds ? [...s.allowedAgentIds] : undefined,
    };
  }
  return out;
}

/** Read the current user-managed MCP server list from ConfigStore. */
export async function readUserMcpToml(): Promise<UserMcpTomlServer[]> {
  const mcpServers = getConfigStore().getByPath('mcp_servers') as
    | Record<string, McpServerEntry>
    | undefined;
  return mcpServersToServerList(mcpServers);
}

/** Replace the entire user-managed MCP server list in ConfigStore, then reload MCP. */
export async function writeUserMcpToml(servers: readonly UserMcpTomlServer[]): Promise<void> {
  getConfigStore().set('mcp_servers', serverListToMcpServers(servers));
  await notifyMcpConfigChanged();
}