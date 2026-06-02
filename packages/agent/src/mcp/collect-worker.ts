// packages/agent/src/mcp/collect-worker.ts
// Worker-side MCP candidate collector.
//
// Collects candidates from the worker's data sources (plugin
// registry, settings, bundled resolver, legacy on-disk settings.json)
// and returns a typed `MCPCollectionResult`:
//
//   { candidates: MCPCandidate[]; issues: MCPIssue[] }
//
// The collector ONLY emits source-read errors with `phase: 'discovery'`.
// It does NOT do any of the following — those belong to other layers:
//
//   - env expansion
//   - shadow / builtin fallback replacement
//   - allowedAgentIds filtering
//   - MCP connection
//   - state caching
//   - script-existence checks
//
// All of those belong to the resolution engine in @duya/plugin-core
// or to the runtime layer (MCPManager / initMCPServers), NOT to this
// module. The wiring layer in agent-process-entry.ts (Phase 1C)
// calls this collector and feeds its output to `resolveMCPDiscovery()`.

import { readFile } from 'fs/promises';
import { join } from 'path';

import { pluginDb, configDb, settingDb } from '../ipc/db-client.js';
import { getSettingsPath } from './config.js';
import type { MCPConfigItem } from './config.js';
import type {
  MCPCandidate,
  MCPCollectionResult,
  MCPIssue,
  MCPSourceContext,
} from '@duya/plugin-core';
import {
  getMCPErrorMessage,
  getMCPErrorSeverity,
  getMCPSuggestedAction,
} from '@duya/plugin-core';

// ============================================================================
// Public types — the shape this collector produces / consumes
// ============================================================================

/**
 * A single plugin manifest's MCP server declaration, exactly as the
 * plugin registry returns it. Field names mirror `PluginMcpServerSchema`
 * in `src/lib/plugin-types.ts`.
 */
export interface PluginManifestMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * A minimal slice of `PluginRegistryEntry` that the collector needs.
 * Loosely typed on purpose: the IPC `pluginDb.registryList()` returns
 * `unknown` at the type level; the collector narrows at runtime.
 */
export interface CollectorPluginEntry {
  id: string;
  name: string;
  enabled?: boolean;
  installPath?: string;
  /** Plugin data directory, if the registry provides it. */
  dataPath?: string;
  manifest?: {
    capabilities?: {
      mcpServers?: PluginManifestMcpServer[];
    };
  };
}

/**
 * The data the WORKER collector needs in order to build candidates.
 * Splitting this out as a type makes the collector trivially
 * testable without IPC mocks.
 */
export interface WorkerCollectorInput {
  installedPlugins: CollectorPluginEntry[];
  /** agentSettings.mcpServers, as stored in the agentSettings config. */
  agentSettingsMcpServers: MCPConfigItem[];
  /** Value of the `mcpServers` key in the settingsKv store. */
  settingsKvMcpServers: MCPConfigItem[];
  /**
   * The PARSED legacy `mcpServers` array. The collector delegates
   * reading and parsing to `readLegacyFileMcpServers` (which returns
   * both items AND read issues), so this field is the array only.
   */
  legacyFileMcpServers?: MCPConfigItem[];
  /** Explicit env record for the collector. Worker usually passes `process.env`. */
  environment: Record<string, string>;
  /**
   * The worker process's `cwd`. The bundled resolver uses this to locate
   * the bundled `agent-bundle/literature-mcp-server.js` script.
   */
  cwd: string;
  /**
   * Override the bundled resource-path detection. Worker uses
   * `process.resourcesPath`; tests can pass an explicit value.
   */
  isPackaged?: boolean;
  resourcesPath?: string;
}

// ============================================================================
// Issue factory for source-read problems (Phase 1B contract)
// ============================================================================

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

// ============================================================================
// Bundled resolver (worker side)
// ============================================================================

/**
 * Path to the bundled `literature-mcp-server.js` script. The collector
 * does NOT check whether the file exists — that is a runtime concern
 * owned by `resolveMCPDiscovery()` (which produces a `bundled_missing`
 * or `script_missing` issue when the path is absent). The collector's
 * job is to always surface the bundled entry so the settings page can
 * show it.
 */
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

/**
 * Build a single bundled `MCPCandidate` for the literature MCP server.
 *
 * The collector ALWAYS returns a candidate, even when the bundled
 * script does not exist on disk. Static path validation is the
 * resolution engine's job.
 */
export function buildBundledLiteratureCandidate(
  cwd: string,
  environment: Record<string, string>,
  isPackaged: boolean = !!process.resourcesPath && !process.defaultApp,
  resourcesPath: string | undefined = process.resourcesPath,
): MCPCandidate {
  const literatureBundlePath = buildBundledLiteratureBundlePath(
    cwd,
    isPackaged,
    resourcesPath,
  );
  return {
    source: 'bundled',
    rawConfig: {
      name: 'literature',
      command: 'node',
      args: [literatureBundlePath, '--db-path', environment.DUYA_CUSTOM_DB_PATH || ''],
      env: {
        DUYA_BETTER_SQLITE3_PATH: environment.DUYA_BETTER_SQLITE3_PATH || '',
      },
    },
  };
}

// ============================================================================
// Legacy settings.json reader (worker side, with typed issues)
// ============================================================================

export interface ReadLegacyResult {
  items: MCPConfigItem[];
  issues: MCPIssue[];
}

/**
 * Read the `mcpServers` array from the legacy on-disk `settings.json`
 * file. Returns BOTH the parsed array AND any source-read issues.
 *
 * Issue policy (Phase 1B contract):
 *   - path is null                       → no items, no issues
 *   - file does not exist                → no items, no issues
 *   - file exists but JSON is malformed  → empty items, mcp-settings-invalid issue
 *   - file is well-formed JSON but
 *     `mcpServers` is not an array        → empty items, mcp-settings-invalid issue
 *   - file is well-formed, mcpServers is
 *     an array, individual entries that
 *     lack required fields are SKIPPED
 *     with per-entry issues
 *   - valid entries → included in items
 *
 * Returning a per-entry issue rather than aborting the whole file
 * ensures that one bad entry does not hide the other valid entries
 * the user has on disk.
 */
export async function readLegacyFileMcpServers(
  settingsPath: string | null,
): Promise<ReadLegacyResult> {
  if (!settingsPath) return { items: [], issues: [] };

  // Read + parse. Failure modes:
  //   - ENOENT (file does not exist) → not an error
  //   - other read / parse failures  → mcp-settings-invalid issue
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

  // Structural validation: root is an object with mcpServers array.
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

  // Per-entry validation. Bad entries produce a typed issue and
  // are dropped; good entries pass through.
  const items: MCPConfigItem[] = [];
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
    // We only keep the fields the collector cares about.
    const item: MCPConfigItem = {
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

// Tiny helpers for error inspection (no Node `util` dependency).
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

// ============================================================================
// Per-source candidate builders
// ============================================================================

export function buildCandidatesFromPluginEntry(
  entry: CollectorPluginEntry,
): MCPCandidate[] {
  if (entry.enabled !== true) return [];
  if (!entry.id) return [];
  if (!entry.installPath) return [];
  const mcpServers = entry.manifest?.capabilities?.mcpServers ?? [];
  const out: MCPCandidate[] = [];
  for (const server of mcpServers) {
    if (!server.name || !server.command) continue;
    out.push({
      source: 'plugin',
      pluginId: entry.id,
      pluginName: entry.name,
      pluginRoot: entry.installPath,
      pluginDataPath: entry.dataPath,
      rawConfig: {
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env,
      },
    });
  }
  return out;
}

export function buildCandidatesFromSettingsEntries(
  sourceSubOrigin: 'legacyFile' | 'settingsKv' | 'agentSettings',
  entries: MCPConfigItem[],
): MCPCandidate[] {
  const out: MCPCandidate[] = [];
  for (const item of entries) {
    if (item.enabled === false) continue;
    if (!item.name || !item.command) continue;
    out.push({
      source: 'settings',
      sourceSubOrigin,
      rawConfig: {
        name: item.name,
        command: item.command,
        args: item.args,
        env: item.env,
        allowedAgentIds: item.allowedAgentIds,
      },
    });
  }
  return out;
}

// ============================================================================
// Pure: build candidates from fully-resolved worker input
// ============================================================================

/**
 * Pure transform. Returns `MCPCollectionResult`. The collector does
 * NOT add legacyFile issues here — those are produced by
 * `readLegacyFileMcpServers` upstream. This function only combines
 * already-collected items into the final candidate list.
 */
export function buildWorkerMCPCandidates(
  input: WorkerCollectorInput,
): MCPCollectionResult {
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

  if (input.legacyFileMcpServers) {
    candidates.push(
      ...buildCandidatesFromSettingsEntries('legacyFile', input.legacyFileMcpServers),
    );
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

  return { candidates, issues: [] };
}

// ============================================================================
// Public entry: fetch via IPC and call the pure builder
// ============================================================================

/**
 * The full worker-side candidate collector. Fetches from `pluginDb`,
 * `configDb`, and `settingDb` via the agent-process IPC channel;
 * reads the on-disk legacyFile; delegates the per-source transforms
 * to the pure builders.
 */
export async function collectWorkerMCPCandidates(): Promise<MCPCollectionResult> {
  const issues: MCPIssue[] = [];

  const input: WorkerCollectorInput = {
    installedPlugins: [],
    agentSettingsMcpServers: [],
    settingsKvMcpServers: [],
    legacyFileMcpServers: undefined,
    environment: { ...process.env } as Record<string, string>,
    cwd: process.cwd(),
  };

  try {
    const raw = await pluginDb.registryList();
    if (Array.isArray(raw)) {
      input.installedPlugins = raw as CollectorPluginEntry[];
    }
  } catch (err) {
    console.warn('[collectWorkerMCPCandidates] pluginDb.registryList failed:', err);
  }

  try {
    const agentSettings = (await configDb.agentGetSettings()) as
      | { mcpServers?: MCPConfigItem[] }
      | undefined;
    if (agentSettings && Array.isArray(agentSettings.mcpServers)) {
      input.agentSettingsMcpServers = agentSettings.mcpServers;
    }
  } catch (err) {
    console.warn('[collectWorkerMCPCandidates] configDb.agentGetSettings failed:', err);
  }

  try {
    const raw = (await settingDb.getJson<MCPConfigItem[]>('mcpServers', [])) as unknown;
    if (Array.isArray(raw)) {
      input.settingsKvMcpServers = raw;
    }
  } catch (err) {
    console.warn('[collectWorkerMCPCandidates] settingDb.getJson("mcpServers") failed:', err);
  }

  // 4. Legacy on-disk settings.json. Read + parse via the typed
  //    helper. Items go into the input; issues merge into the result.
  try {
    const legacy = await readLegacyFileMcpServers(getSettingsPath());
    input.legacyFileMcpServers = legacy.items;
    issues.push(...legacy.issues);
  } catch (err) {
    console.warn('[collectWorkerMCPCandidates] legacyFile read failed:', err);
  }

  const built = buildWorkerMCPCandidates(input);
  return { candidates: built.candidates, issues: [...issues, ...built.issues] };
}
