// electron/agents/mcp/collect-main.ts
// Main-process MCP candidate-collection adapter.
//
// Produces `MCPCollectionResult { candidates, issues }` from the
// main-process data sources (plugin registry, user mcp.toml) and feeds
// them through the environment-agnostic engine in @duya/plugin-core
// (`buildMCPCandidates`). STRICTLY a collector wrapper — no env
// expansion, no shadow / fallback resolution, no allowedAgentIds
// filtering, no connection, no state caching.
//
// The worker adapter is `packages/agent/src/mcp/collect-worker.ts`.
// Both adapters produce results that satisfy the same
// `MCPCollectionResult` contract. The wiring layer (Phase 1D) calls
// this collector from the main process and feeds its output to
// `resolveMCPDiscovery()`.
//
// SCOPE NOTE — the main process only owns the READ of the plugin
// registry and the user-managed mcp.toml. The deprecated settings
// stores (agentSettings / settingsKv / legacy settings.json) are NOT
// re-imported here; the unified engine declares them on
// `MCPCollectorInput` for source-completeness, but which adapter
// actually populates them is that adapter's decision.
//
// The pure transforms (bundled resolver, per-source candidate builders,
// legacy settings.json reader, assembly) all live in
// @duya/plugin-core/src/mcp/collect.ts. This module only fetches data.

import { getLogger } from '../../logging/logger.js';
import { getPluginManager } from '../../plugins/PluginManager.js';
import { readPluginManifest } from '../../plugins/manifest.js';
import { readUserMcpToml } from '../../services/mcp-toml-config.js';
import {
  buildMCPCandidates,
  type MCPCollectorInput,
  type MCPCollectorPluginEntry,
  type MCPCollectorSettingsItem,
} from '@duya/plugin-core/src/mcp/collect.js';
import {
  getMCPErrorMessage,
  getMCPErrorSeverity,
  getMCPSuggestedAction,
  type MCPCollectionResult,
  type MCPIssue,
  type MCPSourceContext,
} from '@duya/plugin-core';

// ============================================================================
// Issue factory for source-read problems (Phase 1B contract)
// ============================================================================

function errorToIssue(err: unknown, reasonPrefix: string): MCPIssue {
  const error = {
    type: 'mcp-settings-invalid' as const,
    source: { source: 'settings', sourceSubOrigin: 'tomlFile' } as MCPSourceContext,
    reason: `${reasonPrefix}: ${err instanceof Error ? err.message : String(err)}`,
  };
  return {
    phase: 'discovery',
    source: error.source,
    serverName: '<settings>',
    error,
    humanMessage: getMCPErrorMessage(error),
    severity: getMCPErrorSeverity(error),
    suggestedAction: getMCPSuggestedAction(error),
  };
}

// ============================================================================
// Public entry: fetch via main-process accessors, feed the pure engine
// ============================================================================

/**
 * The full main-process candidate collector. Fetches the plugin
 * registry and the user mcp.toml; delegates all per-source transforms
 * and the final assembly to `buildMCPCandidates` in @duya/plugin-core.
 * Returns a typed `MCPCollectionResult`.
 */
export async function collectMainMCPCandidates(): Promise<MCPCollectionResult> {
  const logger = getLogger();
  const issues: MCPIssue[] = [];

  const input: MCPCollectorInput = {
    installedPlugins: [],
    userTomlItems: [],
  };

  // 1. Plugin manager. The main-process plugin manager returns
  //    PluginViewItem[] which does NOT include the manifest; the
  //    manifest is read on demand from disk via readPluginManifest.
  try {
    const items = getPluginManager().listInstalled();
    input.installedPlugins = items.map((item): MCPCollectorPluginEntry => {
      const entry: MCPCollectorPluginEntry = {
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

  // 2. The only user-managed MCP source: the user mcp.toml.
  try {
    input.userTomlItems = (await readUserMcpToml()) as MCPCollectorSettingsItem[];
  } catch (err) {
    issues.push(errorToIssue(err, 'mcp.toml is invalid'));
  }

  const built = buildMCPCandidates(input);
  return { candidates: built.candidates, issues: [...issues, ...built.issues] };
}