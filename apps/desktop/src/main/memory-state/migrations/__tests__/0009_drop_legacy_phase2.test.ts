import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { migration0005 } from '../0005_phase2.sql';
import { migration0009 } from '../0009_drop_legacy_phase2.sql';

function applyMigration(db: DatabaseType, migration: { sql: string }): void {
  db.exec(migration.sql);
}

function tableExists(db: DatabaseType, name: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(name) as { name: string } | undefined;
  return row !== undefined;
}

describe('migration 0009 — drop legacy phase2 tables', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(':memory:');
    // Seed with the legacy tables from migration 0005.
    applyMigration(db, migration0005);
  });

  afterEach(() => {
    db.close();
  });

  it('drops memory_entries', () => {
    expect(tableExists(db, 'memory_entries')).toBe(true);
    applyMigration(db, migration0009);
    expect(tableExists(db, 'memory_entries')).toBe(false);
  });

  it('drops memory_evidence', () => {
    expect(tableExists(db, 'memory_evidence')).toBe(true);
    applyMigration(db, migration0009);
    expect(tableExists(db, 'memory_evidence')).toBe(false);
  });

  it('drops phase2_runs (legacy, pre-redesign)', () => {
    expect(tableExists(db, 'phase2_runs')).toBe(true);
    applyMigration(db, migration0009);
    expect(tableExists(db, 'phase2_runs')).toBe(false);
  });

  it('is idempotent — running twice does not throw', () => {
    applyMigration(db, migration0009);
    expect(() => applyMigration(db, migration0009)).not.toThrow();
  });

  it('does not drop memory_usage_events (kept for telemetry)', () => {
    expect(tableExists(db, 'memory_usage_events')).toBe(true);
    applyMigration(db, migration0009);
    expect(tableExists(db, 'memory_usage_events')).toBe(true);
  });
});