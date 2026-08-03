import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, MIGRATIONS } from '../migrations';
import { migration0001 } from '../migrations/0001_init.sql';
import { migration0002 } from '../migrations/0002_lease_stage1.sql';
import { migration0003 } from '../migrations/0003_outbox.sql';
import { migration0005 } from '../migrations/0005_phase2.sql';
import { createTempDbDir, type TempDbDir } from './fixture';

const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => mocks.logger,
  LogComponent: {
    DB: 'DB',
    DBMigration: 'DBMigration',
  },
}));

/**
 * Helper: open a fresh file-based DB at the given path with the same
 * PRAGMAs that bootstrap() would set. Used to simulate a second
 * process handle for the concurrency test.
 */
function openRawDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

describe('memory-state migration runner', () => {
  let temp: TempDbDir;
  let dbPath: string;

  beforeEach(() => {
    temp = createTempDbDir();
    dbPath = `${temp.dir}/memory-state.db`;
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('1. first runMigrations on empty DB applies all registered migrations and inserts memory_schema rows', () => {
    const db = openRawDb(dbPath);
    runMigrations(db);

    const rows = db.prepare('SELECT version, name, sha256 FROM memory_schema ORDER BY version').all() as Array<{
      version: number;
      name: string;
      sha256: string;
    }>;
    expect(rows).toHaveLength(7);
    expect(rows[0].version).toBe(1);
    expect(rows[0].name).toBe('init_control_plane');
    expect(rows[0].sha256).toBe(migration0001.sha256);
    expect(rows[1].version).toBe(2);
    expect(rows[1].name).toBe('lease_stage1');
    expect(rows[1].sha256).toBe(migration0002.sha256);
    expect(rows[2].version).toBe(3);
    expect(rows[2].name).toBe('projection_outbox');
    expect(rows[2].sha256).toBe(migration0003.sha256);
    expect(rows[3].version).toBe(5);
    expect(rows[3].name).toBe('phase2_entities');
    expect(rows[3].sha256).toBe(migration0005.sha256);
    expect(rows[4].version).toBe(6);
    expect(rows[5].version).toBe(7);
    expect(rows[6].version).toBe(8);
    expect(rows[6].name).toBe('curation_runs');

    // Schema tables exist.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('project_path_aliases');
    expect(tableNames).toContain('rollout_catalog');
    expect(tableNames).toContain('rollout_leases');
    expect(tableNames).toContain('rollout_retired');
    expect(tableNames).toContain('stage1_outputs');
    expect(tableNames).toContain('projection_outbox');
    expect(tableNames).toContain('memory_schema');

    db.close();
  });

  it('2. second runMigrations is idempotent — no reapplication', () => {
    const db = openRawDb(dbPath);
    runMigrations(db);

    const rowsBefore = db.prepare('SELECT COUNT(*) AS n FROM memory_schema').get() as { n: number };
    expect(rowsBefore.n).toBe(7);

    // Re-run; should not throw, not insert a duplicate, not re-exec migration.
    runMigrations(db);

    const rowsAfter = db.prepare('SELECT COUNT(*) AS n FROM memory_schema').get() as { n: number };
    expect(rowsAfter.n).toBe(7);

    db.close();
  });

  it('3. two handles to the same DB file converge — only one migration row per version', () => {
    // Handle A applies the migration first.
    const dbA = openRawDb(dbPath);
    runMigrations(dbA);

    // Handle B opens the same file and runs migrations.
    // The re-check inside the BEGIN IMMEDIATE transaction finds the
    // row and skips. No double-application, no duplicate memory_schema row.
    const dbB = openRawDb(dbPath);
    runMigrations(dbB);

    const rows = dbB.prepare('SELECT COUNT(*) AS n FROM memory_schema').get() as { n: number };
    expect(rows.n).toBe(7);

    dbA.close();
    dbB.close();
  });

  it('4. migration sha256 modified after application refuses to start', () => {
    const db = openRawDb(dbPath);
    runMigrations(db);

    // Simulate tampering: overwrite the recorded sha256 with a wrong value.
    db.prepare('UPDATE memory_schema SET sha256 = ? WHERE version = 1').run('deadbeef');

    expect(() => runMigrations(db)).toThrow(/modified after release/);
    expect(mocks.logger.error).toHaveBeenCalled();

    db.close();
  });

  it('5. migration that throws halfway rolls back the transaction — no memory_schema row', () => {
    const db = openRawDb(dbPath);
    // Pre-create `memory_schema` so the runner's bootstrap step is a no-op,
    // then pre-create a `projects` table so migration 0001's
    // `CREATE TABLE projects` throws "table already exists" inside the txn.
    db.exec(`
      CREATE TABLE memory_schema (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE projects (x INTEGER);
    `);

    expect(() => runMigrations(db)).toThrow();

    // The transaction rolled back: no memory_schema row for version 1.
    const row = db.prepare('SELECT version FROM memory_schema WHERE version = 1').get();
    expect(row).toBeUndefined();

    db.close();
  });

  it('6. close then re-bootstrap does not double-apply migrations', () => {
    // First run on a fresh DB.
    const dbA = openRawDb(dbPath);
    runMigrations(dbA);
    dbA.close();

    // Reopen the same file and run again.
    const dbB = openRawDb(dbPath);
    runMigrations(dbB);

    const rows = dbB.prepare('SELECT COUNT(*) AS n FROM memory_schema').get() as { n: number };
    expect(rows.n).toBe(7);

    // Schema is intact — tables still queryable.
    const projectCount = dbB.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
    expect(projectCount.n).toBe(0);
    const leaseCount = dbB.prepare('SELECT COUNT(*) AS n FROM rollout_leases').get() as { n: number };
    expect(leaseCount.n).toBe(0);

    dbB.close();
  });

  it('7. migration 0002 applies cleanly on a 0001-only DB and is checksum-verified', () => {
    const db = openRawDb(dbPath);

    // Apply only migration 0001 by hand to simulate a pre-302 database.
    db.exec(`
      CREATE TABLE memory_schema (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    db.exec(migration0001.sql);
    db.prepare(
      'INSERT INTO memory_schema (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)'
    ).run(migration0001.version, migration0001.name, migration0001.sha256, Date.now());

    // Runner must apply exactly the pending migrations (0002 + 0003).
    runMigrations(db);

    const row = db
      .prepare('SELECT sha256 FROM memory_schema WHERE version = 2')
      .get() as { sha256: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sha256).toBe(migration0002.sha256);

    const row3 = db
      .prepare('SELECT sha256 FROM memory_schema WHERE version = 3')
      .get() as { sha256: string } | undefined;
    expect(row3).toBeDefined();
    expect(row3!.sha256).toBe(migration0003.sha256);

    // 0002 tables and indexes exist.
    const objects = db
      .prepare("SELECT name, type FROM sqlite_master WHERE name LIKE '%lease%' OR name LIKE '%retired%' OR name LIKE '%stage1%' ORDER BY name")
      .all() as Array<{ name: string; type: string }>;
    const names = objects.map((o) => o.name);
    expect(names).toContain('rollout_leases');
    expect(names).toContain('rollout_retired');
    expect(names).toContain('stage1_outputs');
    expect(names).toContain('idx_stage1_outputs_project');
    expect(names).toContain('idx_stage1_outputs_job_status');
    expect(names).toContain('idx_stage1_outputs_content_out');
    expect(names).toContain('idx_stage1_outputs_source_ver');

    // Column shape spot-checks for the lease contract.
    const leaseCols = db.prepare("PRAGMA table_info(rollout_leases)").all() as Array<{ name: string }>;
    const leaseColNames = leaseCols.map((c) => c.name);
    for (const col of [
      'rollout_id', 'token', 'acquired_at', 'heartbeat_at', 'expires_at',
      'attempt_count', 'next_retry_at', 'claimed_by', 'idempotency_token',
      'last_error', 'source_updated_at', 'source_content_hash', 'job_status',
    ]) {
      expect(leaseColNames).toContain(col);
    }

    // stage1_outputs.job_status CHECK rejects 'failed' (design v3 D2:
    // execution failures live in rollout_leases / rollout_retired only).
    expect(() =>
      db.prepare(
        `INSERT INTO stage1_outputs (
          rollout_id, thread_id, cwd, project_id, job_status,
          rollout_slug, generated_at, source_updated_at, source_content_hash,
          output_updated_at
        ) VALUES ('r1', 't1', '/tmp', 'p1', 'failed', 'slug', 0, 0, 'h', 0)`
      ).run()
    ).toThrow(/CHECK/);

    // 0003: projection_outbox table + pending index exist.
    const outboxObjects = db
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE '%outbox%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const outboxNames = outboxObjects.map((o) => o.name);
    expect(outboxNames).toContain('projection_outbox');
    expect(outboxNames).toContain('idx_outbox_pending');

    // 0003: stage1_outputs gained content_hash_at_write via ALTER.
    const stage1Cols = db.prepare('PRAGMA table_info(stage1_outputs)').all() as Array<{ name: string }>;
    expect(stage1Cols.map((c) => c.name)).toContain('content_hash_at_write');

    db.close();
  });

  it('8. migration 0005 applies without re-applying 0001/0002/0003; all four Phase 2 tables exist; checksum is registered', () => {
    const db = openRawDb(dbPath);
    runMigrations(db);

    // memory_schema has 7 rows: versions 1, 2, 3, 5, 6, 7, 8.
    // 0001/0002/0003 are not re-applied; 0005 is registered with a
    // valid sha256 (64-char hex).
    const rows = db
      .prepare('SELECT version, name, sha256 FROM memory_schema ORDER BY version')
      .all() as Array<{ version: number; name: string; sha256: string }>;
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 5, 6, 7, 8]);

    const phase2Row = rows.find((r) => r.version === 5);
    expect(phase2Row).toBeDefined();
    expect(phase2Row!.sha256).toMatch(/^[0-9a-f]{64}$/);

    // All four Phase 2 tables exist.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('memory_entries');
    expect(tableNames).toContain('memory_evidence');
    expect(tableNames).toContain('memory_usage_events');
    expect(tableNames).toContain('phase2_runs');

    // Unique index on memory_entries.canonical exists.
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_memory_entries_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((o) => o.name);
    expect(indexNames).toContain('idx_memory_entries_canonical');

    db.close();
  });

  it('MIGRATIONS registry includes migrations 0001, 0002, 0003, 0005, 0006, 0007 and 0008 in order', () => {
    expect(MIGRATIONS).toHaveLength(7);
    expect(MIGRATIONS[0].version).toBe(1);
    expect(MIGRATIONS[0].name).toBe('init_control_plane');
    expect(MIGRATIONS[0].sha256).toBe(migration0001.sha256);
    expect(MIGRATIONS[1].version).toBe(2);
    expect(MIGRATIONS[1].name).toBe('lease_stage1');
    expect(MIGRATIONS[1].sha256).toBe(migration0002.sha256);
    expect(MIGRATIONS[2].version).toBe(3);
    expect(MIGRATIONS[2].name).toBe('projection_outbox');
    expect(MIGRATIONS[2].sha256).toBe(migration0003.sha256);
    expect(MIGRATIONS[3].version).toBe(5);
    expect(MIGRATIONS[3].name).toBe('phase2_entities');
    expect(MIGRATIONS[3].sha256).toBe(migration0005.sha256);
    expect(MIGRATIONS[4].version).toBe(6);
    expect(MIGRATIONS[5].version).toBe(7);
    expect(MIGRATIONS[6].version).toBe(8);
    expect(MIGRATIONS[6].name).toBe('curation_runs');
  });

  it('migration sha256 values are stable (deterministic from SQL body)', () => {
    // The sha256 is computed at module load time from the SQL string.
    // Any change to the SQL (even whitespace) changes the hash —
    // which is the tampering-detection guarantee.
    for (const migration of MIGRATIONS) {
      expect(migration.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(migration.sha256).not.toBe('');
    }
  });

  it('9. migration 0008 creates curation_runs / curation_run_inputs / curation_publications and adds stage1 policy columns', () => {
    const db = openRawDb(dbPath);
    runMigrations(db);

    // memory_schema has a row for version 8.
    const row = db
      .prepare('SELECT version, name, sha256 FROM memory_schema WHERE version = 8')
      .get() as { version: number; name: string; sha256: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('curation_runs');
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);

    // All three new tables exist.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('curation_runs');
    expect(tableNames).toContain('curation_run_inputs');
    expect(tableNames).toContain('curation_publications');

    // Old phase2_runs table still exists (NOT dropped).
    expect(tableNames).toContain('phase2_runs');

    // stage1_outputs gained stage1_policy_version + stage1_policy_hash.
    const stage1Cols = db.prepare('PRAGMA table_info(stage1_outputs)').all() as Array<{ name: string }>;
    const colNames = stage1Cols.map((c) => c.name);
    expect(colNames).toContain('stage1_policy_version');
    expect(colNames).toContain('stage1_policy_hash');

    db.close();
  });

  it('10. migration 0008 CHECK constraints reject invalid status / run_type / publication_status / cache_status / input_kind', () => {
    const db = openRawDb(dbPath);
    runMigrations(db);

    // Insert a valid row first so FK has a parent.
    db.prepare(
      `INSERT INTO curation_runs (run_id, status, input_set_hash, base_manifest_hash,
        lock_token, claimed_by, started_at, heartbeat_at, lease_expires_at)
       VALUES ('run-1', 'running', 'h1', 'h2', 'tok', 'w1', 0, 0, 0)`
    ).run();

    // status CHECK rejects unknown value.
    expect(() =>
      db.prepare(
        `INSERT INTO curation_runs (run_id, status, input_set_hash, base_manifest_hash,
          lock_token, claimed_by, started_at, heartbeat_at, lease_expires_at)
         VALUES ('run-bad-status', 'unknown', 'h', 'h', 't', 'w', 0, 0, 0)`
      ).run()
    ).toThrow(/CHECK/);

    // run_type CHECK rejects unknown value.
    expect(() =>
      db.prepare(
        `INSERT INTO curation_runs (run_id, run_type, input_set_hash, base_manifest_hash,
          lock_token, claimed_by, started_at, heartbeat_at, lease_expires_at)
         VALUES ('run-bad-type', 'invalid', 'h', 'h', 't', 'w', 0, 0, 0)`
      ).run()
    ).toThrow(/CHECK/);

    // publication_status CHECK rejects unknown value.
    expect(() =>
      db.prepare(
        `INSERT INTO curation_runs (run_id, publication_status, input_set_hash, base_manifest_hash,
          lock_token, claimed_by, started_at, heartbeat_at, lease_expires_at)
         VALUES ('run-bad-pub', 'invalid_pub', 'h', 'h', 't', 'w', 0, 0, 0)`
      ).run()
    ).toThrow(/CHECK/);

    // cache_status CHECK rejects unknown value.
    expect(() =>
      db.prepare(
        `INSERT INTO curation_runs (run_id, cache_status, input_set_hash, base_manifest_hash,
          lock_token, claimed_by, started_at, heartbeat_at, lease_expires_at)
         VALUES ('run-bad-cache', 'invalid_cache', 'h', 'h', 't', 'w', 0, 0, 0)`
      ).run()
    ).toThrow(/CHECK/);

    // input_kind CHECK rejects unknown value.
    expect(() =>
      db.prepare(
        `INSERT INTO curation_run_inputs (run_id, input_kind, input_key, content_hash, output_updated_at)
         VALUES ('run-1', 'invalid_kind', 'key', 'hash', 0)`
      ).run()
    ).toThrow(/CHECK/);

    db.close();
  });

  it('11. migration 0008 is registered in MIGRATIONS array after 0007', () => {
    // The MIGRATIONS array must include version 8 after version 7.
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toContain(8);
    const idx7 = versions.indexOf(7);
    const idx8 = versions.indexOf(8);
    expect(idx8).toBeGreaterThan(idx7);
  });
});
