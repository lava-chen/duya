/**
 * ledger-state.test.ts — the consolidated inventory ledger state machine
 * (plan 580 D3/D10, ISS-41).
 *
 * This class used to exist twice, once per chain, byte-for-byte apart
 * from a single helper each. These tests cover the union of both API
 * surfaces, including `hydrateFromCache` (which only the electron chain
 * had) and the monotonic-revision / last-known-wins guarantees both
 * copies claimed to provide.
 */
import { describe, expect, it } from 'vitest';

import {
  InventoryLedger,
  emptyLedgerSnapshot,
  type DiscoveryCommitInput,
} from '../../../src/mcp/core/ledger-types.js';

function commit(ledger: InventoryLedger, over: Partial<DiscoveryCommitInput> = {}) {
  ledger.commitDiscovery({
    pagesFetched: over.pagesFetched ?? 1,
    discoveredTotal: over.discoveredTotal ?? 10,
    truncated: over.truncated ?? false,
  });
}

describe('InventoryLedger', () => {
  it('starts equivalent to emptyLedgerSnapshot', () => {
    const snap = new InventoryLedger().getSnapshot();
    expect(snap.discoveryStatus).toBe(emptyLedgerSnapshot().discoveryStatus);
    expect(snap.inventoryRevision).toBe(0);
    expect(snap.layers).toEqual({
      discovered: 0,
      descriptors: 0,
      aliases: 0,
      registered: 0,
      discoverable: 0,
    });
  });

  it('beginDiscovery marks refreshing without changing the numbers (D6)', () => {
    const ledger = new InventoryLedger();
    commit(ledger, { pagesFetched: 3, discoveredTotal: 42 });
    ledger.beginDiscovery();

    const snap = ledger.getSnapshot();
    expect(snap.discoveryStatus).toBe('refreshing');
    // Last-known-wins: the pass in flight must not have zeroed anything.
    expect(snap.discoveredTotal).toBe(42);
    expect(snap.pagesFetched).toBe(3);
    expect(snap.inventoryRevision).toBe(1);
  });

  it('commitDiscovery bumps the revision monotonically', () => {
    const ledger = new InventoryLedger();
    commit(ledger, { discoveredTotal: 1 });
    commit(ledger, { discoveredTotal: 2 });
    commit(ledger, { discoveredTotal: 3 });
    expect(ledger.getSnapshot().inventoryRevision).toBe(3);
  });

  it.each(['maxPages', 'maxTools', 'deadline'] as const)(
    'truncation reason %s yields stale, never complete (D6)',
    (truncated) => {
      const ledger = new InventoryLedger();
      commit(ledger, { truncated });
      expect(ledger.getSnapshot().discoveryStatus).toBe('stale');
    },
  );

  it('failDiscovery keeps the last-known numbers and bumps fetchedAt (D6)', () => {
    const ledger = new InventoryLedger();
    commit(ledger, { pagesFetched: 7, discoveredTotal: 99 });
    const before = ledger.getSnapshot();
    ledger.failDiscovery();
    const after = ledger.getSnapshot();

    expect(after.discoveryStatus).toBe('failed');
    expect(after.discoveredTotal).toBe(99);
    expect(after.pagesFetched).toBe(7);
    expect(after.inventoryRevision).toBe(before.inventoryRevision);
    expect(after.fetchedAt).toBeGreaterThanOrEqual(before.fetchedAt);
  });

  // The chain A copy read `this.revision > 0 ? 'failed' : 'failed'` — both
  // arms identical, left behind when the branch it guarded was removed.
  it('failDiscovery behaves the same with and without a prior commit', () => {
    const never = new InventoryLedger();
    expect(never.failDiscovery.bind(never)).not.toThrow();
    expect(never.getSnapshot().discoveryStatus).toBe('failed');

    const once = new InventoryLedger();
    commit(once);
    once.failDiscovery();
    expect(once.getSnapshot().discoveryStatus).toBe('failed');
  });

  it('hydrateFromCache counts as a complete commit', () => {
    const ledger = new InventoryLedger();
    ledger.hydrateFromCache(17);
    const snap = ledger.getSnapshot();
    expect(snap.discoveryStatus).toBe('complete');
    expect(snap.discoveredTotal).toBe(17);
    expect(snap.pagesFetched).toBe(0);
    expect(snap.inventoryRevision).toBe(1);
  });

  it('setLayers merges rather than replaces', () => {
    const ledger = new InventoryLedger();
    commit(ledger, { discoveredTotal: 8 });
    ledger.setLayers({ registered: 3 });
    const { layers } = ledger.getSnapshot();
    expect(layers.registered).toBe(3);
    // The other four came from the commit and survived the partial update.
    expect(layers.discovered).toBe(8);
    expect(layers.descriptors).toBe(8);
  });

  it('records serverCapabilities only when supplied', () => {
    const ledger = new InventoryLedger();
    commit(ledger);
    expect(ledger.getSnapshot().serverCapabilities).toBeUndefined();

    ledger.commitDiscovery({
      pagesFetched: 1,
      discoveredTotal: 1,
      truncated: false,
      serverCapabilities: { tools: {} },
    });
    expect(ledger.getSnapshot().serverCapabilities).toEqual({ tools: {} });
  });

  it('records the last tool_catalog search result', () => {
    const ledger = new InventoryLedger();
    ledger.recordSearchReturned(4, 'q-1');
    expect(ledger.getSnapshot().lastSearchReturned).toMatchObject({
      count: 4,
      queryId: 'q-1',
    });
  });

  it('getSnapshot returns a copy of the layers, not the live object', () => {
    const ledger = new InventoryLedger();
    commit(ledger, { discoveredTotal: 5 });
    const first = ledger.getSnapshot();
    first.layers.registered = 999;
    expect(ledger.getSnapshot().layers.registered).toBe(5);
  });
});
