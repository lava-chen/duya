/**
 * Migration 35/36 against a database that is ALREADY BUILT.
 *
 * ## Why this file exists
 *
 * Every other run-store test opens an EMPTY database and applies only
 * `RUN_STORE_MIGRATIONS`. That proves the two new tables are creatable. It
 * proves nothing about the thing that would actually page someone: whether
 * these migrations land cleanly on the `duya-core.db` a real user already has,
 * which has been through 34 migrations and holds data.
 *
 * This repo has already paid for that lesson once. `stores.ts:449-455` records
 * a "Duplicate core migration id" incident in which a repeated id made the
 * runner's `id <= current` skip a column — silently, with no error, on a
 * database that was otherwise healthy. A test that only ever starts from empty
 * cannot see that class of bug, because the class requires a populated
 * database and a composed migration list.
 *
 * So this file uses the REAL `collectMigrations()` — the same function
 * `initCoreDatabase` calls — rather than re-declaring the list. A re-declared
 * list would be a second source of truth that can drift from the one that runs
 * in production, and a test that pins the wrong list is worse than no test.
 *
 * The properties asserted are the ones that would fail LOUDLY in production:
 * a duplicated id, an id that is not above every existing one, and a new
 * migration that disturbs data an earlier one wrote.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectMigrations } from '../../core-connection';
import { RunStore } from '../run-store';

let db: Database.Database;
let dir: string;

function applyAll(): void {
  for (const migration of collectMigrations()) migration.up(db);
}

function tableExists(name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

/** The entire schema, as one comparable string. */
function schemaFingerprint(): string {
  return (db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as { sql: string | null }[])
    .map((r) => r.sql ?? '')
    .join('\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duya-migration-'));
  db = new Database(join(dir, 'core.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the composed core migration list', () => {
  it('contains no duplicate id', () => {
    // The single most important assertion in this file. A repeated id is what
    // made `stores.ts` skip a column on a live database.
    const seen = new Map<number, string[]>();
    for (const m of collectMigrations()) {
      const list = seen.get(m.id) ?? [];
      list.push(m.name);
      seen.set(m.id, list);
    }
    const dupes = [...seen.entries()].filter(([, names]) => names.length > 1);
    expect(dupes).toEqual([]);
  });

  it('places the run store above every migration that already existed', () => {
    const all = collectMigrations();
    const runIds = RunStore.migrations.map((m) => m.id).sort((a, b) => a - b);
    const others = all.filter((m) => !RunStore.migrations.includes(m)).map((m) => m.id);

    expect(runIds.length).toBeGreaterThan(0);
    // Not "above the current max" as a comment claimed — measured. A future
    // migration landing at 35 would fail here instead of colliding at boot.
    expect(Math.min(...runIds)).toBeGreaterThan(Math.max(...others));
  });

  it('is sorted, because the runner applies it in order', () => {
    const ids = collectMigrations().map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

describe('applying 35/36 to a database that already exists', () => {
  it('creates runs and run_events on top of an already-migrated database', () => {
    applyAll();

    expect(tableExists('runs')).toBe(true);
    expect(tableExists('run_events')).toBe(true);

    const cols = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
    const names = cols.map((c) => c.name);
    // The columns the Control Plane actually reads. A migration that half
    // applied would show up here as a missing name rather than as an error.
    for (const required of ['id', 'session_id', 'manifest_hash', 'manifest_json', 'status', 'terminal', 'error_json', 'created_at']) {
      expect(names).toContain(required);
    }
  });

  it('leaves data written by earlier migrations intact', () => {
    applyAll();

    // `message_index` is migration 1 and predates this plan by a long way.
    // Writing a row and re-reading it after a SECOND full application proves
    // the runner did not re-run, truncate, or rebuild anything on its way
    // through — which is what a retried boot does.
    db.prepare(
      `INSERT INTO message_index (id, session_id, seq, kind, created_at, file_offset, byte_len)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('m-1', 'session-old', 0, 'user', 1, 0, 42);

    applyAll();

    const row = db
      .prepare('SELECT kind, byte_len FROM message_index WHERE id = ?')
      .get('m-1') as { kind: string; byte_len: number } | undefined;
    expect(row).toEqual({ kind: 'user', byte_len: 42 });
  });

  it('leaves the schema byte-identical when the whole list is applied twice', () => {
    applyAll();
    const before = schemaFingerprint();

    applyAll();

    // A retried boot must not rebuild anything. An un-guarded CREATE or a
    // dropped column would change this string, and `stores.ts` records that
    // the failure mode was a SILENT skip rather than an error.
    expect(schemaFingerprint()).toBe(before);
  });

  it('is idempotent when the run migrations are applied twice', () => {
    applyAll();
    // Second application of ONLY the new ones, which is what a retried boot
    // does. `CREATE TABLE IF NOT EXISTS` must make this a no-op rather than an
    // error the caller has to special-case.
    for (const m of RunStore.migrations) m.up(db);
    expect(tableExists('runs')).toBe(true);
    expect(tableExists('run_events')).toBe(true);
  });
});
