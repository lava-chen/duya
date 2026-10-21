/**
 * Plan 610 file 17 S1: the attempt fence in `RunStore`.
 *
 * ## What these cases exist to prove
 *
 * A fencing token that never refuses anything is documentation wearing a
 * column's name. `epoch` was added so a superseded attempt cannot append an
 * event or land a terminal for a run the Host has already moved on from — and
 * the only way to know that check works is to hand it a stale epoch and watch
 * it refuse.
 *
 * So every case below is written as a REFUSAL that must happen, plus the
 * positive control beside it: the current epoch still writes. A fence asserted
 * only in its permissive direction would pass with the check deleted.
 *
 * ## What is deliberately NOT tested here
 *
 * That the fence is atomic against a concurrent `beginAttempt` is a property of
 * its PLACEMENT — inside `completeRun`'s `WHERE` clause, and inside the append
 * transaction — not of any single-threaded case in this file. A test that
 * interleaves two connections would prove SQLite's locking rather than this
 * code's shape; the placement is asserted by reading the statement.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEventEnvelope, RunTerminalState } from '@duya/agent-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, RUN_STORE_MIGRATIONS, RunEpochFencedError } from '../src/run-store';

let db: Database.Database;
let store: RunStore;
let dir: string;

const MANIFEST_HASH = 'a'.repeat(64);
const INPUT_HASH = 'b'.repeat(64);
const COMPLETED: RunTerminalState = { status: 'completed' };

function openStore(): void {
  dir = mkdtempSync(join(tmpdir(), 'duya-attempt-fence-'));
  db = new Database(join(dir, 'core.db'));
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  store = new RunStore(db);
}

function envelope(runId: string, seq: number, type = 'assistant.text_block'): RunEventEnvelope {
  return {
    runId,
    sessionId: 's-1',
    seq,
    timestamp: 0,
    traceId: 't-1',
    payload: { type, messageId: 'm-1', index: 0, text: 'x' },
  } as unknown as RunEventEnvelope;
}

beforeEach(() => {
  openStore();
  store.createRun({ runId: 'r-1', sessionId: 's-1', manifest: { v: 1 }, manifestHash: MANIFEST_HASH, inputHash: INPUT_HASH });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('attempt fencing', () => {
  it('a fresh run starts on epoch 0, which is also what historical rows read as', () => {
    expect(store.currentEpoch('r-1')).toBe(0);
  });

  it('refuses an append from a superseded attempt and keeps the batch out entirely', () => {
    const first = store.currentEpoch('r-1') as number;
    expect(store.appendEvents([envelope('r-1', 1)], first)).toBe(1);

    // A new attempt revokes the old one.
    const second = store.beginAttempt('r-1');
    expect(second).toBe(first + 1);

    // The OLD attempt comes back with a well-formed batch. It must not land.
    expect(() => store.appendEvents([envelope('r-1', 2), envelope('r-1', 3)], first)).toThrow(
      RunEpochFencedError,
    );
    // NOTHING from that batch is written: the check runs inside the same
    // transaction as the inserts, so a refused batch is not half-written.
    expect(store.listEvents('r-1', 0).map((row) => row.seq)).toEqual([1]);
  });

  it('accepts the CURRENT attempt, so the fence refuses the stale one rather than everybody', () => {
    const first = store.currentEpoch('r-1') as number;
    store.beginAttempt('r-1');
    const second = store.currentEpoch('r-1') as number;

    expect(store.appendEvents([envelope('r-1', 5)], second)).toBe(1);
    expect(first).not.toBe(second);
  });

  it('refuses a terminal from a superseded attempt, and reports it as fenced rather than as a lost race', () => {
    const first = store.currentEpoch('r-1') as number;
    store.beginAttempt('r-1');

    // `conflict` here would blame another writer for a decision this attempt was
    // never allowed to make, and would invite a retry that can never succeed.
    const outcome = store.settleRun('r-1', COMPLETED, undefined, first);
    expect(outcome.state).toBe('fenced');
    if (outcome.state === 'fenced') {
      expect(outcome.presented).toBe(first);
      expect(outcome.current).toBe(first + 1);
    }
    // The run is untouched: a fenced writer must not have moved it.
    expect(store.getRun('r-1')?.status).toBe('running');
  });

  it('lets the current attempt settle exactly once', () => {
    const current = store.currentEpoch('r-1') as number;
    expect(store.settleRun('r-1', COMPLETED, undefined, current).state).toBe('applied');
    // A second settle from the SAME attempt is still `reconciled`, not applied.
    expect(store.settleRun('r-1', COMPLETED, undefined, current).state).toBe('reconciled');
  });

  it('a new attempt CONTINUES the sequence instead of restarting it', () => {
    const first = store.currentEpoch('r-1') as number;
    store.appendEvents([envelope('r-1', 1), envelope('r-1', 2)], first);
    expect(store.maxSeq('r-1')).toBe(2);

    const second = store.beginAttempt('r-1') as number;
    // `(run_id, seq)` stays the identity, so a restart at 1 would collide with
    // the previous attempt's rows rather than coexist with them.
    expect(store.appendEvents([envelope('r-1', 3)], second)).toBe(1);
    expect(store.listEvents('r-1', 0).map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it('records which attempt wrote each row', () => {
    const first = store.currentEpoch('r-1') as number;
    store.appendEvents([envelope('r-1', 1)], first);
    const second = store.beginAttempt('r-1') as number;
    store.appendEvents([envelope('r-1', 2)], second);

    const rows = store.listEvents('r-1', 0);
    expect(rows.map((row) => row.epoch)).toEqual([first, second]);
  });

  it('a duplicate delivery of the same envelope is still a retry, not a conflict', () => {
    const current = store.currentEpoch('r-1') as number;
    const batch = [envelope('r-1', 7)];
    expect(store.appendEvents(batch, current)).toBe(1);
    // Zero written, nothing thrown — the bounded retry depends on this.
    expect(store.appendEvents(batch, current)).toBe(0);
    expect(store.countEvents('r-1')).toBe(1);
  });

  it('leaves a run with no row un-fenced rather than inventing an attempt', () => {
    // `beginAttempt` on a run that does not exist is `null`, not epoch 0: a
    // caller that read `0` back would go on to write against nothing.
    expect(store.beginAttempt('r-never')).toBeNull();
    expect(store.currentEpoch('r-never')).toBeNull();
  });
});
