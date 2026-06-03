// packages/agent/src/mcp/apply.ts
// Phase 2A worker closure: the single MCP apply state machine.
//
// `applyMCPConfiguration` is the ONLY entry point that mutates
// the active MCP runtime. The first `init` path and the `reload:mcp`
// command handler both call it. The state machine is fixed to:
//
//   PHASE A: compute next typed state (no active side effect)
//   PHASE B1: prepare next runtime + tool registration plan
//             (next MCPManager / next alias map; old runtime
//             unchanged)
//   PHASE B2: atomic swap (registry replaceByOwner + active
//             manager/alias map switch; old manager disconnected
//             in the background)
//   PHASE C: commit active snapshot (lastMCPLoadResult, active
//             runtime snapshot)
//
// Failure semantics:
//   PHASE A throw: old runtime + snapshot unchanged.
//   PHASE B1 per-server connect failure: not fatal, recorded as
//     `MCPIssue { phase: 'connection' }`, snapshot still commits.
//   PHASE B1 internal throw: old runtime + snapshot unchanged.
//   PHASE B2 throw: registry is in replaceByOwner's atomic state
//     (built-in rollback), snapshot NOT committed.
//   PHASE C is a pure assignment; never throws.
//
// Concurrency: every call funnels through a single promise tail
// (mutex). Concurrent callers all await; last input wins, and
// state converges to the last committed snapshot.

import { logger } from '../utils/logger.js';
import { evaluateMcpToolPermission, type McpToolSource } from './permission-gate.js';
import type { PermissionMode } from '../permissions/types.js';
import { computeProviderName, AnthropicToolNamePolicy } from '@duya/plugin-core';
import type {
  MCPCandidate,
  MCPIssue,
  MCPServerInventoryEntry,
  ResolvedMCPServerConfig,
} from '@duya/plugin-core';
import type { MCPServerConfig, Tool } from '../types.js';
import type { ToolExecutor } from '../tool/registry.js';
import { MCPManager } from './index.js';
import { ToolRegistry, MCPRegistryReplaceError } from '../tool/registry.js';
import {
  loadAndResolveMCPServers,
  type MCPLoadResult,
} from './loader.js';

// ============================================================================
// Public types
// ============================================================================

export type ApplyReason =
  | 'initialization'
  | 'settings:change'
  | 'duya_config:action'
  | 'plugin:install'
  | 'plugin:enable'
  | 'plugin:disable'
  | 'manual';

export interface ApplyOpts {
  agent: DuyaAgentLike;
  reason: ApplyReason;
  agentProfileId?: string;
}

export interface MCPApplyResult {
  loadResult: MCPLoadResult;
  action: {
    toolsRemoved: number;
    toolsAdded: number;
    clientsConnected: number;
    connectionIssues: MCPIssue[];
    registrationIssues: MCPIssue[];
  };
  reason: ApplyReason;
  committedAt: number;
}

// Minimal interface we depend on from DuyaAgent. This avoids a
// circular import with packages/agent/src/index.ts.
interface DuyaAgentLike {
  activeMCPRuntimeSnapshot: ActiveMCPRuntimeSnapshot | null;
  activeMCPRegistry: ToolRegistry;
  /**
   * Get the model-visible tool names of all currently active
   * non-MCP tool providers (builtin + mode-specific non-MCP).
   * This is the INITIAL usedNames seed for providerName allocation.
   */
  getNonMCPModelVisibleToolNames(): Set<string>;
  /**
   * Atomic install of the new MCP runtime. The implementation
   * must:
   *   1) disconnect and discard the previously active manager
   *      (best-effort; in-flight calls may fail, that is
   *      acceptable and is the documented known limit);
   *   2) install the new manager;
   *   3) install the new providerNameToInternalKey map;
   *   4) install the new registeredMCPToolKeys set;
   *   5) stash toolEntries for registerMCPTools;
   *   6) call activeMCPRegistry.replaceByOwner('mcp', prepared)
   *      so the long-lived active MCP registry holds the
   *      new entries atomically;
   *   7) record the active snapshot.
   * This is a single call so the active runtime transitions
   * atomically from the caller's point of view.
   */
  setActiveMCPRuntime(install: {
    manager: MCPManager;
    providerNameToInternalKey: Map<string, string>;
    registeredMCPToolKeys: Set<string>;
    toolEntries: Map<string, { definition: Tool; executor: ToolExecutor }>;
    preparedRegistryEntries: Array<{
      key: string;
      definition: Tool;
      executor: ToolExecutor;
    }>;
    snapshot: ActiveMCPRuntimeSnapshot;
  }): Promise<{ removedKeys: string[]; addedKeys: string[]; keptKeys: string[] }>;
}

// ============================================================================
// Active runtime snapshot
// ============================================================================

export interface ActiveMCPRuntimeSnapshot {
  loadResult: MCPLoadResult;
  reason: ApplyReason;
  committedAt: number;
  /** Per-server connection failures, deduplicated from loadResult.issues. */
  connectionIssues: MCPIssue[];
  /** Per-tool registration collisions, deduplicated from loadResult.issues. */
  registrationIssues: MCPIssue[];
  /** Actually active server scopedServerNames. */
  activeServerKeys: string[];
  /** Actually active tool internalKeys. */
  activeToolKeys: string[];
}

// ============================================================================
// Module-scope cache (preserved across calls; only PHASE C writes)
// ============================================================================

let lastMCPLoadResult: MCPLoadResult | null = null;

export function getLastMCPLoadResult(): MCPLoadResult | null {
  return lastMCPLoadResult;
}

export function clearLastMCPLoadResult(): void {
  lastMCPLoadResult = null;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Pure filter: keep only `connection`-phase issues from a load
 * result. These are emitted by PHASE B1 when an `addServer` call
 * throws; they are not failures of the apply itself.
 */
function pickConnectionIssues(loadResult: MCPLoadResult): MCPIssue[] {
  return loadResult.issues.filter(
    (i) => i.phase === 'connection',
  );
}

/**
 * Pure filter: keep only `registration`-phase issues from a load
 * result (e.g. within-server tool name duplicates or
 * providerName collisions).
 */
function pickRegistrationIssues(loadResult: MCPLoadResult): MCPIssue[] {
  return loadResult.issues.filter(
    (i) => i.phase === 'registration',
  );
}

/**
 * Build a providerName allocator. Initial usedNames contains
 * non-MCP model-visible names; subsequent allocations add the
 * just-allocated name so two servers exposing the same original
 * tool name receive distinct providerNames via the `__2` /
 * `__3` suffixing that computeProviderName implements.
 */
function buildProviderNameAllocator(
  initialUsedNames: ReadonlySet<string>,
): (internalKey: string) => string {
  const used = new Set<string>(initialUsedNames);
  return (internalKey: string): string => {
    const name = computeProviderName(
      internalKey,
      used,
      AnthropicToolNamePolicy,
    );
    used.add(name);
    return name;
  };
}

/**
 * Type guard: a tool was registered via the new MCP path and
 * therefore carries the four identity fields. Non-MCP tools
 * (builtin / mode-specific) never set these.
 */
function isMCPIdentifiedTool(t: Tool): t is Tool & {
  internalKey: string;
  providerName: string;
  mcpInfo: { serverName: string; toolName: string };
} {
  return typeof t.internalKey === 'string'
    && typeof t.providerName === 'string'
    && t.mcpInfo !== undefined;
}

// ============================================================================
// Mutex (promise tail)
// ============================================================================

let applyTail: Promise<unknown> = Promise.resolve();

function enqueueApply<T>(fn: () => Promise<T>): Promise<T> {
  // Chain on the previous tail. If the previous run rejected, the
  // new run still proceeds (the catch below ensures the tail never
  // poisons the queue).
  const next = applyTail.then(fn, fn);
  applyTail = next.catch(() => undefined);
  return next;
}

// ============================================================================
// applyMCPConfiguration
// ============================================================================

/**
 * The single apply entry point. See file header for state-machine
 * details. Returns the post-commit `MCPApplyResult`.
 */
export function applyMCPConfiguration(opts: ApplyOpts): Promise<MCPApplyResult> {
  return enqueueApply(() => runApply(opts));
}

async function runApply(opts: ApplyOpts): Promise<MCPApplyResult> {
  const committedAt = Date.now();
  const { agent, reason, agentProfileId } = opts;

  // -------- PHASE A: compute next typed state --------
  let next: MCPLoadResult;
  try {
    next = await loadAndResolveMCPServers({ agentProfileId });
  } catch (err) {
    // PHASE A failure: keep old runtime, keep old snapshot.
    logger.error(
      `[MCP] PHASE A failed; keeping old runtime. Error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw new MCPLoadError(
      'typed MCP load failed; old runtime and snapshot are preserved',
      err,
    );
  }

  // -------- PHASE B1: prepare next runtime --------
  // The candidate usedNames seed comes from the agent's non-MCP
  // tool providers (builtin + mode-specific non-MCP). It MUST
  // NOT contain the currently active MCP provider names, since
  // full-replace removes them and including them would cause
  // drift to `__2` on every repeated reload.
  const initialUsedNames = agent.getNonMCPModelVisibleToolNames();
  const allocateProviderName = buildProviderNameAllocator(initialUsedNames);

  const nextManager = new MCPManager();
  for (const resolved of next.resolvedConfigs) {
    const cfg: MCPServerConfig = {
      name: resolved.scopedServerName,
      command: resolved.rawConfig.command,
      args: resolved.rawConfig.args,
      env: resolved.rawConfig.env,
      allowedAgentIds: resolved.allowedAgentIds,
      // Stamp the source bucket for the runtime permission gate.
      // The engine resolves every `ResolvedMCPServerConfig.source`
      // to one of the three MCPSource literals; we only need to
      // exclude the gate's 'local' (manually-installed-from-path,
      // not emitted by the current engine) and fall back to
      // 'unknown' for any unexpected value.
      source: resolved.source === 'bundled' || resolved.source === 'plugin' || resolved.source === 'settings'
        ? resolved.source
        : 'unknown',
    };
    try {
      await nextManager.addServer(cfg);
    } catch (err) {
      // Per-server failure: record issue, continue. The full
      // loadResult.issues list was already populated by the
      // collector and engine; we just need to surface this
      // runtime connect failure too. The engine is the
      // authoritative place for discovery issues; connection
      // issues are appended here for the active snapshot.
      const issue: MCPIssue = {
        phase: 'connection',
        source: {
          source: 'bundled',
          sourceSubOrigin: undefined,
          pluginId: undefined,
          pluginName: undefined,
        },
        inventoryId: undefined,
        serverName: cfg.name,
        error: {
          type: 'mcp-spawn-failed',
          serverName: cfg.name,
          reason: err instanceof Error ? err.message : String(err),
        },
        humanMessage:
          `Failed to connect to MCP server "${cfg.name}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        severity: 'warning',
        suggestedAction: 'Verify the server configuration and try again.',
      };
      next.issues.push(issue);
    }
  }

  // Pull the tool list from successfully-connected clients, sort
  // stably, then build the planned registry entries and the
  // provider alias map. The closure captures the nextManager
  // reference (not the future agent.mcpManager dereference) so
  // an in-flight old call after the swap deterministically
  // errors at the old client boundary.
  const plannedTools = nextManager.getAllToolsWithIdentity(allocateProviderName);
  const preparedEntries: Array<{
    key: string;
    definition: Tool;
    executor: ToolExecutor;
  }> = [];
  const providerNameToInternalKey = new Map<string, string>();
  const activeServerKeys: string[] = [];
  for (const t of plannedTools) {
    if (!isMCPIdentifiedTool(t)) {
      // Should be impossible — getAllToolsWithIdentity always
      // populates the three fields. Be defensive: skip + log.
      logger.warn('[MCP] prepared tool missing identity fields, skipping');
      continue;
    }
    const scopedClient = nextManager.getClient(t.mcpInfo.serverName);
    if (!scopedClient) {
      // Client went away between the addServer call above and
      // now; record an issue and skip this tool.
      next.issues.push({
        phase: 'connection',
        source: { source: 'bundled' },
        serverName: t.mcpInfo.serverName,
        error: {
          type: 'mcp-spawn-failed',
          serverName: t.mcpInfo.serverName,
          reason: 'client disconnected before registration',
        },
        humanMessage: `MCP client "${t.mcpInfo.serverName}" disconnected before tool registration`,
        severity: 'warning',
      });
      continue;
    }
    const capturedClient = scopedClient;
    const capturedMcpInfo = t.mcpInfo;
    const executor: ToolExecutor = {
      execute: async (input: Record<string, unknown>) => {
        // BLOCKER B (audit 2026-06-03): runtime permission gate.
        // Pure predicate, runs BEFORE the underlying client call so
        // third-party MCP tools can never execute silently.
        const source: McpToolSource = (capturedMcpInfo.source
          ?? 'unknown') as McpToolSource;
        // `activePermissionMode` is provided by the host (the long-lived
        // Agent instance) when available. When it is absent (e.g. unit
        // tests, or callers that have not yet wired the property) we
        // fall through with `undefined`, which causes the gate to treat
        // every third-party tool as needing user approval — the safest
        // default for v0.1.3.
        const activeMode = (agent as unknown as { activePermissionMode?: PermissionMode }).activePermissionMode;
        const decision = evaluateMcpToolPermission(
          source,
          activeMode,
          capturedMcpInfo.toolName,
        );
        if (decision.kind === 'deny' || decision.kind === 'prompt') {
          logger.warn(
            '[MCP] tool call blocked by permission gate',
            { toolName: capturedMcpInfo.toolName, source, kind: decision.kind, reason: decision.reason },
          );
          return {
            id: capturedMcpInfo.toolName + '-gate',
            name: capturedMcpInfo.toolName,
            result: '[MCP permission gate] ' + decision.reason +
              '. Switch the session to bypassPermissions or dontAsk to allow this tool.',
            error: true,
            metadata: { source, gateKind: decision.kind },
          };
        }
        // Capture-bound dispatch. After PHASE B2 swaps the
        // active manager, the old executor's capturedClient is the
        // previous-generation client; calls against it fail
        // deterministically (closed circuit / disconnected)
        // instead of silently routing to the new runtime.
        return capturedClient.callTool(capturedMcpInfo.toolName, input);
      },
    };
    preparedEntries.push({
      key: t.internalKey,
      definition: t,
      executor,
    });
    providerNameToInternalKey.set(t.providerName, t.internalKey);
    if (!activeServerKeys.includes(t.mcpInfo.serverName)) {
      activeServerKeys.push(t.mcpInfo.serverName);
    }
  }

  // -------- PHASE B2: atomic swap --------
  // replaceByOwner is validate-then-commit; on any failure the
  // registry is byte-equivalent to its pre-call state. We call
  // it on the agent's long-lived activeMCPRegistry via
  // setActiveMCPRuntime (atomic install) so the swap is a
  // single observable operation. If the install itself throws,
  // the agent's setActiveMCPRuntime is responsible for restoring
  // state (we have not yet touched agent.mcpManager).
  let replaceResult: { removedKeys: string[]; addedKeys: string[]; keptKeys: string[] };
  const activeToolKeys = preparedEntries.map((e) => e.key);
  const connectionIssues = pickConnectionIssues(next);
  const registrationIssues = pickRegistrationIssues(next);
  const snapshot: ActiveMCPRuntimeSnapshot = {
    loadResult: next,
    reason,
    committedAt,
    connectionIssues,
    registrationIssues,
    activeServerKeys,
    activeToolKeys,
  };

  try {
    replaceResult = await agent.setActiveMCPRuntime({
      manager: nextManager,
      providerNameToInternalKey,
      registeredMCPToolKeys: new Set(activeToolKeys),
      toolEntries: new Map(
        preparedEntries.map((e) => [e.key, { definition: e.definition, executor: e.executor }]),
      ),
      preparedRegistryEntries: preparedEntries,
      snapshot,
    });
  } catch (err) {
    // Install failed. Tear down the prepared nextManager
    // (best effort) and rethrow. Old runtime and snapshot are
    // unchanged.
    try { await nextManager.disconnectAll(); } catch { /* ignore */ }
    logger.error(
      `[MCP] PHASE B2 setActiveMCPRuntime failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw new MCPApplyError(
      'PHASE B2 atomic swap failed; old runtime and snapshot are preserved',
      err,
    );
  }

  // -------- PHASE C: commit snapshot (only assignment) --------
  lastMCPLoadResult = next;

  return {
    loadResult: next,
    action: {
      toolsRemoved: replaceResult.removedKeys.length,
      toolsAdded: replaceResult.addedKeys.length,
      clientsConnected: activeServerKeys.length,
      connectionIssues,
      registrationIssues,
    },
    reason,
    committedAt,
  };
}

// ============================================================================
// Errors
// ============================================================================

export class MCPLoadError extends Error {
  constructor(message: string, public readonly cause: unknown) {
    super(message);
    this.name = 'MCPLoadError';
  }
}

export class MCPApplyError extends Error {
  constructor(message: string, public readonly cause: unknown) {
    super(message);
    this.name = 'MCPApplyError';
  }
}

// Re-export for convenience
export { MCPRegistryReplaceError };
