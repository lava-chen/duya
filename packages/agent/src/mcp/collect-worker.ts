// packages/agent/src/mcp/collect-worker.ts
// Worker-side MCP candidate-collection adapter.
//
// STRICTLY a data-source adapter: it fetches from the worker's own
// stores (plugin registry via `pluginDb`, the user mcp.toml) and feeds
// the environment-agnostic engine in @duya/plugin-core
// (`buildMCPCandidates`). All pure transforms (bundled resolver,
// per-source candidate builders, legacy settings.json reader, final
// assembly) live in `packages/plugin-core/src/mcp/collect.ts`.
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
// module. The wiring layer in agent-process-entry.ts calls this
// collector and feeds its output to `resolveMCPDiscovery()`.

import { pluginDb } from '../ipc/db-client.js';
import { readUserMcpToml } from './config.js';
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
// Public entry: fetch via IPC and call the pure engine
// ============================================================================

/**
 * The full worker-side candidate collector. Fetches from `pluginDb`
 * and the user mcp.toml via the agent-process IPC channel; delegates
 * all per-source transforms and the final assembly to
 * `buildMCPCandidates` in @duya/plugin-core.
 */
export async function collectWorkerMCPCandidates(): Promise<MCPCollectionResult> {
  const issues: MCPIssue[] = [];

  const input: MCPCollectorInput = {
    installedPlugins: [],
    userTomlItems: [],
  };

  try {
    const raw = await pluginDb.registryList();
    if (Array.isArray(raw)) {
      input.installedPlugins = raw as unknown as MCPCollectorPluginEntry[];
    }
  } catch (err) {
    console.warn('[collectWorkerMCPCandidates] pluginDb.registryList failed:', err);
  }

  try {
    input.userTomlItems = (await readUserMcpToml()) as MCPCollectorSettingsItem[];
  } catch (err) {
    issues.push(errorToIssue(err, 'mcp.toml is invalid'));
  }

  const built = buildMCPCandidates(input);
  return { candidates: built.candidates, issues: [...issues, ...built.issues] };
}

// ============================================================================
// Plugin setup values — feeds `${setup.X}` expansion in MCP manifests
// ============================================================================

/**
 * Fetch all plugin setup values via IPC, shaped as the
 * `userConfigByPlugin` map the resolution engine expects.
 *
 * Returns `{ [pluginId]: { [setupKey]: value } }`. On any error (IPC
 * failure, table missing, etc.) returns an empty object — the
 * resolution engine will then report `${setup.X}` references as
 * `missingKeys` issues, which is the correct degradation.
 *
 * This is the single bridge between the setup-storage layer (owned by
 * the main process / another work stream) and the MCP resolution
 * engine. It MUST stay here in the worker collector so the pure
 * resolution engine in @duya/plugin-core never reads the DB.
 */
export async function fetchPluginSetupValuesForMcp(): Promise<
  Record<string, Record<string, string>>
> {
  try {
    const raw = await pluginDb.setupListAll();
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, Record<string, string>>;
    }
    return {};
  } catch (err) {
    console.warn('[fetchPluginSetupValuesForMcp] pluginDb.setupListAll failed:', err);
    return {};
  }
}