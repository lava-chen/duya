// packages/plugin-core/src/mcp/collect.ts
// Environment-agnostic MCP candidate collector.
//
// Pure transforms + a single `buildMCPCandidates(input)` assembly.
// No DB / IPC / plugin-manager access — those live in the source
// adapters (electron collect-main / agent collect-worker). Both
// adapters fetch their own data and feed this engine a
// `MCPCollectorInput`.
//
// This module imports Node builtins (`fs`, `path`) and is therefore
// NOT re-exported from the barrel (same policy as `./resolve`). Node
// side imports it directly by path.

import type { MCPCandidate, MCPCollectionResult } from './discovery';

/** One user/settings MCP server entry, regardless of source. */
export interface MCPCollectorSettingsItem {
  name: string;
  transport?: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  allowedAgentIds?: string[];
}

/** A plugin's MCP server declarations, narrowed from the manifest. */
export interface MCPCollectorPluginEntry {
  id: string;
  name: string;
  enabled?: boolean;
  installPath?: string;
  dataPath?: string;
  manifest?: {
    capabilities?: {
      mcpServers?: Array<{
        name: string;
        transport?: 'stdio' | 'streamable-http' | 'sse';
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
      }>;
    };
  };
}

/** Fully-resolved input for the pure collector. */
export interface MCPCollectorInput {
  installedPlugins: MCPCollectorPluginEntry[];
  /** The user-managed source: DUYA userData/mcp.toml. */
  userTomlItems?: MCPCollectorSettingsItem[];
}

// ---------------------------------------------------------------------------
// Per-source candidate builders
// ---------------------------------------------------------------------------

export function buildCandidatesFromPluginEntry(
  entry: MCPCollectorPluginEntry,
): MCPCandidate[] {
  if (entry.enabled !== true) return [];
  if (!entry.id) return [];
  if (!entry.installPath) return [];
  const mcpServers = entry.manifest?.capabilities?.mcpServers ?? [];
  const out: MCPCandidate[] = [];
  for (const server of mcpServers) {
    // Agent Plugins `sse` servers are recognized at the manifest/discovery
    // layer only (plan 335). The MCP runtime pipeline does not support
    // `sse` transport, so they are filtered out here and never connect.
    if (server.transport === 'sse') continue;
    if (!server.name || (!server.command && !server.url)) continue;
    out.push({
      source: 'plugin',
      pluginId: entry.id,
      pluginName: entry.name,
      pluginRoot: entry.installPath,
      pluginDataPath: entry.dataPath,
      rawConfig: {
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        env: server.env,
        url: server.url,
        headers: server.headers,
      },
    });
  }
  return out;
}

export function buildCandidatesFromSettingsEntries(
  sourceSubOrigin: 'tomlFile',
  entries: MCPCollectorSettingsItem[],
): MCPCandidate[] {
  const out: MCPCandidate[] = [];
  for (const item of entries) {
    if (item.enabled === false) continue;
    if (!item.name || (!item.command && !item.url)) continue;
    out.push({
      source: 'settings',
      sourceSubOrigin,
      rawConfig: {
        name: item.name,
        transport: item.transport,
        command: item.command,
        args: item.args,
        env: item.env,
        url: item.url,
        headers: item.headers,
        allowedAgentIds: item.allowedAgentIds,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure: build candidates from fully-resolved input
// ---------------------------------------------------------------------------

/**
 * Pure transform. Assembles every candidate from the two live data
 * sources: the plugin registry (installed plugin manifests) and the
 * user mcp.toml. Returns `MCPCollectionResult` with an empty `issues`
 * array — the engine's single transform never reads files, so
 * source-read issues are produced by the adapters upstream.
 */
export function buildMCPCandidates(input: MCPCollectorInput): MCPCollectionResult {
  const candidates: MCPCandidate[] = [];

  for (const plugin of input.installedPlugins) {
    candidates.push(...buildCandidatesFromPluginEntry(plugin));
  }

  if (input.userTomlItems) {
    candidates.push(...buildCandidatesFromSettingsEntries('tomlFile', input.userTomlItems));
  }

  return { candidates, issues: [] };
}