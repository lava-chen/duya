// packages/agent/src/mcp/loader.ts
//
// The single wiring layer between the worker collector / resolution
// engine and `applyMCPConfiguration`. Exposes ONE helper —
// `loadAndResolveMCPServers()` — that the worker calls from both
// the initial load path and the `reload:mcp` command handler.
//
// This helper does NOT do:
//   * env expansion (engine does it)
//   * shadow / fallback resolution (engine does it)
//   * allowedAgentIds filtering (done here via filterResolvedMCPServersForAgent)
//   * MCP connection (apply.ts does it)
//   * ToolRegistry registration (apply.ts does it via setActiveMCPRuntime)
//
// The canonical `lastMCPLoadResult` snapshot lives in `apply.ts`
// and is written only when the apply state machine commits a swap.

import type {
  MCPCandidate,
  MCPIssue,
  MCPServerInventoryEntry,
  ResolvedMCPServerConfig,
} from '@duya/plugin-core';
import type { MCPServerConfig } from '../types.js';
import { collectWorkerMCPCandidates } from './collect-worker.js';
import { resolveMCPDiscovery } from '@duya/plugin-core';

// ============================================================================
// Public types
// ============================================================================

/**
 * The full result of a worker-side MCP load.
 */
export interface MCPLoadResult {
  /** Every collected candidate, in resolution order (post-shadow). */
  inventory: MCPServerInventoryEntry[];
  /** Connectable subset (non-shadowed, discoveryStatus === 'configured'). */
  resolvedConfigs: ResolvedMCPServerConfig[];
  /**
   * Legacy slice for the runtime. Each entry's `name` is the
   * scopedServerName (safe per audit — it is purely an internal
   * server key, NOT the model-visible tool name).
   */
  legacyConfigs: MCPServerConfig[];
  /** Collection + resolution issues, ALL phases. */
  issues: MCPIssue[];
}

// ============================================================================
// Helpers (exported for unit tests)
// ============================================================================

/**
 * Convert a single `ResolvedMCPServerConfig` to the legacy
 * `MCPServerConfig` shape. `config.name` is purely an internal
 * server key (Map key in MCPManager, log label, circuit-breaker
 * key); the model-visible tool name comes from `MCPClient.listTools()`.
 */
export function resolvedToLegacyConfig(r: ResolvedMCPServerConfig): MCPServerConfig {
  return {
    name: r.scopedServerName,
    command: r.rawConfig.command,
    args: r.rawConfig.args,
    env: r.rawConfig.env,
    allowedAgentIds: r.allowedAgentIds,
  };
}

/**
 * Narrow `NodeJS.ProcessEnv` (`string | undefined`) to
 * `Record<string, string>` so the resolution engine never sees
 * phantom undefined keys.
 */
export function filterDefinedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Apply connect-time `allowedAgentIds` filtering. Returns
 * `configs` unchanged if `agentProfileId` is undefined (no
 * enforcement). An entry whose `allowedAgentIds` is empty or
 * absent is treated as available to all profiles.
 */
export function filterResolvedMCPServersForAgent(
  configs: ReadonlyArray<ResolvedMCPServerConfig>,
  agentProfileId: string | undefined,
): ResolvedMCPServerConfig[] {
  if (!agentProfileId) return configs.slice();
  return configs.filter((c) => {
    if (!c.allowedAgentIds || c.allowedAgentIds.length === 0) return true;
    return c.allowedAgentIds.includes(agentProfileId);
  });
}

// ============================================================================
// Public entry
// ============================================================================

/**
 * The single wiring helper. Calls the worker collector, runs the
 * resolution engine, and produces the `MCPLoadResult` consumed by
 * `applyMCPConfiguration`.
 *
 * Pure computation — does NOT write any module-scope cache. The
 * snapshot commit is the responsibility of `applyMCPConfiguration`
 * (PHASE C), which only writes when the runtime swap succeeds.
 */
export async function loadAndResolveMCPServers(opts: {
  agentProfileId?: string;
} = {}): Promise<MCPLoadResult> {
  const collection = await collectWorkerMCPCandidates();

  const resolution = await resolveMCPDiscovery(collection.candidates, {
    environment: filterDefinedEnv(process.env),
    userConfigByPlugin: {},
  });

  const filtered = filterResolvedMCPServersForAgent(
    resolution.resolvedConfigs,
    opts.agentProfileId,
  );

  const legacyConfigs = filtered.map(resolvedToLegacyConfig);

  return {
    inventory: resolution.inventory,
    resolvedConfigs: filtered,
    legacyConfigs,
    issues: [...collection.issues, ...resolution.issues],
  };
}
