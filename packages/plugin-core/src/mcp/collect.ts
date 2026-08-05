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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { MCPCandidate, MCPCollectionResult, MCPSourceContext } from './discovery';
import type { MCPIssue } from './errors';
import { getMCPErrorMessage, getMCPErrorSeverity, getMCPSuggestedAction } from './error-messages';

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
        transport?: 'stdio' | 'streamable-http';
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
  legacyFileItems: MCPCollectorSettingsItem[];
  agentSettingsMcpServers: MCPCollectorSettingsItem[];
  settingsKvMcpServers: MCPCollectorSettingsItem[];
  environment: Record<string, string>;
  cwd: string;
  isPackaged?: boolean;
  resourcesPath?: string;
}

// ---------------------------------------------------------------------------
// Issue factory for source-read problems (Phase 1B contract)
// ---------------------------------------------------------------------------

function settingsInvalidIssue(
  source: MCPSourceContext,
  reason: string,
  serverName?: string,
): MCPIssue {
  const error = {
    type: 'mcp-settings-invalid' as const,
    source,
    ...(serverName !== undefined ? { serverName } : {}),
    reason,
  };
  return {
    phase: 'discovery',
    source,
    serverName: serverName ?? '<settings>',
    error,
    humanMessage: getMCPErrorMessage(error),
    severity: getMCPErrorSeverity(error),
    suggestedAction: getMCPSuggestedAction(error),
  };
}

// ---------------------------------------------------------------------------
// Bundled resolver
// ---------------------------------------------------------------------------

export function buildBundledLiteratureBundlePath(
  cwd: string,
  isPackaged: boolean,
  resourcesPath: string | undefined,
): string {
  if (isPackaged && resourcesPath) {
    return join(resourcesPath, 'agent-bundle', 'literature-mcp-server.js');
  }
  return join(cwd, 'packages', 'agent', 'bundle', 'literature-mcp-server.js');
}

export function buildBundledLiteratureCandidate(
  cwd: string,
  environment: Record<string, string>,
  isPackaged: boolean = false,
  resourcesPath: string | undefined = undefined,
): MCPCandidate {
  const bundlePath = buildBundledLiteratureBundlePath(cwd, isPackaged, resourcesPath);
  return {
    source: 'bundled',
    rawConfig: {
      name: 'literature',
      command: process.execPath,
      args: [bundlePath, '--db-path', environment.DUYA_CUSTOM_DB_PATH || ''],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DUYA_BETTER_SQLITE3_PATH: environment.DUYA_BETTER_SQLITE3_PATH || '',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy settings.json reader
// ---------------------------------------------------------------------------

export interface ReadLegacyResult {
  items: MCPCollectorSettingsItem[];
  issues: MCPIssue[];
}

/**
 * Read the `mcpServers` array from the legacy on-disk `settings.json`.
 * Returns BOTH the parsed array AND any source-read issues.
 *
 * Issue policy (Phase 1B contract):
 *   - path is null                       -> no items, no issues
 *   - file does not exist                -> no items, no issues
 *   - file exists but JSON is malformed  -> empty items, mcp-settings-invalid issue
 *   - file is well-formed but `mcpServers` is not an array -> empty items, issue
 *   - valid entries -> included in items; bad entries produce per-entry issues
 */
export async function readLegacyFileMcpServers(
  settingsPath: string | null,
): Promise<ReadLegacyResult> {
  if (!settingsPath) return { items: [], issues: [] };

  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf-8');
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) {
      return { items: [], issues: [] };
    }
    return {
      items: [],
      issues: [
        settingsInvalidIssue(
          { source: 'settings', sourceSubOrigin: 'legacyFile' },
          `Failed to read legacy settings.json: ${messageOf(err)}`,
        ),
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      items: [],
      issues: [
        settingsInvalidIssue(
          { source: 'settings', sourceSubOrigin: 'legacyFile' },
          `legacy settings.json is not valid JSON: ${messageOf(err)}`,
        ),
      ],
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      items: [],
      issues: [
        settingsInvalidIssue(
          { source: 'settings', sourceSubOrigin: 'legacyFile' },
          'legacy settings.json root must be an object',
        ),
      ],
    };
  }
  const root = parsed as { mcpServers?: unknown };
  if (root.mcpServers === undefined) {
    return { items: [], issues: [] };
  }
  if (!Array.isArray(root.mcpServers)) {
    return {
      items: [],
      issues: [
        settingsInvalidIssue(
          { source: 'settings', sourceSubOrigin: 'legacyFile' },
          'legacy settings.json mcpServers must be an array',
        ),
      ],
    };
  }

  const items: MCPCollectorSettingsItem[] = [];
  const issues: MCPIssue[] = [];
  for (const [i, entry] of root.mcpServers.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push(
        settingsInvalidIssue(
          { source: 'settings', sourceSubOrigin: 'legacyFile' },
          `legacy mcpServers[${i}] is not an object`,
        ),
      );
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || e.name.trim().length === 0) {
      issues.push(
        settingsInvalidIssue(
          { source: 'settings', sourceSubOrigin: 'legacyFile' },
          `legacy mcpServers[${i}].name is missing or empty`,
          typeof e.name === 'string' ? e.name : undefined,
        ),
      );
      continue;
    }
    if (typeof e.command !== 'string') {
      issues.push(
        settingsInvalidIssue(
          { source: 'settings', sourceSubOrigin: 'legacyFile' },
          `legacy mcpServers[${i}].command is missing or not a string`,
          e.name,
        ),
      );
      continue;
    }
    const item: MCPCollectorSettingsItem = {
      name: e.name,
      command: e.command,
      enabled: typeof e.enabled === 'boolean' ? e.enabled : true,
      args: Array.isArray(e.args)
        ? (e.args as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined,
    };
    const env =
      e.env && typeof e.env === 'object' && !Array.isArray(e.env)
        ? (() => {
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(e.env)) {
              if (typeof v === 'string') out[k] = v;
            }
            return Object.keys(out).length > 0 ? out : undefined;
          })()
        : undefined;
    if (env) item.env = env;
    if (Array.isArray(e.allowedAgentIds)) {
      const allowed = (e.allowedAgentIds as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      );
      if (allowed.length > 0) item.allowedAgentIds = allowed;
    }
    items.push(item);
  }
  return { items, issues };
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
  sourceSubOrigin: 'legacyFile' | 'settingsKv' | 'agentSettings' | 'tomlFile',
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
 * Pure transform. Assembles every candidate from all five data sources
 * (bundled, plugin registry, user TOML, legacyFile, agentSettings,
 * settingsKv). The `legacyFileItems` / `agentSettingsMcpServers` /
 * `settingsKvMcpServers` fields are declared on `MCPCollectorInput` and
 * consumed here so the collector contract is source-complete; whether an
 * adapter actually populates them depends on which stores that process
 * owns. Returns `MCPCollectionResult` with an empty `issues` array — the
 * engine's single transform never reads files, so source-read issues are
 * produced by the adapters upstream.
 */
export function buildMCPCandidates(input: MCPCollectorInput): MCPCollectionResult {
  const candidates: MCPCandidate[] = [];

  candidates.push(
    buildBundledLiteratureCandidate(
      input.cwd,
      input.environment,
      input.isPackaged,
      input.resourcesPath,
    ),
  );

  for (const plugin of input.installedPlugins) {
    candidates.push(...buildCandidatesFromPluginEntry(plugin));
  }

  if (input.legacyFileItems) {
    candidates.push(...buildCandidatesFromSettingsEntries('legacyFile', input.legacyFileItems));
  }
  if (input.agentSettingsMcpServers) {
    candidates.push(
      ...buildCandidatesFromSettingsEntries('agentSettings', input.agentSettingsMcpServers),
    );
  }
  if (input.settingsKvMcpServers) {
    candidates.push(
      ...buildCandidatesFromSettingsEntries('settingsKv', input.settingsKvMcpServers),
    );
  }
  if (input.userTomlItems) {
    candidates.push(...buildCandidatesFromSettingsEntries('tomlFile', input.userTomlItems));
  }

  return { candidates, issues: [] };
}

// Local helpers, no Node `util` dependency.
function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : String(err);
}