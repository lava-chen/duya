// packages/plugin-core/src/mcp/discovery.ts
// Pure types for MCP discovery candidates, inventory, and resolution results.
// No I/O, no DB, no process.env, no plugin-registry imports — all data is
// pre-collected by worker or main adapters and passed in as MCPCandidate[].

import type { MCPDiscoveryStatus, MCPConnectionStatus } from './status';
import type { MCPIssue } from './errors';

/**
 * Where an MCP server config originated. The engine treats all three as
 * first-class sources; dedup rules are explicit (see shadow.ts in Phase 1).
 */
export type MCPSource = 'bundled' | 'plugin' | 'settings';

/**
 * For settings-sourced entries, the legacy/canonical sub-origin.
 * `agentSettings` is the newest and wins over `settingsKv` and `legacyFile`
 * for the same unscoped server name (within-settings shadow rule).
 */
export type MCPSettingsSubOrigin = 'legacyFile' | 'settingsKv' | 'agentSettings';

/**
 * Provenance info attached to MCP issues, used by the UI to bucket issues
 * by source. Field-omitted entries are valid where not applicable.
 */
export interface MCPSourceContext {
  source: MCPSource;
  sourceSubOrigin?: MCPSettingsSubOrigin;
  pluginId?: string;
  pluginName?: string;
}

/**
 * A pre-collected MCP server candidate, as built by either the worker
 * adapter (collectWorkerMCPCandidates) or the main adapter
 * (collectMainMCPCandidates). The resolution engine consumes these and
 * performs no I/O of its own.
 *
 * Note: `command` and `args` are pre-expansion at this stage. The engine
 * applies env expansion via the `environment` field in ResolutionContext.
 */
export interface MCPCandidate {
  source: MCPSource;
  sourceSubOrigin?: MCPSettingsSubOrigin;
  pluginId?: string;
  pluginName?: string;
  /** Absolute path to the plugin install dir; required for `${DUYA_PLUGIN_ROOT}` and similar substitutions. */
  pluginRoot?: string;
  /** Absolute path to the plugin data dir; required for `${DUYA_PLUGIN_DATA}`. */
  pluginDataPath?: string;
  rawConfig: {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    allowedAgentIds?: string[];
    /** Optional reserved-for-future cross-source override key. Not consulted this round. */
    overrideTarget?: string;
  };
}

/**
 * Context the resolution engine needs to interpret a candidate. All data
 * is passed explicitly — the engine does NOT read process.env, the plugin
 * registry, or any DB.
 */
export interface ResolutionContext {
  /** Pre-captured env record (e.g. { ...process.env } from the caller). Used for ${VAR} expansion. */
  environment: Record<string, string>;
  /** Per-plugin user-config map; used for ${user_config.KEY} expansion. */
  userConfigByPlugin: Record<string, Record<string, string>>;
}

/**
 * A single MCP server entry, regardless of whether it is connectable.
 * The settings page renders every inventory entry, including failed ones,
 * with a per-row discovery status icon.
 */
export interface MCPServerInventoryEntry {
  /** Globally unique per resolution run. e.g. 'bundled:literature' / 'plugin:<id>:<name>' / 'settings:<subOrigin>:<name>'. */
  inventoryId: string;
  source: MCPSource;
  sourceSubOrigin?: MCPSettingsSubOrigin;
  pluginId?: string;
  pluginName?: string;
  serverName: string;             // unscoped display name (rawConfig.name)
  scopedServerName: string;       // internal identifier (plugin:<id>:<name> for plugins, plain for others)
  rawConfig: { command: string; args?: string[]; env?: Record<string, string>; allowedAgentIds?: string[] };
  discoveryStatus: MCPDiscoveryStatus;
  allowedAgentIds?: string[];
  /** Reserved for a future cross-source override plan; unused this round. */
  logicalTargetId?: string;
  /** inventoryId of the entry that wins over this one. Only set for the within-settings newest-wins rule. */
  shadowedBy?: string;
}

/**
 * The connectable, deduped, env-expanded subset of inventory that the
 * worker (or any future runner) can pass to `initMCPServers`. Carries
 * enough runtime metadata that downstream phases do not need to re-derive
 * source/plugin association from the raw config.
 */
export interface ResolvedMCPServerConfig {
  inventoryId: string;
  source: MCPSource;
  sourceSubOrigin?: MCPSettingsSubOrigin;
  pluginId?: string;
  pluginName?: string;
  scopedServerName: string;
  rawConfig: { command: string; args: string[]; env: Record<string, string> };
  allowedAgentIds?: string[];
}

/**
 * The engine's output. inventory contains every candidate (even failed ones);
 * resolvedConfigs contains the post-shadow, post-validation subset ready to
 * connect; issues contains every typed failure with its phase tag.
 */
export interface ResolutionResult {
  inventory: MCPServerInventoryEntry[];
  resolvedConfigs: ResolvedMCPServerConfig[];
  issues: MCPIssue[];
}

/**
 * Builtin fallback replacement map (Rev 5.1).
 *
 * `BUILTIN_FALLBACK_REPLACEMENTS` is a narrow, hard-coded list of bundled
 * MCP server entries that are bootstrap fallbacks for a corresponding
 * official plugin. When the plugin is installed AND enabled, the bundled
 * fallback stays in `inventory` (so the user can see it exists) but is
 * marked `shadowedBy` and excluded from `resolvedConfigs`. When the
 * plugin is NOT installed or NOT enabled, the bundled fallback stands
 * alone and is included in `resolvedConfigs` as before.
 *
 * This is NOT a general cross-source override mechanism. Cross-plugin
 * override (e.g. user settings declaring `overrideTarget`) is deferred
 * to a follow-up plan. Adding a new pair here is a deliberate decision
 * and should be reviewed by the plugin team.
 *
 * Pair semantics:
 *   - `bundledServerName` : the unscoped server name of the bundled
 *                    entry, matching `MCPServerInventoryEntry.serverName`
 *                    for source 'bundled'. The bundled entry's
 *                    `inventoryId` is `bundled:<bundledServerName>`.
 *   - `pluginId`   : the official plugin id that supersedes the fallback.
 *                    Matched against `MCPCandidate.pluginId` (and
 *                    `MCPServerInventoryEntry.pluginId` for plugin source).
 *   - `pluginServerName` : the unscoped server name of the plugin's
 *                    matching entry. The pair only fires when both
 *                    sides have these names.
 */
export interface BuiltinFallbackReplacement {
  bundledServerName: string;
  pluginId: string;
  pluginServerName: string;
}

/**
 * The complete list. Add a new entry ONLY when a bundled MCP server is
 * a bootstrap fallback for an officially supported plugin, and ONLY
 * after the plugin team has signed off.
 *
 * The only current pair is the literature plugin / bundled fallback,
 * because audit #6 confirmed both ultimately invoke the same
 * `literature-mcp-server.js` bundle.
 */
export const BUILTIN_FALLBACK_REPLACEMENTS: ReadonlyArray<BuiltinFallbackReplacement> = [
  {
    bundledServerName: 'literature',
    pluginId: 'com.duya.literature',
    pluginServerName: 'literature',
  },
];

/**
 * Given a bundled entry's unscoped server name and the list of plugin
 * inventory ids currently present in the resolution pass, return the
 * inventory id of the matching fallback-replacement plugin entry, or
 * `undefined` if the bundled entry is not a known fallback or no
 * plugin replacement is present.
 *
 * Pure function; the engine in Phase 1 calls this once per bundled
 * entry whose `source === 'bundled'`. The result drives:
 *   - The bundled entry's `shadowedBy` (set to the plugin's inventoryId)
 *   - An `mcp-server-shadowed` issue on the bundled entry, with
 *     `phase: 'resolution'`, `severity: 'info'`
 *
 * Note: the bundled entry is always retained in `inventory` for
 * visibility; it is only excluded from `resolvedConfigs` when a
 * replacement plugin entry is present.
 */
export function findBuiltinFallbackReplacement(
  bundledServerName: string,
  pluginInventoryIds: ReadonlySet<string>,
): string | undefined {
  for (const pair of BUILTIN_FALLBACK_REPLACEMENTS) {
    if (pair.bundledServerName !== bundledServerName) continue;
    for (const pid of pluginInventoryIds) {
      // pluginInventoryId has the form 'plugin:<pluginId>:<serverName>'.
      // We compare on the structured prefix to avoid string-prefix bugs.
      if (pid === `plugin:${pair.pluginId}:${pair.pluginServerName}`) return pid;
    }
  }
  return undefined;
}

/**
 * One tool the model can call. Carries the three identifiers Phase 2
 * needs to wire up registration and provider-call return routing.
 *
 *  - `internalKey`   : in-process ToolRegistry key, always unique
 *  - `providerName`  : the name sent to the model
 *  - `mcpInfo`       : routing metadata for dispatchMcpCall
 */
export interface MCPToolDescriptor {
  internalKey: string;
  providerName: string;
  mcpInfo: { serverName: string; toolName: string };
}

/**
 * The merged view presented to the UI. Combines static discovery
 * status with dynamic connection status.
 */
export interface MCPHealthReport {
  inventoryId: string;
  serverName: string;
  scopedServerName: string;
  source: MCPSource;
  sourceSubOrigin?: MCPSettingsSubOrigin;
  pluginId?: string;
  pluginName?: string;
  discovery: MCPDiscoveryStatus;
  connection: MCPConnectionStatus;
  lastError?: MCPIssue['error'];
  humanMessage?: string;
  suggestedAction?: string;
  severity: 'critical' | 'warning' | 'info';
  toolKeys: MCPToolDescriptor[];
  shadowedBy?: string;
  allowedAgentIds?: string[];
  lastUpdatedAt: number;
}
