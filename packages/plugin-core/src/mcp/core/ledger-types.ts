// packages/plugin-core/src/mcp/core/ledger-types.ts
// Plan 580 D3/D10 — inventory ledger snapshot type, deterministic
// serialization, and (as of ISS-41) the state machine itself.
//
// The header used to claim "PURE TYPE ONLY (plan 580 D1): the state
// machines live in each chain" while the very same file exported
// `emptyLedgerSnapshot()` — a runtime function. The split it described
// did not hold, and the state machine it excused was duplicated in two
// places that were byte-for-byte apart from one helper each:
// `electron/services/app-connections/inventory-ledger.ts` and
// `packages/agent/src/mcp/inventory-ledger.ts`. Both already imported the
// snapshot type from here, so the only thing keeping them apart was the
// note that "electron cannot import the agent workspace package" — true
// of `@duya/agent`, false of `@duya/plugin-core`, which both chains
// already depend on.
//
// The machine stays in this file rather than a new `ledger.ts` beside
// it because of how worktrees resolve workspaces: `node_modules/@duya/*`
// junctions point at the primary checkout, so a brand-new file in a
// workspace package does not resolve for the other packages' typechecks
// (the "fake TS2307" case in AGENTS.md). Core still knows nothing about
// Registry / Catalog / connections — callers that own those numbers push
// them in through `setLayers`.

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

export interface DiscoveryCommitInput {
  pagesFetched: number;
  discoveredTotal: number;
  truncated: false | 'maxPages' | 'maxTools' | 'deadline';
  serverCapabilities?: Record<string, unknown>;
}

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

/**
 * Monotonic-revision, last-known-wins inventory ledger: a failed
 * discovery never clears the last-known numbers (D6), it only flips
 * `discoveryStatus` to `failed` (or `stale` after a truncated pass).
 *
 * Chain-agnostic — it holds numbers, never Registry / Catalog / connection
 * objects, so one instance serves both the agent's `MCPClient` and the
 * remote-MCP `RemoteSession`.
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
    // D6: a truncated pass is NEVER `complete` — the inventory is known
    // to be partial, so the chain treats it as stale (usable, but the
    // next full pass is authoritative).
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

  /**
   * A discovery pass failed — keep the last-known numbers, flip status.
   *
   * The chain A copy of this method read
   * `this.revision > 0 ? 'failed' : 'failed'`: a ternary whose two arms
   * were identical, left behind when the branch it guarded was removed
   * without the expression collapsing to a plain assignment.
   */
  failDiscovery(): void {
    this.status = 'failed';
    this.fetchedAt = Date.now();
  }

  /** Cache hydration counts as a commit (monotonic revision, complete). */
  hydrateFromCache(toolCount: number): void {
    this.commitDiscovery({ pagesFetched: 0, discoveredTotal: toolCount, truncated: false });
  }

  /** Setters for the downstream layers (registry / catalog writers). */
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
