import * as crypto from 'crypto';
import type { Database } from 'better-sqlite3';
import { migration0001 } from './0001_init.sql';
import { migration0002 } from './0002_lease_stage1.sql';
import { migration0003 } from './0003_outbox.sql';
import { migration0005 } from './0005_phase2.sql';
import { migration0006 } from './0006_people_areas.sql';
import { migration0007 } from './0007_lifecycle_scope.sql';
import { getLogger, LogComponent } from '../../logging/logger';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  sha256: string;
}

/**
 * Registered migrations, ordered by version. Each plan appends its
 * own migration to this array:
 *   - 0001 (Plan 301)  — projects / project_path_aliases / rollout_catalog
 *   - 0002 (Plan 302)  — rollout_leases / rollout_retired / stage1_outputs
 *   - 0003 (Plan 303)  — projection_outbox (+ ALTER stage1_outputs)
 *   - 0005 (Phase 2)   — memory_entries / memory_evidence / memory_usage_events / phase2_runs
 *   - 0006 (People/Areas) — extend memory_entries.kind with 'person' and 'area'
 *   - 0007 (Lifecycle/Scope) — lifecycle columns + expanded kind/scope/status
 */
export const MIGRATIONS: Migration[] = [migration0001, migration0002, migration0003, migration0005, migration0006, migration0007];

function computeSha256(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

/**
 * Create the `memory_schema` bookkeeping table if it does not exist.
 * Runs in its own `BEGIN IMMEDIATE` transaction so two processes
 * racing to create the table serialize correctly. Idempotent —
 * `CREATE TABLE IF NOT EXISTS` is a no-op once the table exists.
 */
function ensureSchemaTable(db: Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_schema (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);
  }).immediate();
}

/**
 * Apply all pending migrations to the memory-state DB.
 *
 * Algorithm:
 *   1. Ensure the `memory_schema` table exists (bootstrap).
 *   2. Load already-applied migrations (version → sha256).
 *   3. Tampering check: for every registered migration that has a
 *      recorded row, verify the recorded sha256 matches the current
 *      migration's sha256. Refuse to start on mismatch — modifying
 *      an applied migration is a breaking change; add a new migration
 *      instead.
 *   4. Apply pending migrations (no recorded row) one by one, each
 *      in its own `BEGIN IMMEDIATE` transaction with a re-check
 *      inside the txn so concurrent processes don't double-apply.
 *
 * Cross-process correctness:
 *   - Two processes opening the same WAL DB file is supported.
 *   - `BEGIN IMMEDIATE` acquires a write lock before the body runs,
 *     so racing `runMigrations` calls serialize on the first txn.
 *   - The re-check inside the txn handles the case where process A
 *     commits a migration while process B is waiting for the lock;
 *     process B then sees the row and skips.
 */
export function runMigrations(db: Database): void {
  const logger = getLogger();
  ensureSchemaTable(db);

  const applied = new Map<number, string>();
  const rows = db.prepare('SELECT version, sha256 FROM memory_schema').all() as Array<{ version: number; sha256: string }>;
  for (const row of rows) {
    applied.set(row.version, row.sha256);
  }

  // Tampering detection: verify already-applied migrations match their recorded sha256.
  for (const migration of MIGRATIONS) {
    const expectedSha = computeSha256(migration.sql);
    const recordedSha = applied.get(migration.version);
    if (recordedSha !== undefined && recordedSha !== expectedSha) {
      const err = new Error(
        `memory-state: migration ${migration.version} (${migration.name}) was modified after release. ` +
        `Expected sha256 ${expectedSha}, but the applied migration has ${recordedSha}. ` +
        `Add a new migration instead of modifying an applied one.`
      );
      logger.error(
        'memory-state: migration modified after release — refusing to start',
        err,
        { version: migration.version, name: migration.name, expectedSha, recordedSha },
        LogComponent.DBMigration
      );
      throw err;
    }
  }

  // Apply pending migrations.
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const expectedSha = computeSha256(migration.sql);
    const txn = db.transaction(() => {
      // Re-check inside the transaction: another process may have applied
      // this migration while we were waiting for the IMMEDIATE lock.
      const existing = db.prepare('SELECT sha256 FROM memory_schema WHERE version = ?')
        .get(migration.version) as { sha256: string } | undefined;
      if (existing) {
        if (existing.sha256 !== expectedSha) {
          throw new Error(
            `memory-state: migration ${migration.version} sha256 mismatch detected inside transaction (concurrent modification)`
          );
        }
        return; // already applied by a concurrent process
      }
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO memory_schema (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)'
      ).run(migration.version, migration.name, expectedSha, Date.now());
    });
    txn.immediate();
    logger.info(
      `memory-state: migration ${migration.version} (${migration.name}) applied`,
      { version: migration.version, name: migration.name },
      LogComponent.DBMigration
    );
  }
}
