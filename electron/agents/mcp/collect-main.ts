// electron/agents/mcp/collect-main.ts
// Main-process MCP candidate collector.
//
// Produces `MCPCollectionResult { candidates, issues }` from the
// main-process data sources (plugin registry, settings, bundled
// resolver, legacy on-disk settings.json). STRICTLY collectors only —
// no env expansion, no shadow / fallback resolution, no
// allowedAgentIds filtering, no connection, no state caching.
//
// The worker adapter is `packages/agent/src/mcp/collect-worker.ts`.
// Both adapters produce results that satisfy the same
// `MCPCollectionResult` contract. The wiring layer (Phase 1D) calls
// this collector from the main process and feeds its output to
// `resolveMCPDiscovery()`.
//
// SCOPE NOTE — main-process source coverage:
//   1. bundled (literature bootstrap fallback) — always emitted
//   2. plugin registry (read via PluginManager.listInstalled() +
//      per-plugin manifest read)
//   3. settings — agentSettings (via getConfigManager().getAgentSettings())
//   4. settings — settingsKv (via better-sqlite3 direct read on the
//      settings table; same SQL pattern as db-bridge.ts:763)
//   5. settings — legacyFile (on-disk settings.json; self-contained
//      fs + JSON.parse, no agent-runtime import)
//
// All 5 sources are now covered. legacyFile is implemented here
// without importing from `@duya/agent`.

import { readFile } from 'fs/promises';
import { join } from 'path';

import { getLogger } from '../../logging/logger.js';
import { getPluginManager } from '../../plugins/PluginManager.js';
import { getConfigManager } from '../../config/manager.js';
import { getDatabase } from '../../db/connection.js';
import { readPluginManifest } from '../../plugins/manifest.js';
import {
  getMCPErrorMessage,
  getMCPErrorSeverity,
  getMCPSuggestedAction,
  type MCPCandidate,
  type MCPCollectionResult,
  type MCPIssue,
  type MCPSourceContext,
} from '@duya/plugin-core';

// ============================================================================
// Types
// ============================================================================

/**
 * Narrow manifest slice the collector needs. Decoupled from
 * `PluginManifest` so test code can construct entries by hand.
 */
export interface MainCollectorManifestSlice {
  capabilities?: {
    mcpServers?: Array<{
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }>;
  };
}

export interface MainCollectorPluginEntry {
  id: string;
  name: string;
  enabled?: boolean;
  installPath?: string;
  dataPath?: string;
  manifest?: MainCollectorManifestSlice;
}

export interface MainCollectorSettingsItem {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  allowedAgentIds?: string[];
}

export interface MainCollectorInput {
  installedPlugins: MainCollectorPluginEntry[];
  legacyFileItems: MainCollectorSettingsItem[];
  agentSettingsMcpServers: MainCollectorSettingsItem[];
  settingsKvMcpServers: MainCollectorSettingsItem[];
  environment: Record<string, string>;
  cwd: string;
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
// Bundled resolver (main side)
// ============================================================================

export function buildMainBundledLiteratureBundlePath(
  cwd: string,
  isPackaged: boolean,
  resourcesPath: string | undefined,
): string {
  if (isPackaged && resourcesPath) {
    return join(resourcesPath, 'agent-bundle', 'literature-mcp-server.js');
  }
  return join(cwd, 'packages', 'agent', 'bundle', 'literature-mcp-server.js');
}

export function buildMainBundledLiteratureCandidate(
  cwd: string,
  environment: Record<string, string>,
  isPackaged: boolean = !!process.resourcesPath && !process.defaultApp,
  resourcesPath: string | undefined = process.resourcesPath,
): MCPCandidate {
  const literatureBundlePath = buildMainBundledLiteratureBundlePath(
    cwd,
    isPackaged,
    resourcesPath,
  );
  return {
    source: 'bundled',
    rawConfig: {
      name: 'literature',
      command: process.execPath,
      args: [literatureBundlePath, '--db-path', environment.DUYA_CUSTOM_DB_PATH || ''],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DUYA_BETTER_SQLITE3_PATH: environment.DUYA_BETTER_SQLITE3_PATH || '',
      },
    },
  };
}

// ============================================================================
// Legacy settings.json reader (main side, with typed issues)
// ============================================================================

export interface ReadMainLegacyResult {
  items: MainCollectorSettingsItem[];
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
 */
export async function readMainLegacyFileMcpServers(
  settingsPath: string | null,
): Promise<ReadMainLegacyResult> {
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

  const items: MainCollectorSettingsItem[] = [];
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
    const item: MainCollectorSettingsItem = {
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

// Small helpers — local, no Node `util` dependency.
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
// Legacy settings.json PATH (main side, no agent runtime import)
// ============================================================================

/**
 * Compute the path to the legacy on-disk `settings.json` for the main
 * process. Mirrors the worker-side `getSettingsPath()` in
 * `packages/agent/src/mcp/config.ts` but is a self-contained
 * implementation in main — no import from `@duya/agent`.
 *
 * Signature: `(duyaAppDataPath?, env?) => string | null`
 *
 * - `duyaAppDataPath` is the absolute directory the main process
 *   uses for app data. In the production main process this is
 *   `app.getPath('userData')`, which the bootstrap script mirrors
 *   into `process.env.DUYA_APP_DATA_PATH` (so this module does not
 *   need to import `electron`). When provided, it is the source of
 *   truth and the function returns `<duyaAppDataPath>/settings.json`.
 * - `env` defaults to `process.env` and is used as a fallback to look
 *   for `DUYA_APP_DATA_PATH` when the first argument is undefined.
 *   This matches the contract of the worker-side `getSettingsPath()`,
 *   which inspects `process.env.DUYA_APP_DATA_PATH` as a fallback.
 *
 * Returns the absolute path to `settings.json`, or `null` when no
 * app data directory is resolvable.
 */
export function getMainLegacySettingsPath(
  duyaAppDataPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (duyaAppDataPath) {
    return join(duyaAppDataPath, 'settings.json');
  }
  const fallback = env.DUYA_APP_DATA_PATH;
  if (fallback) {
    return join(fallback, 'settings.json');
  }
  return null;
}

// ============================================================================
// Per-source candidate builders
// ============================================================================

export function buildMainCandidatesFromPluginEntry(
  entry: MainCollectorPluginEntry,
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

export function buildMainCandidatesFromSettingsEntries(
  sourceSubOrigin: 'legacyFile' | 'settingsKv' | 'agentSettings',
  entries: MainCollectorSettingsItem[],
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
// Pure: build candidates from fully-resolved main input
// ============================================================================

/**
 * Pure transform. Returns `MCPCollectionResult`. legacyFile issues
 * are produced by `readMainLegacyFileMcpServers` upstream; this
 * function only assembles the candidate list.
 */
export function buildMainMCPCandidates(
  input: MainCollectorInput,
): MCPCollectionResult {
  const candidates: MCPCandidate[] = [];

  candidates.push(
    buildMainBundledLiteratureCandidate(
      input.cwd,
      input.environment,
      input.isPackaged,
      input.resourcesPath,
    ),
  );

  for (const plugin of input.installedPlugins) {
    candidates.push(...buildMainCandidatesFromPluginEntry(plugin));
  }

  if (input.legacyFileItems) {
    candidates.push(
      ...buildMainCandidatesFromSettingsEntries('legacyFile', input.legacyFileItems),
    );
  }
  if (input.agentSettingsMcpServers) {
    candidates.push(
      ...buildMainCandidatesFromSettingsEntries('agentSettings', input.agentSettingsMcpServers),
    );
  }
  if (input.settingsKvMcpServers) {
    candidates.push(
      ...buildMainCandidatesFromSettingsEntries('settingsKv', input.settingsKvMcpServers),
    );
  }

  return { candidates, issues: [] };
}

// ============================================================================
// Public entry: fetch via main-process accessors and call the pure builder
// ============================================================================

/**
 * Read the `mcpServers` value from the settingsKv table.
 */
function readSettingsKvMcpServers(logger: ReturnType<typeof getLogger>): MainCollectorSettingsItem[] {
  try {
    const db = getDatabase();
    if (!db) return [];
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('mcpServers') as
      | { value: string }
      | undefined;
    if (!row) return [];
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed as MainCollectorSettingsItem[];
  } catch (err) {
    logger.warn(
      'collectMainMCPCandidates: settingsKv mcpServers read failed',
      { error: err instanceof Error ? err.message : String(err) },
    );
    return [];
  }
}

/**
 * The full main-process candidate collector. Fetches from the plugin
 * manager, the config manager, the settingsKv table, and the legacy
 * on-disk settings.json; delegates the per-source transforms to the
 * pure builders. Returns a typed `MCPCollectionResult`.
 */
export async function collectMainMCPCandidates(): Promise<MCPCollectionResult> {
  const logger = getLogger();
  const issues: MCPIssue[] = [];

  const input: MainCollectorInput = {
    installedPlugins: [],
    legacyFileItems: [],
    agentSettingsMcpServers: [],
    settingsKvMcpServers: [],
    environment: { ...process.env } as Record<string, string>,
    cwd: process.cwd(),
  };

  // 1. Plugin manager. The main-process plugin manager returns
  //    PluginViewItem[] which does NOT include the manifest; the
  //    manifest is read on demand from disk via readPluginManifest.
  try {
    const items = getPluginManager().listInstalled();
    input.installedPlugins = items.map((item): MainCollectorPluginEntry => {
      const entry: MainCollectorPluginEntry = {
        id: item.id,
        name: item.name,
        enabled: item.enabled,
        installPath: item.installPath,
        dataPath: item.dataPath,
      };
      if (item.installPath) {
        try {
          entry.manifest = readPluginManifest(item.installPath);
        } catch {
          // Manifest missing or malformed: leave it absent. The
          // collector produces no MCP candidates for this plugin,
          // which matches the worker's behavior for the same
          // condition.
        }
      }
      return entry;
    });
  } catch (err) {
    logger.warn(
      'collectMainMCPCandidates: getPluginManager().listInstalled() failed',
      { error: err instanceof Error ? err.message : String(err) },
    );
  }

  // 2. agentSettings
  try {
    const cm = getConfigManager();
    const settings = cm.getAgentSettings() as unknown as
      | { mcpServers?: MainCollectorSettingsItem[] }
      | undefined;
    if (settings && Array.isArray(settings.mcpServers)) {
      input.agentSettingsMcpServers = settings.mcpServers;
    }
  } catch (err) {
    logger.warn(
      'collectMainMCPCandidates: getConfigManager().getAgentSettings() failed',
      { error: err instanceof Error ? err.message : String(err) },
    );
  }

  // 3. settingsKv
  input.settingsKvMcpServers = readSettingsKvMcpServers(logger);

  // 4. Legacy on-disk settings.json. Read + parse; collect typed
  //    issues for malformed JSON / structure. Per-entry validation
  //    errors are reported as typed issues; valid entries still pass.
  try {
    const legacy = await readMainLegacyFileMcpServers(
      getMainLegacySettingsPath(process.env.DUYA_APP_DATA_PATH),
    );
    input.legacyFileItems = legacy.items;
    issues.push(...legacy.issues);
  } catch (err) {
    logger.warn(
      'collectMainMCPCandidates: legacyFile read failed',
      { error: err instanceof Error ? err.message : String(err) },
    );
  }

  const built = buildMainMCPCandidates(input);
  return { candidates: built.candidates, issues: [...issues, ...built.issues] };
}
