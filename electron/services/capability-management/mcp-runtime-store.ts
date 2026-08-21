/**
 * mcp-runtime-store.ts
 *
 * Module-scope cache of the most recent worker `mcp:status:snapshot`
 * SSE event. Consumed by `buildCrossSourceMCPCapabilities` so the
 * per-server `connectionStatus` and tool list reflect what the worker
 * actually has running — not just the last-apply issue list.
 *
 * Why a separate file:
 *   - The aggregator already lives in `cross-source.ts`; mixing a
 *     process-wide mutable cache into the same module would make
 *     testing harder and obscure the "this is the SSE-ingest
 *     surface" intent.
 *   - The store is the single bridge between the agent server's
 *     SSE forwarder (`router.ts` → `setLastMCpStatusSnapshot`) and
 *     the capability-management aggregator (`cross-source.ts` →
 *     `getLatestMcpStatusByServer`).
 *
 * Memory semantics:
 *   - One slot keyed by `scopedServerName` (matches
 *     `MCPManager.getAllClients()[*].getName()` and
 *     `MCPServerInventoryEntry.scopedServerName`).
 *   - Replaced wholesale on each `setLastMCpStatusSnapshot` call;
 *     the worker emits a snapshot at every apply boundary, so the
 *     store never holds stale entries longer than one apply cycle.
 *   - Read-only via `getLatestMcpStatusByServer`. The function
 *     returns a defensive copy so callers cannot mutate the cache.
 */

import type { MCPConnectionStatus } from '../../../packages/agent/src/types.js';

export interface McpServerStatusEntry {
  /** Live status reported by the worker MCPClient. */
  connectionStatus: MCPConnectionStatus;
  /** Number of tools the server has successfully listed. */
  toolCount: number;
  /**
   * Tool list with raw MCP annotations preserved. Annotations are
   * optional in the MCP spec; absent when the server does not
   * advertise them.
   */
  tools: Array<{
    name: string;
    description: string;
    annotations: Record<string, unknown> | undefined;
  }>;
}

let lastSnapshot: Record<string, McpServerStatusEntry> = {};
let lastReceivedAt = 0;

/**
 * Replace the cached snapshot. Accepts the wire shape produced by
 * `buildMcpStatusSnapshot` in the worker:
 *   `{ mcpStatus: Record<scopedServerName, McpServerStatusEntry> }`
 *
 * No-op when `payload` is missing or malformed (defensive — the
 * main process must never crash on a bad SSE event).
 */
export function setLastMCpStatusSnapshot(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const obj = payload as { mcpStatus?: unknown };
  const mcpStatus = obj.mcpStatus;
  if (!mcpStatus || typeof mcpStatus !== 'object') return;

  const out: Record<string, McpServerStatusEntry> = {};
  for (const [name, raw] of Object.entries(mcpStatus as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as {
      connectionStatus?: unknown;
      toolCount?: unknown;
      tools?: unknown;
    };
    const status = r.connectionStatus;
    if (
      status !== 'connected' &&
      status !== 'disconnected' &&
      status !== 'connecting' &&
      status !== 'error'
    ) {
      continue;
    }
    const toolCount = typeof r.toolCount === 'number' && Number.isFinite(r.toolCount)
      ? r.toolCount
      : 0;
    const tools = Array.isArray(r.tools)
      ? r.tools
          .map((t) => {
            if (!t || typeof t !== 'object') return null;
            const tt = t as {
              name?: unknown;
              description?: unknown;
              annotations?: unknown;
            };
            if (typeof tt.name !== 'string') return null;
            const desc = typeof tt.description === 'string' ? tt.description : '';
            const ann =
              tt.annotations && typeof tt.annotations === 'object' && !Array.isArray(tt.annotations)
                ? (tt.annotations as Record<string, unknown>)
                : undefined;
            return { name: tt.name, description: desc, annotations: ann };
          })
          .filter((t): t is NonNullable<typeof t> => t !== null)
      : [];
    out[name] = { connectionStatus: status, toolCount, tools };
  }
  lastSnapshot = out;
  lastReceivedAt = Date.now();
}

/**
 * Read-only access to the cached snapshot. Returns a defensive
 * copy so callers cannot mutate the store by accident.
 */
export function getLatestMcpStatusByServer(): Record<string, McpServerStatusEntry> {
  // Shallow copy is enough: callers only read primitive fields
  // or pass `tools` through to the DTO mapper.
  return { ...lastSnapshot };
}

/**
 * Diagnostics: timestamp of the most recent snapshot ingest, or
 * 0 if the worker has not emitted one yet.
 */
export function getLastMcpStatusReceivedAt(): number {
  return lastReceivedAt;
}

/**
 * Reset the store. Test-only helper.
 */
export function _resetMcpRuntimeStore(): void {
  lastSnapshot = {};
  lastReceivedAt = 0;
}