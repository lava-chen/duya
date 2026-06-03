// packages/agent/src/mcp/loader.ts
// Phase 1C: the single wiring layer between the new collectors /
// resolution engine and the existing `agent.initMCPServers` API.
//
// This module exposes ONE helper — `loadAndResolveMCPServers()` —
// that the worker calls from BOTH the first `init` path and the
// `reload:mcp` command handler. (Phase 1C only wires the first
// `init` path; the reload path is gated on lifecycle cleanup that
// the current `ToolRegistry` cannot provide, and is deferred.)
//
// Audit notes (Phase 1C, Rev 3):
//
// - `config.name` in the legacy `MCPServerConfig` is purely an
//   internal server key (Map key in MCPManager, log/error label,
//   circuit-breaker key, trace id). It is NOT the model-visible
//   tool name (that comes from `MCPClient.listTools()`). It is also
//   NOT the dispatch key (that comes from `ToolRegistry` registration).
//   Writing `name: r.scopedServerName` is therefore safe per the
//   audit in plan 97 Rev 3 §0.3.
//
// - This helper does NOT do:
//     * env expansion (engine does it)
//     * shadow / fallback resolution (engine does it)
//     * allowedAgentIds filtering (Phase 1D; the loader currently
//       passes the filter unchecked to the legacy slice, matching
//       the previous behavior; engine in Phase 1A does NOT filter
//       on this — see plan 97 Rev 2 §C for the deferred follow-up)
//     * MCP connection
//     * ToolRegistry registration (legacy `registerMCPTools` does that)
//
// - `userConfigByPlugin: {}` is the correct value for this round:
//   duya has NO real `${user_config.X}` storage yet. When the
//   storage layer is added (Phase 2+), this loader must be updated
//   to read user_config via the worker IPC client.

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
 * The full result of a worker-side MCP load. Phase 1D (main cache)
 * and the renderer UI need the complete inventory + shadow map +
 * resolved metadata + issues. The legacy `legacyConfigs` field is
 * the thin slice that today's `agent.initMCPServers()` can still
 * consume. After Phase 2 the legacy slice is replaced by the typed
 * `ResolvedMCPServerConfig[]` path.
 */
export interface MCPLoadResult {
  /** Every collected candidate, in resolution order (post-shadow). */
  inventory: MCPServerInventoryEntry[];
  /** Connectable subset (non-shadowed, discoveryStatus === 'configured'). */
  resolvedConfigs: ResolvedMCPServerConfig[];
  /**
   * Legacy slice for `agent.initMCPServers()`. Each entry's `name`
   * is the scopedServerName (audit confirms this is safe; see file
   * header). This field is the ONLY one passed to the existing
   * runtime. Phase 1C does not switch the runtime to a typed path.
   */
  legacyConfigs: MCPServerConfig[];
  /** Collection + resolution issues, ALL phases. */
  issues: MCPIssue[];
}

// ============================================================================
// Module-scope cache
// ============================================================================
//
// Phase 2A worker closure: the canonical `lastMCPLoadResult`
// lives in `apply.ts` and is written only when the apply state
// machine successfully commits a swap. The two functions below
// re-export apply's snapshot accessors so existing test imports
// `from './loader.js'` keep working without a code change at
// the call site.

export {
  getLastMCPLoadResult,
  clearLastMCPLoadResult,
} from './apply.js';

/**
 * Module-scope snapshot of the last successful (or attempted) MCP
 * load. Phase 1D will read this to populate the main cache; the
 * renderer UI may eventually read it via a new worker event.
 *
 * We cache the FULL MCPLoadResult, not just the issues array, so
 * that shadow relations, source metadata, and the complete
 * inventory survive the wiring step. The legacy slice is also
 * retained so future audits can compare what the runtime received
 * vs. what the engine produced.
 *
 * Phase 1C scope: module-scope, worker-internal only. No IPC
 * exposure. Cleared on agent destroy (the existing
 * `agent.destroy?.()` path in agent-process-entry.ts is the
 * natural hook — wired in `clearLastMCPLoadResult`).
 */
// The actual snapshot lives in apply.ts (see top of file).
// The legacy implementations below are kept as dead code paths
// in case a future refactor needs the loader's local cache
// restored; they are not exported.

let lastMCPLoadResult: MCPLoadResult | null = null;

function _legacyGet(): MCPLoadResult | null {
  return lastMCPLoadResult;
}

function _legacyClear(): void {
  lastMCPLoadResult = null;
}

// ============================================================================
// Helpers (exported for unit tests; not part of the public worker API)
// ============================================================================

/**
 * Convert a single `ResolvedMCPServerConfig` to the legacy
 * `MCPServerConfig` shape that the current `agent.initMCPServers`
 * API expects. The audit in plan 97 Rev 3 §0.3 confirms that
 * `config.name` is purely an internal server key; the model-visible
 * tool name comes from `MCPClient.listTools()` and the dispatch
 * payload comes from `ToolRegistry` registration. Writing
 * `scopedServerName` here therefore makes the runtime `Map<name,
 * MCPClient>` dedup survive plugin-source collisions.
 *
 * EXPORTED for unit tests. The wiring layer is the public API;
 * this helper is internal.
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
 * `process.env` in Node is `NodeJS.ProcessEnv` with value type
 * `string | undefined`; the engine's `ResolutionContext.environment`
 * is `Record<string, string>`. This filter narrows the type and
 * drops undefined entries so the engine never sees a phantom key.
 *
 * EXPORTED for unit tests.
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
 * the agent-process-entry call sites.
 *
 * Phase 2A worker closure: this function is now a pure
 * computation. It does NOT write `lastMCPLoadResult`; that
 * commit step is the responsibility of `applyMCPConfiguration`
 * (PHASE C), which only writes the snapshot when the runtime
 * swap has actually succeeded. See packages/agent/src/mcp/apply.ts.
 */
export interface LoadAndResolveOpts {
  agentProfileId?: string;
}

export async function loadAndResolveMCPServers(
  opts: LoadAndResolveOpts = {},
): Promise<MCPLoadResult> {
  const collection = await collectWorkerMCPCandidates();

  // `userConfigByPlugin: {}` is the documented placeholder. duya
  // has NO real `${user_config.X}` storage yet.
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
