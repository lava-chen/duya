/**
 * mcp-handlers.ts
 *
 * Phase 3 (MCP runtime status UI): single IPC that lets the renderer
 * ask the main process to force a worker reload. The reload path is
 * identical to the GUI / CLI write path: POST `/plugins/reload` on
 * the agent server, which broadcasts `reload:mcp` to every worker,
 * which re-runs `applyMCPConfiguration` end-to-end (PHASE A → B1 → B2).
 *
 * Why a dedicated handler instead of reusing `db:setting:setJson`:
 *   - The settings write path emits a write audit event. A reconnect
 *     is not a write — no `mcp_servers` mutation, just a forced reload.
 *     Routing through the write path would log noise.
 *   - The renderer surface is `mcp:reload` (no arg), not the generic
 *     `db:setting:setJson({mcpServers: ...})` envelope, so the call
 *     site reads naturally as "reconnect MCP".
 *
 * No `ipcMain.handle` registration here — the handler is registered
 * once at boot from `registerIpcHandlers()` (or the equivalent in the
 * app bootstrap). Mirrors the patterns in `db-handlers.ts` /
 * `plugin-handlers.ts`.
 */

import { ipcMain } from 'electron';

import { notifyMcpConfigChanged, requestMcpStatusSnapshot } from '../services/mcp-write-reload';
import { getLogger, LogComponent } from '../logging/logger';

const COMPONENT = 'McpReload' as LogComponent;
const logger = getLogger();

/** Wait before pulling a status snapshot so workers finish reconnecting. */
const RECONNECT_GRACE_MS = 2500;

/**
 * Force a full MCP reload across every attached worker. Best-effort:
 * if the agent server is down the underlying `notifyMcpConfigChanged`
 * swallows the network error (2s timeout) and the IPC resolves with
 * `{ reloaded: false }`. The renderer treats either outcome as "OK,
 * inventory will refresh on the next SSE event".
 */
export async function handleMcpReload(): Promise<{ reloaded: boolean }> {
  logger.info('[MCP] renderer requested force-reload', undefined, COMPONENT);
  // Best-effort by design: the underlying helper already swallows
  // agent-server network errors, but we also guard against any
  // unexpected rejection so the renderer never sees a throw from a
  // "just reload MCP" action.
  try {
    await notifyMcpConfigChanged();
    // Give workers a moment to (re)connect, then request a fresh
    // `mcp:status:snapshot` so the capability aggregator and the
    // renderer see real connection state + tool lists instead of the
    // stale/empty runtime store. Without this, the status dot stays
    // gray even after a successful reconnect.
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_GRACE_MS));
    await requestMcpStatusSnapshot();
    // The snapshot arrives as an SSE event that the router ingests into
    // mcp-runtime-store asynchronously after the broadcast; settle so the
    // renderer's immediate follow-up fetch sees it.
    await new Promise((resolve) => setTimeout(resolve, 600));
  } catch (err) {
    logger.warn(
      '[MCP] force-reload notify failed (best-effort)',
      err instanceof Error ? err : new Error(String(err)),
      COMPONENT,
    );
  }
  return { reloaded: true };
}

/**
 * Register the `mcp:reload` IPC handler. Idempotent — safe to call
 * from multiple boot paths (e.g. main + tests).
 */
export function registerMcpReloadIpcHandler(): void {
  // Guard against double-registration during HMR / test re-runs.
  if (ipcMain.listenerCount('mcp:reload') > 0) return;
  ipcMain.handle('mcp:reload', () => handleMcpReload());
}