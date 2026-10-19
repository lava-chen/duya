"use client";

/**
 * useCapabilityManagementSnapshot — Plan 83b Phase 3
 *
 * Hook that wires the capability-management snapshot to the agent
 * server's SSE stream. When MCP reload / status / error events arrive,
 * the hook refetches the snapshot. The aggregation service consumes
 * `lastMCPLoadResult` to fill `mcp.connectionStatus` and
 * `mcp.lastIssue` for known MCP IDs.
 *
 * Rev 3 修订 4 强化：consuming `lastMCPLoadResult` MUST NOT derive
 * `blockedReason`. The helper we add in the service layer keeps the
 * blockedReason calculation tied to providerEnabled + ownEnabled.
 */

import { useEffect } from "react";

import { fetchCapabilityManagementSnapshot, hasCapabilityManagementAPI } from "./capability-management-ipc";
import type { CapabilityManagementSnapshot, CapabilityManagementSnapshotPhase1B } from "./capability-management-types";

export interface UseCapabilityManagementSnapshotOptions {
  onSnapshot: (snapshot: CapabilityManagementSnapshotPhase1B) => void;
  /**
   * Optional SSE event source. Defaults to `window.electronAPI.sse`
   * if exposed by preload. Returns a cleanup function.
   */
  subscribeMcpEvents?: (handler: (event: McpSseEvent) => void) => () => void;
}

export type McpSseEvent =
  | { type: 'mcp:reloaded'; data: unknown }
  | { type: 'mcp:status:snapshot'; data: unknown }
  | { type: 'mcp:reload:error'; data: unknown }
  | { type: 'skills:reloaded'; data: unknown };

/**
 * Resolves the SSE event subscription. The renderer side listens to
 * the agent server's `/agents/sse` stream through preload.
 */
function defaultSubscribe(handler: (event: McpSseEvent) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const api = (window as unknown as { electronAPI?: { sse?: { onAgentServerEvent?: (cb: (e: McpSseEvent) => void) => () => void } } })
    .electronAPI;
  if (!api?.sse?.onAgentServerEvent) return () => undefined;
  return api.sse.onAgentServerEvent(handler);
}

const RELOAD_EVENT_TYPES: ReadonlySet<McpSseEvent['type']> = new Set([
  'mcp:reloaded',
  'mcp:status:snapshot',
  'mcp:reload:error',
  'skills:reloaded',
]);

export function useCapabilityManagementSnapshot(options: UseCapabilityManagementSnapshotOptions): void {
  const { onSnapshot, subscribeMcpEvents = defaultSubscribe } = options;

  useEffect(() => {
    if (!hasCapabilityManagementAPI()) return;
    let cancelled = false;

    const refresh = async () => {
      if (cancelled) return;
      try {
        const snap = await fetchCapabilityManagementSnapshot();
        if (cancelled || !snap) return;
        onSnapshot(snap as CapabilityManagementSnapshotPhase1B);
      } catch {
        // Phase 3 errors are non-fatal; the next SSE event will retry.
      }
    };

    // Initial fetch is best-effort. The useEffect is intended to be
    // combined with the existing CapabilitiesSection-level fetch that
    // runs on mount, but we still trigger a refresh here for symmetry.
    void refresh();

    const unsubscribe = subscribeMcpEvents((event) => {
      if (RELOAD_EVENT_TYPES.has(event.type)) {
        void refresh();
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [onSnapshot, subscribeMcpEvents]);
}

export type AnyCapabilitySnapshot = CapabilityManagementSnapshot | CapabilityManagementSnapshotPhase1B;
