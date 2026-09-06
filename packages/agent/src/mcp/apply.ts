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
import { decideMcpSource } from '../permissions/permissions.js';
import type { PermissionMode, McpToolSource } from '../permissions/types.js';
import { computeProviderName, AnthropicToolNamePolicy } from '@duya/plugin-core';
import type {
  MCPCandidate,
  MCPIssue,
  MCPServerInventoryEntry,
  ResolvedMCPServerConfig,
} from '@duya/plugin-core';
import type { MCPServerConfig, Tool, ToolUseContext } from '../types.js';
import type { ToolExecutor, ToolMetaInput } from '../tool/registry.js';
import { readToolExposureConfig, mcpExposureToExposeMode } from '../config/tool-exposure.js';
import { downgradeToolSchemaForBudget } from '../tool/spec-budget.js';
import { buildToolHint } from './tool-hint.js';
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
  // Plan 102: `duya_config:action` retired. Config mutations
  // now flow through `duya_cli` and reach the apply pipeline via
  // `settings:change` (the agent-settings write) or via the
  // legacy configDb IPC bridge.
  | 'duya_cli:action'
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
   * Current permission mode of the host agent (default / auto / plan /
   * bypassPermissions / dontAsk / ...). Absent in unit-test fakes; the
   * gate then treats the mode as undefined (safest default).
   */
  getPermissionMode?(): PermissionMode;
  /**
   * The currently active MCPManager, or `null` when no MCP runtime
   * has been installed yet. Used by the incremental-reconnect path
   * to reuse still-valid clients across reloads instead of
   * respawning every server process.
   */
  getActiveMCPManager(): MCPManager | null;
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
  setActiveMCPRuntime(install: {
    manager: MCPManager;
    providerNameToInternalKey: Map<string, string>;
    preparedRegistryEntries: Array<{
      key: string;
      definition: Tool;
      executor: ToolExecutor;
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
  // Build all server configs first (synchronous, no inter-config
  // dependencies), then connect in parallel. Each addServer call
  // spawns an independent child process + handshake + listTools
  // RPC, so parallelization cuts startup from N*~1-2s to ~1-2s.
  const nextConfigs: MCPServerConfig[] = next.resolvedConfigs.map((resolved) => ({
    name: resolved.scopedServerName,
    transport: resolved.rawConfig.transport,
    command: resolved.rawConfig.command,
    args: resolved.rawConfig.args,
    env: resolved.rawConfig.env,
    url: resolved.rawConfig.url,
    headers: resolved.rawConfig.headers,
    allowedAgentIds: resolved.allowedAgentIds,
    nameOverride: resolved.rawConfig.nameOverride,
    startupTimeoutSec: resolved.rawConfig.startupTimeoutSec,
    toolTimeoutSec: resolved.rawConfig.toolTimeoutSec,
    toolTimeouts: resolved.rawConfig.toolTimeouts,
    // Stamp the source bucket for the runtime permission gate.
    // The engine resolves every `ResolvedMCPServerConfig.source`
    // to one of the three MCPSource literals; we only need to
    // exclude the gate's 'local' (manually-installed-from-path,
    // not emitted by the current engine) and fall back to
    // 'unknown' for any unexpected value.
    source: resolved.source === 'bundled' || resolved.source === 'plugin' || resolved.source === 'settings'
      ? resolved.source
      : 'unknown',
  }));

  // Incremental reconnect (hot-reload granularity): reuse the
  // previously active clients whose connect-relevant config is
  // unchanged, so a reload that only toggles a server, tweaks
  // timeouts, or renames a prefix does not respawn every process.
  // Extracting a client from the old manager removes it from that
  // manager's map, so the later `disconnectAll()` on the old
  // manager (in `setActiveMCPRuntime`) skips reused clients.
  const previousManager = agent.getActiveMCPManager();
  type ExistingClient = ReturnType<MCPManager['getAllClients']>[number];
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
    if (result.status === 'rejected') {
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
    definition: Tool;
    executor: ToolExecutor;
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
    const capturedClient = scopedClient;
    const capturedMcpInfo = t.mcpInfo;
    const gateErrorResult = (
      kind: 'deny' | 'ask',
      message: string,
    ) => ({
      id: capturedMcpInfo.toolName + '-gate',
      name: capturedMcpInfo.toolName,
      result: message,
      error: true,
      metadata: {
        source: (capturedMcpInfo.source ?? 'unknown') as McpToolSource,
        gateKind: kind,
      },
    });
    const executor: ToolExecutor = {
      execute: async (
        input: Record<string, unknown>,
        _workingDirectory?: string,
        context?: ToolUseContext,
      ) => {
        // BLOCKER B (audit 2026-06-03): runtime permission gate. The MCP
        // decision is the SAME gate built-in tools use (`decideMcpSource` is
        // the provenance step of `hasPermissionsToUseTool`), so third-party
        // MCP tools can never execute silently.
        const source: McpToolSource = (capturedMcpInfo.source
          ?? 'unknown') as McpToolSource;
        // Read the host agent's ACTUAL permission mode. (The old lookup
        // `agent.activePermissionMode` never existed on DuyaAgent, so the
        // gate always saw `undefined` and even bypassPermissions / dontAsk
        // sessions were blocked.) Falls back to `undefined` in unit-test
        // fakes, which the gate treats as "always needs approval" — the
        // safest default.
        const activeMode = agent.getPermissionMode ? agent.getPermissionMode() : undefined;
        const decision = decideMcpSource(source, activeMode, capturedMcpInfo.toolName);
        if (decision.behavior === 'deny') {
          logger.warn(
            '[MCP] tool call denied by permission gate',
            { toolName: capturedMcpInfo.toolName, source, reason: decision.message },
          );
          return gateErrorResult('deny', '[MCP permission gate] ' + decision.message);
        }
        if (decision.behavior === 'ask') {
          logger.warn(
            '[MCP] tool call requires user approval',
            { toolName: capturedMcpInfo.toolName, source, reason: decision.message },
          );
          // Skip the gate when this tool use was already approved: either
          // StreamingToolExecutor's pre-check marked `_approvedToolUses`
          // in appState, or we recorded it below on a prior entry with
          // the same toolUseId (e.g. executor re-entry after approval).
          // `_approvedToolUses` in appState is the SINGLE approval channel
          // (plan 419 P0: DuyaAgent streams a real, mutable AppState with
          // working getAppState/setAppState, so hosts always persist it).
          const toolUseId = context?.toolUseId;
          const appState = context?.getAppState ? context.getAppState() : undefined;
          const appApproved = toolUseId
            ? ((appState?._approvedToolUses as Record<string, boolean> | undefined) ?? {})[toolUseId]
            : undefined;
          if (!appApproved) {
            // No approval channel (headless CLI / sub-agent / background
            // gateway session): there is no interactive user to answer a
            // permission prompt, so asking would dead-lock the turn. These
            // contexts are trusted app-internal/automation surfaces, so we
            // allow the call through (the source-level trust model above
            // still gates market-installed / manual-path third-party tools
            // in interactive sessions). Log the implicit approval loudly.
            if (!context?.requestPermission) {
              logger.warn(
                '[MCP] no interactive user available; implicitly allowing tool',
                { toolName: capturedMcpInfo.toolName, source, mode: activeMode },
              );
              return capturedClient.callTool(capturedMcpInfo.toolName, input);
            }
            // Ask the user through the standard permission_request flow
            // (chat:permission event -> renderer Allow/Deny prompt). This
            // runs INSIDE the executor on purpose: the pre-check path in
            // StreamingToolExecutor records the outcome in appState, but
            // the executor cannot observe that write from its own entry
            // point, so prompting here keeps allow/deny + execution in a
            // single synchronous flow with no retry loop.
            const userDecision = await context.requestPermission({
              id: toolUseId ?? crypto.randomUUID(),
              toolName: capturedMcpInfo.toolName,
              toolInput: input,
              mode: 'generic',
              expiresAt: Date.now() + 5 * 60 * 1000,
              decisionReason: decision.message,
            });
            if (userDecision === 'deny') {
              logger.warn(
                '[MCP] tool call denied by user',
                { toolName: capturedMcpInfo.toolName, source },
              );
              return gateErrorResult('ask', '[MCP permission gate] Permission denied by user');
            }
            // Plan 498: 'paused' means the request was persisted as a durable
            // approval card and the turn must NOT fall through to execution.
            // Surface the neutral waiting text as the tool result; a later
            // continuation run replays the approved call via the one-shot
            // approval ledger.
            if (userDecision === 'paused') {
              logger.info(
                '[MCP] tool call paused for durable approval card',
                { toolName: capturedMcpInfo.toolName, source },
              );
              return gateErrorResult(
                'ask',
                'Waiting for user approval. The request has been sent as an approval card; ' +
                  'end your turn without further tool calls.',
              );
            }
            // Plan 419 P0: record the approval on the SAME channel
            // StreamingToolExecutor uses (`_approvedToolUses` in appState),
            // so a re-entry with this toolUseId skips the gate. appState is
            // reliable on real hosts now, so it is the only approval channel.
            if (toolUseId) {
              context?.setAppState?.((prev) => ({
                ...prev,
                _approvedToolUses: {
                  ...((prev._approvedToolUses as Record<string, boolean> | undefined) ?? {}),
                  [toolUseId]: true,
                },
              }));
            }
          }
        }
        // Capture-bound dispatch. After PHASE B2 swaps the
        // active manager, the old executor's capturedClient is the
        // previous-generation client; calls against it fail
        // deterministically (closed circuit / disconnected)
        // instead of silently routing to the new runtime.
        return capturedClient.callTool(capturedMcpInfo.toolName, input);
      },
    };
    // Plan 480 P1.4: per-tool hint derived from the raw schema (argument-name
    // list with `(required)` markers, same shape as the built-in
    // `image_generate` hint). This replaces the previous placeholder text so
    // `tool_search` results and (later) `tool_schema` entries carry a
    // truthful, one-line summary. Extracted BEFORE the spec budget downgrade
    // so a truncated schema still yields its original argument list.
    const hint = buildToolHint(t) || 'No structured arguments';
    preparedEntries.push({
      key: t.internalKey,
      // Plan 452 Phase A: bound the spec — Direct exposure rides every
      // request, so a pathologically large server schema must not.
      definition: downgradeToolSchemaForBudget(t, hint).definition,
      executor,
      meta: {
        // Plan 480 §8.4: three-value exposure policy.
        //   full    → 'always'   (schema rides every request; today's default)
        //   search  → 'discoverable' (tool_search-only; legacy on_demand)
        //   catalog → 'catalog'  (schema NEVER in tools array — read via
        //             tool_schema, invoke via tool_invoke)
        exposeMode: mcpExposureToExposeMode(readToolExposureConfig().exposure),
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
    replaceResult = await agent.setActiveMCPRuntime({
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
