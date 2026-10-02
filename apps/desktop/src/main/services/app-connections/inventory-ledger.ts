// apps/desktop/src/main/services/app-connections/inventory-ledger.ts
//
// Plan 580 Phase 5 (D1/D3/D10) — chain B inventory ledger state machine.
//
// Per plan 580 D1, Core holds only the pure snapshot TYPE
// (`ledger-types.ts`); the STATE MACHINE lives per chain. This is the
// chain B instance: owned per remote-MCP `RemoteSession`, written by
// discovery (initial connect, cache hydration, list_changed rediscovery).
// Structurally identical to the chain A ledger
// (`packages/agent/src/mcp/inventory-ledger.ts`) — electron cannot import
// the agent workspace package, and D1 mandates one state machine per chain.

import type {
  InventoryLedgerSnapshot,
  DiscoveryStatus,
  InventoryLayers,
} from '@duya/plugin-core/mcp/core/ledger-types';

export interface DiscoveryCommitInput {
  pagesFetched: number;
  discoveredTotal: number;
  truncated: false | 'maxPages' | 'maxTools' | 'deadline';
  serverCapabilities?: Record<string, unknown>;
}

/**
 * Chain B inventory ledger. Monotonic-revision, last-known-wins: a failed
 * discovery never clears the last-known numbers (D6), it only flips
 * `discoveryStatus` to `failed` (or `stale` after a truncated pass).
 */
export class InventoryLedger {
  private status: DiscoveryStatus = 'failed';
  private pagesFetched = 0;
  private discoveredTotal = 0;
  private revision = 0;
  private layers: InventoryLayers = {
    discovered: 0,
    descriptors: 0,
    aliases: 0,
    registered: 0,
    discoverable: 0,
  };
  private serverCapabilities?: Record<string, unknown>;
  private lastSearchReturned?: { count: number; queryId: string; at: number };
  private fetchedAt = Date.now();

  /** A discovery pass started (status `refreshing`; numbers unchanged). */
  beginDiscovery(): void {
    this.status = 'refreshing';
  }

  /** A discovery pass committed (cursor exhausted normally). */
  commitDiscovery(input: DiscoveryCommitInput): void {
    this.pagesFetched = input.pagesFetched;
    this.discoveredTotal = input.discoveredTotal;
    this.revision++;
    // D6: a truncated pass is NEVER `complete`.
    this.status = input.truncated ? 'stale' : 'complete';
    this.layers = {
      ...this.layers,
      discovered: input.discoveredTotal,
      descriptors: input.discoveredTotal,
      aliases: input.discoveredTotal,
      registered: input.discoveredTotal,
      discoverable: input.discoveredTotal,
    };
    if (input.serverCapabilities) this.serverCapabilities = input.serverCapabilities;
    this.fetchedAt = Date.now();
  }

  /** A discovery pass failed — keep last-known numbers, flip status. */
  failDiscovery(): void {
    this.status = 'failed';
    this.fetchedAt = Date.now();
  }

  /** Cache hydration counts as a commit (revision 1, complete). */
  hydrateFromCache(toolCount: number): void {
    this.commitDiscovery({ pagesFetched: 0, discoveredTotal: toolCount, truncated: false });
  }

  setLayers(partial: Partial<InventoryLayers>): void {
    this.layers = { ...this.layers, ...partial };
  }

  recordSearchReturned(count: number, queryId: string): void {
    this.lastSearchReturned = { count, queryId, at: Date.now() };
  }

  getSnapshot(): InventoryLedgerSnapshot {
    return {
      discoveryStatus: this.status,
      pagesFetched: this.pagesFetched,
      discoveredTotal: this.discoveredTotal,
      inventoryRevision: this.revision,
      layers: { ...this.layers },
      ...(this.serverCapabilities ? { serverCapabilities: this.serverCapabilities } : {}),
      ...(this.lastSearchReturned ? { lastSearchReturned: this.lastSearchReturned } : {}),
      fetchedAt: this.fetchedAt,
    };
  }
}
