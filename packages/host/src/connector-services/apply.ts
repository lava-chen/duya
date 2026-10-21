// Host MCP connector apply state machine.
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

import { logger } from '../worker-logger.js';
import { computeProviderName, AnthropicToolNamePolicy } from '@duya/plugin-core';
import type {
  MCPIssue,
  MCPServerInventoryEntry,
  ResolvedMCPServerConfig,
} from '@duya/plugin-core';
import type { MCPServerConfig, MCPToolDefinition } from '@duya/capabilities/MCP/ports';
import type { ToolExecutor, ToolMetaInput, RuntimeToolResult } from '@duya/agent-runtime/tools/catalog';
import { readToolExposureConfig, mcpExposureToToolExposure } from '../worker-config/tool-exposure.js';
import { buildToolHint } from '@duya/capabilities/MCP/tool-hint';
import { MCPManager } from '@duya/capabilities/MCP/MCPManager';
import { MCPRegistryReplaceError } from '@duya/agent-runtime/tools/catalog';
import {
  loadAndResolveMCPServers,
  resolvedToLegacyConfig,
  type MCPLoadResult,
} from './loader.js';
import type { McpToolSource } from '@duya/agent-runtime/authorization/permissions/types';

// ============================================================================
// Public types
// ============================================================================

export type ApplyReason =
  | 'initialization'
  | 'settings:change'
  // Plan 102: `duya_config:action` retired. Config mutations
  // now flow through `duya_cli` and reach the apply pipeline via
  // `settings:change` (the agent-settings write) or via the
  // legacy configDb IPC bridge.
  | 'duya_cli:action'
  | 'plugin:install'
  | 'plugin:enable'
  | 'plugin:disable'
  // Plan 580 D2: a server sent `notifications/tools/list_changed` and
  // the client completed its transactional rediscovery; the registry
  // replace-set reuses the standard apply pipeline.
  | 'mcp:tools_changed'
  | 'manual';

export interface ApplyOpts<
  TManager extends MCPManager = MCPManager,
  TContext extends object = object,
> {
  runtime: MCPApplyRuntimePort<TManager, TContext>;
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

/** Minimal runtime projection needed by the Host-owned MCP apply service. */
export interface MCPApplyRuntimePort<
  TManager extends MCPManager,
  TContext extends object,
> {
  /** Construct the next manager using the active transport/logger adapter. */
  createManager(): TManager;
  /**
   * The currently active MCPManager, or `null` when no MCP runtime
   * has been installed yet. Used by the incremental-reconnect path
   * to reuse still-valid clients across reloads instead of
   * respawning every server process.
   */
  getActiveMCPManager(): TManager | null;
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
   *   4) call activeMCPRegistry.replaceByOwner('mcp', prepared)
   *      so the long-lived ToolCatalog holds the new MCP entries
   *      atomically (builtin entries are preserved);
   *   5) record the active snapshot.
   * This is a single call so the active runtime transitions
   * atomically from the caller's point of view.
   */
  /** Create a Runtime-guarded executor around a generation-captured invoke. */
  createMCPToolExecutor(options: {
    toolName: string;
    source: McpToolSource;
    invoke(input: Record<string, unknown>): Promise<RuntimeToolResult>;
  }): ToolExecutor<TContext, RuntimeToolResult>;
  setActiveMCPRuntime(install: {
    manager: TManager;
    providerNameToInternalKey: Map<string, string>;
    preparedRegistryEntries: Array<{
      key: string;
      definition: MCPToolDefinition;
      executor: ToolExecutor<TContext, RuntimeToolResult>;
      meta?: ToolMetaInput;
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
): (internalKey: string, nameOverride?: string) => string {
  const used = new Set<string>(initialUsedNames);
  return (internalKey: string, nameOverride?: string): string => {
    const name = computeProviderName(
      internalKey,
      used,
      AnthropicToolNamePolicy,
      nameOverride,
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
function isMCPIdentifiedTool(t: MCPToolDefinition): t is MCPToolDefinition & {
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
export function applyMCPConfiguration<
  TManager extends MCPManager,
  TContext extends object,
>(opts: ApplyOpts<TManager, TContext>): Promise<MCPApplyResult> {
  return enqueueApply(() => runApply(opts));
}

// Plan 580 D2: a client's transactional rediscovery completed; refresh
// the registry replace-set through the standard apply pipeline. The
// client side already debounces notifications (500ms coalesce); this
// extra schedule fires the reload through the apply mutex. Re-entrant
// safety: the reload adopts existing clients (config signature
// unchanged) without reconnecting, so it cannot loop.
let toolsChangedReloadTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleToolsChangedReload<
  TManager extends MCPManager,
  TContext extends object,
>(opts: ApplyOpts<TManager, TContext>): void {
  if (toolsChangedReloadTimer) clearTimeout(toolsChangedReloadTimer);
  toolsChangedReloadTimer = setTimeout(() => {
    toolsChangedReloadTimer = undefined;
    void applyMCPConfiguration({ ...opts, reason: 'mcp:tools_changed' }).catch((err) => {
      logger.warn(
        `[MCP] tools_changed reload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, 0);
}

async function runApply<
  TManager extends MCPManager,
  TContext extends object,
>(opts: ApplyOpts<TManager, TContext>): Promise<MCPApplyResult> {
  const committedAt = Date.now();
  const { runtime, reason, agentProfileId } = opts;

  // -------- PHASE A: compute next typed state --------
  let next: MCPLoadResult;
  try {
    next = await loadAndResolveMCPServers(
      agentProfileId === undefined ? {} : { agentProfileId },
    );
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
  const initialUsedNames = runtime.getNonMCPModelVisibleToolNames();
  const allocateProviderName = buildProviderNameAllocator(initialUsedNames);

  const nextManager = runtime.createManager();
  // Plan 580 D2: wire tools/list_changed → registry replace-set. The
  // client performs the transactional rediscovery (last-known inventory
  // kept on failure); this callback only re-runs the apply pipeline so
  // the long-lived registry mirrors the new inventory.
  nextManager.setOnToolsChanged((serverName) => {
    logger.info(`[MCP] tools changed on "${serverName}"; scheduling registry reload`);
    scheduleToolsChangedReload(opts);
  });
  // Build all server configs first (synchronous, no inter-config
  // dependencies), then connect in parallel. Each addServer call
  // spawns an independent child process + handshake + listTools
  // RPC, so parallelization cuts startup from N*~1-2s to ~1-2s.
  const nextConfigs: MCPServerConfig[] = next.resolvedConfigs.map(resolvedToLegacyConfig);

  // Incremental reconnect (hot-reload granularity): reuse the
  // previously active clients whose connect-relevant config is
  // unchanged, so a reload that only toggles a server, tweaks
  // timeouts, or renames a prefix does not respawn every process.
  // Extracting a client from the old manager removes it from that
  // manager's map, so the later `disconnectAll()` on the old
  // manager (in `setActiveMCPRuntime`) skips reused clients.
  const previousManager = runtime.getActiveMCPManager();
  type ExistingClient = ReturnType<TManager['getAllClients']>[number];
  const previousClientsByName = new Map<string, ExistingClient>(
    previousManager?.getAllClients().map((c) => [c.getName(), c]) ?? [],
  );
  const toConnect: MCPServerConfig[] = [];
  for (const cfg of nextConfigs) {
    const old = previousClientsByName.get(cfg.name);
    if (old && MCPManager.configSignature(old.getConfig()) === MCPManager.configSignature(cfg)) {
      // Transport unchanged — remove from the previous manager (so its
      // `disconnectAll()` skips it) and adopt into the next (no spawn).
      previousManager?.extract(cfg.name);
      nextManager.adopt(old, cfg);
    } else {
      toConnect.push(cfg);
    }
  }

  // Parallel connect only the servers that need (re)spawning.
  const settleResults = await Promise.allSettled(
    toConnect.map((cfg) => nextManager.addServer(cfg)),
  );

  // Walk results in config order so issue ordering matches the
  // serial implementation (deterministic for tests/snapshots).
  toConnect.forEach((cfg, i) => {
    const result = settleResults[i];
    if (result?.status === 'rejected') {
      const err = result.reason;
      // Per-server failure: record issue, continue. The full
      // loadResult.issues list was already populated by the
      // collector and engine; we just need to surface this
      // runtime connect failure too. The engine is the
      // authoritative place for discovery issues; connection
      // issues are appended here for the active snapshot.
      logger.warn(
        `[MCP] Server "${cfg.name}" failed to connect: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      const issue: MCPIssue = {
        phase: 'connection',
        source: { source: 'bundled' },
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
  });

  // Pull the tool list from successfully-connected clients, sort
  // stably, then build the planned registry entries and the
  // provider alias map. The closure captures the nextManager
  // reference (not the future agent.mcpManager dereference) so
  // an in-flight old call after the swap deterministically
  // errors at the old client boundary.
  const plannedTools = nextManager.getAllToolsWithIdentity(allocateProviderName);
  const preparedEntries: Array<{
    key: string;
    definition: MCPToolDefinition;
    executor: ToolExecutor<TContext, RuntimeToolResult>;
    meta: ToolMetaInput;
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
    const capturedMcpInfo = t.mcpInfo;
    const source = capturedMcpInfo.source ?? 'unknown';
    // Capture-bound dispatch. After PHASE B2 swaps the active manager,
    // calls retain this generation's client and cannot silently route to
    // a replacement connection. The injected Runtime factory owns the
    // mandatory source-provenance and approval guard.
    const executor = runtime.createMCPToolExecutor({
      toolName: capturedMcpInfo.toolName,
      source,
      invoke: (input) => scopedClient.callTool(capturedMcpInfo.toolName, input),
    });
    // Plan 480 P1.4: per-tool hint derived from the raw schema (argument-name
    // list with `(required)` markers, same shape as the built-in
    // `image_generate` hint). Catalog results use this truthful, one-line
    // summary. Extracted BEFORE any projection so a truncated schema still
    // yields its original argument list.
    const hint = buildToolHint(t) || 'No structured arguments';
    preparedEntries.push({
      key: t.internalKey,
      // Plan 580 D4: the registry entry holds the CANONICAL schema
      // verbatim (Ajv validation, catalog detail, and the schema
      // revision all consume it). The 8KB spec budget + type-root wrap
      // moved to the last-mile `projectForProvider` in
      // `DuyaAgent._resolveTools` — budget trimming never pollutes the
      // canonical form anymore.
      definition: t,
      executor,
      meta: {
        exposure: mcpExposureToToolExposure(readToolExposureConfig().exposure),
        catalogInputSchema: t.input_schema,
        catalogDescription: t.description,
        discovery: {
          namespace: t.mcpInfo.serverName,
          conciseHint: hint,
          tags: [t.mcpInfo.serverName, t.mcpInfo.toolName],
        },
        inputSchemaSummary: hint,
      },
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
    replaceResult = await runtime.setActiveMCPRuntime({
      manager: nextManager,
      providerNameToInternalKey,
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
