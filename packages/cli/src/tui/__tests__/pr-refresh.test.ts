/**
 * The bounded refresh behind the footer's pull-request badge.
 *
 * The properties worth pinning are the ones that decide whether the footer
 * turns into a poll loop: a session that already has a pull request is never
 * re-observed, a session gets at most one refresh, and a refresh that could
 * not look yet (`no_checkpoints`, `no_origin_remote`) does not spend that
 * one attempt.
 */

import { describe, expect, it } from 'vitest';

import type { HostIntegrationRecord, HostIntegrationSyncResult } from '@duya/agent-protocol';
import { readPrBadge } from '../pr-refresh.js';

function record(patch: Partial<HostIntegrationRecord> = {}): HostIntegrationRecord {
  return {
    repo: 'lava-chen/duya',
    prNumber: 123,
    state: 'open',
    headSha: 'abcdef1234567890',
    baseRef: 'master',
    url: 'https://github.com/lava-chen/duya/pull/123',
    observedAt: 1_700_000_000_000,
    observedError: null,
    ...patch,
  };
}

function syncResult(patch: Partial<HostIntegrationSyncResult> = {}): HostIntegrationSyncResult {
  return {
    status: 'synced',
    written: [{ repo: 'lava-chen/duya', prNumber: 123 }],
    failed: [],
    ...patch,
  };
}

/** A harness that counts the calls and answers with what it is told to. */
function harness(options: {
  readonly records?: readonly HostIntegrationRecord[];
  readonly afterSync?: readonly HostIntegrationRecord[];
  readonly sync?: HostIntegrationSyncResult;
  readonly synced?: boolean;
  readonly allowSync?: boolean;
}) {
  const reads: number[] = [];
  let syncs = 0;
  let marked = false;
  const deps = {
    read: async (): Promise<readonly HostIntegrationRecord[]> => {
      reads.push(reads.length);
      return syncs === 0 ? options.records ?? [] : options.afterSync ?? options.records ?? [];
    },
    sync: async (): Promise<HostIntegrationSyncResult> => {
      syncs += 1;
      return options.sync ?? syncResult();
    },
    alreadySynced: () => options.synced === true || marked,
    markSynced: () => { marked = true; },
    allowSync: options.allowSync ?? true,
  };
  return { deps, reads, syncs: () => syncs, marked: () => marked };
}

describe('readPrBadge', () => {
  it('reads the projection and never refreshes when it already has one', async () => {
    const h = harness({ records: [record()] });
    const badge = await readPrBadge(h.deps);
    expect(badge?.label).toBe('PR #123');
    expect(h.syncs()).toBe(0);
  });

  it('refreshes once when the projection is empty', async () => {
    const h = harness({ records: [], afterSync: [record()] });
    const badge = await readPrBadge(h.deps);
    expect(badge?.label).toBe('PR #123');
    expect(h.syncs()).toBe(1);
    expect(h.marked()).toBe(true);
  });

  it('does not refresh a session that already spent its attempt', async () => {
    const h = harness({ records: [], synced: true });
    expect(await readPrBadge(h.deps)).toBeNull();
    expect(h.syncs()).toBe(0);
  });

  it('does not refresh when the refresh is not allowed yet', async () => {
    const h = harness({ records: [], allowSync: false });
    expect(await readPrBadge(h.deps)).toBeNull();
    expect(h.syncs()).toBe(0);
  });

  it('keeps the attempt for a refresh that could not look yet', async () => {
    const h = harness({
      records: [],
      sync: syncResult({ status: 'no_checkpoints', written: [], failed: [] }),
    });
    expect(await readPrBadge(h.deps)).toBeNull();
    expect(h.syncs()).toBe(1);
    // The session had nothing to look at, not a spent attempt.
    expect(h.marked()).toBe(false);
  });

  it('spends the attempt for a refresh that observed and failed', async () => {
    const h = harness({
      records: [],
      sync: syncResult({ status: 'observation_failed', written: [], failed: [] }),
    });
    await readPrBadge(h.deps);
    expect(h.marked()).toBe(true);
  });

  it('has no badge when neither the projection nor the refresh found one', async () => {
    const h = harness({ records: [], afterSync: [] });
    expect(await readPrBadge(h.deps)).toBeNull();
  });
});
