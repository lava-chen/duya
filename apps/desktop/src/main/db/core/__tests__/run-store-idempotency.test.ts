/**
 * Run-store idempotency, content conflicts, and terminal reconciliation.
 *
 * Plan 587 R1.3. These run against a real `better-sqlite3` database rather than
 * a mock, because every property under test IS the schema: a primary key that
 * silently absorbs a contradiction, a CAS whose result cannot be told apart from
 * a missing row, a duplicate that overwrites. None of that is visible behind a
 * `vi.fn()`.
 *
 * The two tests named "the named failure" are the ones that were wrong before
 * this slice, and both are behavioural rather than "the method is missing":
 *
 *  - `INSERT OR IGNORE` reported a contradicted `(run_id, seq)` as a successful
 *    zero-row write, so the contradiction was discarded rather than refused.
 *  - a duplicate `runId` was answered "the run exists" even when the existing
 *    row recorded different content, so a caller was told it had opened a run
 *    when it had been refused.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEventEnvelope, RunTerminalState } from '@duya/agent-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunEventConflictError, RunStore, RUN_STORE_MIGRATIONS } from '../run-store';

let db: Database.Database;
let store: RunStore;
let dir: string;

function openStore(): void {
  dir = mkdtempSync(join(tmpdir(), 'duya-run-idem-'));
  db = new Database(join(dir, 'core.db'));
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  store = new RunStore(db);
}

beforeEach(openStore);

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const MANIFEST = { runId: 'r-1', cwd: '/repo' };
const MANIFEST_HASH = 'a'.repeat(64);
const INPUT_HASH = 'i'.repeat(64);

function open(runId = 'r-1', inputHash: string | undefined = INPUT_HASH): void {
  store.createRun({
    runId,
    sessionId: 's-1',
    manifest: MANIFEST,
    manifestHash: MANIFEST_HASH,
    ...(inputHash === undefined ? {} : { inputHash }),
  });
}

/**
 * An envelope whose CONTENT is a parameter, so two envelopes can share a
 * `(runId, seq)` and differ.
 *
 * The discriminator is the text, so a difference here is a difference in the
 * stored `envelope_json` — which is precisely what the comparison under test
 * reads. Varying the `timestamp` instead would be a weaker case: the comparison
 * deliberately ignores nothing, but the test should be about content, not about
 * the clock.
 */
function envelope(runId: string, seq: number, text: string): RunEventEnvelope {
  return {
    runId,
    sessionId: 's-1',
    seq,
    timestamp: 1000,
    traceId: 't-1',
    payload: { type: 'assistant.message', text },
  } as unknown as RunEventEnvelope;
}

describe('event idempotency by identity (R1.3 item 3)', () => {
  it('treats the same (run, seq) with the same payload as a retry', () => {
    open();
    const batch = [envelope('r-1', 1, 'hello'), envelope('r-1', 2, 'world')];
    expect(store.appendEvents(batch)).toBe(2);
    // The Control Plane cannot know whether a timed-out append landed, so it
    // retries. Zero written, no error: the property the bounded retry needs.
    expect(() => store.appendEvents(batch)).not.toThrow();
    expect(store.appendEvents(batch)).toBe(0);
    expect(store.countEvents('r-1')).toBe(2);
  });

  it('REFUSES the same (run, seq) carrying different content — the named failure', () => {
    open();
    store.appendEvents([envelope('r-1', 7, 'the first answer')]);
    const contradiction = envelope('r-1', 7, 'a completely different answer');

    // Before this slice `INSERT OR IGNORE` returned 0 here and threw nothing:
    // the caller could not tell this from a re-delivery, and the second event
    // was discarded while the reply said the write had merely added no rows.
    expect(() => store.appendEvents([contradiction])).toThrow(RunEventConflictError);
    expect(store.countEvents('r-1')).toBe(1);
    // And the surviving event is the FIRST writer's, not silently replaced.
    const stored = store.listEvents('r-1', 6);
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.envelope_json).payload.text).toBe('the first answer');
  });

  it('names the run and the seq it refused, so the caller can act on it', () => {
    open();
    store.appendEvents([envelope('r-1', 3, 'first')]);
    let caught: unknown;
    try {
      store.appendEvents([envelope('r-1', 3, 'second')]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RunEventConflictError);
    expect((caught as RunEventConflictError).code).toBe('event_content_conflict');
    expect((caught as RunEventConflictError).runId).toBe('r-1');
    expect((caught as RunEventConflictError).seq).toBe(3);
  });

  it('writes NOTHING when one sequence in a batch is contradicted', () => {
    open();
    store.appendEvents([envelope('r-1', 2, 'existing')]);
    // seq 1 is free, seq 2 is contradicted, seq 3 is free. A partial write plus
    // a refusal would tell the runtime a whole batch was lost when two of three
    // events landed, and its `lostEvents` accounting would over-count.
    expect(() =>
      store.appendEvents([
        envelope('r-1', 1, 'new'),
        envelope('r-1', 2, 'contradiction'),
        envelope('r-1', 3, 'new'),
      ]),
    ).toThrow(RunEventConflictError);
    expect(store.listEvents('r-1', 0).map((e) => e.seq)).toEqual([2]);
  });

  it('keeps the two runs of one session on independent sequence spaces', () => {
    open('r-a');
    open('r-b');
    // Same seq, different runs: legal, and the reason `run_id` is in the key.
    expect(store.appendEvents([envelope('r-a', 1, 'a')])).toBe(1);
    expect(store.appendEvents([envelope('r-b', 1, 'b')])).toBe(1);
  });
});

describe('idempotent start (R1.3 item 2)', () => {
  it('reuses a runId that already records the same manifest and input', () => {
    const first = store.createRun({
      runId: 'r-dup',
      sessionId: 's-1',
      manifest: MANIFEST,
      manifestHash: MANIFEST_HASH,
      inputHash: INPUT_HASH,
    });
    expect(first.state).toBe('created');

    const second = store.createRun({
      runId: 'r-dup',
      sessionId: 's-1',
      manifest: MANIFEST,
      manifestHash: MANIFEST_HASH,
      inputHash: INPUT_HASH,
    });
    expect(second.state).toBe('reused');
    expect(store.listRunsBySession('s-1')).toHaveLength(1);
  });

  it('refuses a runId that already records a DIFFERENT manifest', () => {
    store.createRun({ runId: 'r-x', sessionId: 's-1', manifest: MANIFEST, manifestHash: MANIFEST_HASH, inputHash: INPUT_HASH });
    const clash = store.createRun({
      runId: 'r-x',
      sessionId: 's-1',
      manifest: { runId: 'r-x', cwd: '/elsewhere' },
      manifestHash: 'b'.repeat(64),
      inputHash: INPUT_HASH,
    });
    // Before this slice the Control Plane answered `existed: true` to this, which
    // is the false success: the caller believes it opened a run and is actually
    // holding a row that says something else entirely.
    expect(clash.state).toBe('conflict');
    expect(store.getRun('r-x')?.manifest_hash).toBe(MANIFEST_HASH);
  });

  it('refuses a runId with the same manifest but a DIFFERENT input revision', () => {
    store.createRun({ runId: 'r-y', sessionId: 's-1', manifest: MANIFEST, manifestHash: MANIFEST_HASH, inputHash: INPUT_HASH });
    // The judgement this slice had to make. A manifest is configuration and an
    // input revision is the claim about what was ASKED FOR. The row holds one
    // of them, so a second different input is a second claim, not a retry.
    const clash = store.createRun({
      runId: 'r-y',
      sessionId: 's-1',
      manifest: MANIFEST,
      manifestHash: MANIFEST_HASH,
      inputHash: 'z'.repeat(64),
    });
    expect(clash.state).toBe('conflict');
    if (clash.state === 'conflict') {
      expect(clash.reason).toMatch(/different input/);
    }
    expect(store.getRun('r-y')?.input_hash).toBe(INPUT_HASH);
  });

  it('refuses a caller that supplies no input hash when the row holds one', () => {
    store.createRun({ runId: 'r-z', sessionId: 's-1', manifest: MANIFEST, manifestHash: MANIFEST_HASH, inputHash: INPUT_HASH });
    // "Unknown" is not "the same". Treating it as same is the optimism this
    // check exists to remove.
    const unknown = store.createRun({ runId: 'r-z', sessionId: 's-1', manifest: MANIFEST, manifestHash: MANIFEST_HASH });
    expect(unknown.state).toBe('conflict');
  });

  it('reuses when BOTH sides recorded no input hash', () => {
    store.createRun({ runId: 'r-n', sessionId: 's-1', manifest: MANIFEST, manifestHash: MANIFEST_HASH });
    const again = store.createRun({ runId: 'r-n', sessionId: 's-1', manifest: MANIFEST, manifestHash: MANIFEST_HASH });
    expect(again.state).toBe('reused');
  });

  it('records the input hash on the row so it can be compared later', () => {
    open('r-store-input');
    expect(store.getRun('r-store-input')?.input_hash).toBe(INPUT_HASH);
  });
});

describe('a lost CAS reconciles rather than overwrites (R1.3 item 4)', () => {
  const COMPLETED: RunTerminalState = { status: 'completed' };

  it('reports `reconciled` when another writer committed the SAME terminal', () => {
    open();
    expect(store.completeRun('r-1', COMPLETED)).toBe(true);
    // The second writer proposes the same verdict. It loses the CAS — and the run
    // IS settled as asked, so reporting a lost claim here would tell a host its
    // succeeded run failed.
    const outcome = store.settleRun('r-1', COMPLETED);
    expect(outcome.state).toBe('reconciled');
  });

  it('reports `conflict` and never overwrites when the terminals DISAGREE', () => {
    open();
    store.completeRun('r-1', { status: 'failed', error: { code: 'provider_auth', message: 'bad key' } });
    const outcome = store.settleRun('r-1', COMPLETED);
    expect(outcome.state).toBe('conflict');
    if (outcome.state === 'conflict') {
      expect(outcome.committed.status).toBe('failed');
    }
    // The other writer's terminal is intact, terminal and error alike.
    const row = store.getRun('r-1');
    expect(row?.status).toBe('failed');
    expect(JSON.parse(row?.error_json ?? '{}').code).toBe('provider_auth');
  });

  it('reports `absent` when the terminal CAS matched no row at all', () => {
    const outcome = store.settleRun('r-never-existed', COMPLETED);
    expect(outcome.state).toBe('absent');
  });

  it('agrees on a failure terminal by its error code and message', () => {
    open();
    const failed: RunTerminalState = { status: 'failed', error: { code: 'provider_auth', message: 'bad key' } };
    store.completeRun('r-1', failed);
    // Same code and message: two writers that reached the same conclusion.
    expect(store.settleRun('r-1', failed).state).toBe('reconciled');
    // Same code, different message: a different finding, and a different claim.
    expect(
      store.settleRun('r-1', { status: 'failed', error: { code: 'provider_auth', message: 'rate limited' } }).state,
    ).toBe('conflict');
  });

  it('does not let a re-settle append a second terminal EVENT either', () => {
    open();
    const terminal = envelope('r-1', 1, 'run.completed') as RunEventEnvelope;
    store.appendEvents([terminal]);
    store.settleRun('r-1', COMPLETED);
    // The reconcile is a READ of the committed state plus a refused write; it
    // must not leave a second copy of the terminal behind.
    expect(store.countEvents('r-1')).toBe(1);
  });
});

describe('migration 37 (input_hash)', () => {
  it('adds the column to a runs table that already exists', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'duya-run-m37-'));
    const other = new Database(join(fresh, 'core.db'));
    try {
      // A `runs` table in the shape migration 35 left it: no `input_hash`.
      other.exec(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, manifest_hash TEXT NOT NULL,
          manifest_json TEXT NOT NULL, status TEXT NOT NULL, terminal TEXT,
          error_json TEXT, metrics_json TEXT, origin TEXT, parent_run_id TEXT,
          created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
        );
      `);
      for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
        migration.up(other);
      }
      const names = (other.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(names).toContain('input_hash');
    } finally {
      other.close();
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('is idempotent, because a retried boot re-runs the whole list', () => {
    for (const migration of RUN_STORE_MIGRATIONS) migration.up(db);
    for (const migration of RUN_STORE_MIGRATIONS) migration.up(db);
    const names = (db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((c) => c.name);
    // SQLite cannot ADD a column twice, so an unguarded migration 37 would make
    // every second boot of an existing database fail.
    expect(names.filter((n) => n === 'input_hash')).toHaveLength(1);
  });
});
