// packages/plugin-core/src/mcp/core/ledger-types.ts
// Plan 580 D3/D10 — inventory ledger snapshot type + deterministic
// serialization. PURE TYPE ONLY (plan 580 D1): the state machines that
// own a live ledger live in each chain
// (`packages/agent/src/mcp/inventory-ledger.ts` and
// `electron/services/app-connections/inventory-ledger.ts`); Core knows
// nothing about Registry / Catalog / connections.

import { canonicalizeJson } from './descriptor.js';

/** Five-layer metric chain (plan 580 D10). */
export interface InventoryLayers {
  /** Tools found by the last committed discovery pass. */
  discovered: number;
  /** Descriptors derived from the discovery pass. */
  descriptors: number;
  /** Model-visible aliases allocated from the descriptors. */
  aliases: number;
  /** Entries actually registered in the ToolRegistry. */
  registered: number;
  /** Entries discoverable through tool_catalog (visibility-filtered). */
  discoverable: number;
}

export type DiscoveryStatus = 'complete' | 'refreshing' | 'failed' | 'stale';

export interface InventoryLedgerSnapshot {
  discoveryStatus: DiscoveryStatus;
  pagesFetched: number;
  /** Tool count actually discovered in the last pass (not "advertised"). */
  discoveredTotal: number;
  /** +1 on every successful commit; monotonic. */
  inventoryRevision: number;
  layers: InventoryLayers;
  /** `initialize` result server capabilities (plan 580 D2). */
  serverCapabilities?: Record<string, unknown>;
  /**
   * Diagnostic event (plan 580 D10) — NOT part of the inventory metric
   * chain. Records the result size of the most recent `tool_catalog`
   * search for this namespace.
   */
  lastSearchReturned?: { count: number; queryId: string; at: number };
  fetchedAt: number;
}

/** Empty snapshot with all-zero layers and `failed` status (nothing known yet). */
export function emptyLedgerSnapshot(now: number = Date.now()): InventoryLedgerSnapshot {
  return {
    discoveryStatus: 'failed',
    pagesFetched: 0,
    discoveredTotal: 0,
    inventoryRevision: 0,
    layers: { discovered: 0, descriptors: 0, aliases: 0, registered: 0, discoverable: 0 },
    fetchedAt: now,
  };
}

/**
 * Deterministic serialization (sorted keys) so two chains can compare
 * ledger snapshots byte-wise in tests and logs.
 */
export function serializeInventoryLedgerSnapshot(snapshot: InventoryLedgerSnapshot): string {
  return JSON.stringify(canonicalizeJson(snapshot));
}
