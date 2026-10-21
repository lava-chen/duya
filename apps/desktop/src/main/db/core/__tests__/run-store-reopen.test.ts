/**
 * Plan 587 E4.2, storage group — reopening a finished run.
 *
 * ## The row
 *
 * `runreopen`: after a process restart, a host must be able to read a run back
 * and learn what it reached, with no in-memory state involved. The run layer is
 * entered from the Desktop main process, and the Desktop main process is
 * restarted; a run whose only record of its terminal lived in a `Map` would be a
 * run a reconnecting host cannot answer for.
 *
 * ## Why this is a real-database test and not a unit test with a fake store
 *
 * "Reopen" is only meaningful against bytes that outlived a process. So this
 * test does the honest thing available in a unit process: it writes through one
 * `RunStore`, DROPS that store and its handle, opens a SECOND `RunStore` on the
 * same file, and reads the run back. The second store shares nothing with the
 * first except the SQLite file — no shared connection, no shared cache, no
 * carried-over object. That is the closest a unit test gets to a restart, and
 * the properties it proves are properties of the file, not of the object.
 *
 * What this does NOT prove: that the real Desktop process re-opens the real
 * database path after a real restart. That is the Electron boot path, which
 * needs a packaged app and is recorded as unsupported in the matrix rather than
 * approximated here.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEventEnvelope, RunManifest } from '@duya/agent-protocol';
import { manifestFingerprint } from '@duya/agent-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, RUN_STORE_MIGRATIONS } from '../run-store';

let dir: string;
let file: string;

/** Open a FRESH store on the same file, as a restarted process would. */
function reopen(): { store: RunStore; db: Database.Database } {
  const db = new Database(file);
  const store = new RunStore(db);
  return { store, db };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duya-run-reopen-'));
  file = join(dir, 'core.db');
  const first = reopen();
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(first.db);
  }
  first.db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MANIFEST = { runId: 'r-reopen', cwd: '/repo' };
// The REAL fingerprint, computed by the protocol's own function, rather than a
// plausible-looking string of hex. A hand-written hash would make
// `verifyManifest` report `ok: false` — correctly, because the fixture would
// have been lying — and the row would then be asserting a mismatch instead of a
// binding.
const MANIFEST_HASH = manifestFingerprint(MANIFEST as unknown as RunManifest);
const INPUT_HASH = 'c'.repeat(64);

function envelope(runId: string, seq: number, text: string): RunEventEnvelope {
  return {
    runId,
    sessionId: 's-reopen',
    seq,
    timestamp: 1000,
    traceId: 't-reopen',
    payload: { type: 'assistant.message', text },
  } as unknown as RunEventEnvelope;
}

/** Write a complete run — start, three durable events, terminal — then close. */
function writeFinishedRun(): void {
  const { store, db } = reopen();
  store.createRun({
    runId: 'r-reopen',
    sessionId: 's-reopen',
    manifest: MANIFEST,
    manifestHash: MANIFEST_HASH,
    inputHash: INPUT_HASH,
  });
  store.appendEvents([
    envelope('r-reopen', 1, 'first'),
    envelope('r-reopen', 2, 'second'),
    envelope('r-reopen', 3, 'third'),
  ]);
  store.completeRun('r-reopen', { status: 'completed', reason: 'end_turn' });
  db.close();
}

describe('a finished run is readable by a store that never saw it', () => {
  it('reopens the row with its manifest binding and its terminal intact', () => {
    writeFinishedRun();

    // A different store, a different connection, the same file.
    const { store, db } = reopen();
    try {
      const row = store.getRun('r-reopen');
      expect(row).not.toBeNull();
      expect(row?.status).toBe('completed');
      // `terminal` is the plain status column, not a JSON blob — the detail
      // lives in `error_json` / `metrics_json`. Asserting JSON.parse here would
      // have tested the column's type instead of the run.
      expect(row?.terminal).toBe('completed');

      // The manifest binding survives too. A reopened run whose hash no longer
      // matched its stored manifest would be a run the Control Plane can no
      // longer verify, which is why `verifyManifest` is asked rather than assumed.
      expect(row?.manifest_hash).toBe(MANIFEST_HASH);
      expect(row?.input_hash).toBe(INPUT_HASH);
      expect(store.verifyManifest('r-reopen')).toEqual({
        ok: true,
        expected: MANIFEST_HASH,
        actual: MANIFEST_HASH,
      });
    } finally {
      db.close();
    }
  });

  it('reopens the whole event ledger in sequence, so a reconnect has no gap to paper over', () => {
    writeFinishedRun();

    const { store, db } = reopen();
    try {
      const events = store.listEvents('r-reopen', 0);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(store.countEvents('r-reopen')).toBe(3);

      // Replay from a cursor, which is what a reconnecting consumer actually
      // does. Reading from the middle must return the tail and nothing else.
      const tail = store.listEvents('r-reopen', 2);
      expect(tail.map((e) => e.seq)).toEqual([3]);
    } finally {
      db.close();
    }
  });

  it('refuses to reopen a run that was never written, rather than inventing one', () => {
    const { store, db } = reopen();
    try {
      expect(store.getRun('r-absent')).toBeNull();
      expect(store.listEvents('r-absent', 0)).toEqual([]);
      expect(store.countEvents('r-absent')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('refuses a second writer that reuses the run id with different content', () => {
    // Reopen is also the path a retried `createRun` takes, and the refusal has
    // to survive the restart — an idempotency check that only holds in one
    // process is not idempotency.
    writeFinishedRun();

    const { store, db } = reopen();
    try {
      // Same manifest, same input: an honest retry, and it is admitted.
      const retry = store.createRun({
        runId: 'r-reopen',
        sessionId: 's-reopen',
        manifest: MANIFEST,
        manifestHash: MANIFEST_HASH,
        inputHash: INPUT_HASH,
      });
      expect(retry.state).toBe('reused');

      // Same run id, different input: refused, and the stored row is untouched.
      const contradicted = store.createRun({
        runId: 'r-reopen',
        sessionId: 's-reopen',
        manifest: MANIFEST,
        manifestHash: MANIFEST_HASH,
        inputHash: 'd'.repeat(64),
      });
      expect(contradicted.state).toBe('conflict');
      expect(store.getRun('r-reopen')?.input_hash).toBe(INPUT_HASH);
    } finally {
      db.close();
    }
  });
});
