/**
 * connection-slug-migration.test.ts — Plan 580 D7 (migration 58).
 *
 * Exercises the migration-58 backfill against an in-memory better-sqlite3
 * DB with the PRE-migration `app_connections` shape (no connection_slug
 * column): after the migration runs,
 *   - the column exists with DEFAULT '',
 *   - per provider the OLDEST connection keeps '' (bare namespace),
 *   - every later connection derives a unique non-empty slug.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  LogComponent: {
    AppConnectionStore: 'AppConnectionStore',
    DB: 'DB',
    DBMigration: 'DBMigration',
  },
}));

import { migrations } from '../schema';

const M58 = migrations.find((m) => m.id === 58);
if (!M58) throw new Error('migration 58 not found');

function makePreMigrationDb(): DatabaseType {
  const db = new Database(':memory:') as unknown as DatabaseType;
  // Pre-migration shape — no connection_slug column.
  db.exec(`
    CREATE TABLE app_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      account_label TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL DEFAULT '',
      scopes TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'disconnected',
      expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

const INSERT = `
  INSERT INTO app_connections (id, provider, account_label, account_id, scopes, status, expires_at, last_error, created_at, updated_at)
  VALUES (?, ?, '', '', '[]', 'connected', NULL, NULL, ?, ?)
`;

describe('migration 58 — app_connections.connection_slug (plan 580 D7)', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = makePreMigrationDb();
  });

  it('adds the column and backfills: oldest per provider keeps bare slug', () => {
    // Two notion connections (oldest first) + one slack + one notion
    // whose created_at ties with the oldest (id breaks the tie).
    db.prepare(INSERT).run('n-old', 'notion', 100, 100);
    db.prepare(INSERT).run('n-new', 'notion', 200, 200);
    db.prepare(INSERT).run('n-tie', 'notion', 100, 100);
    db.prepare(INSERT).run('s-only', 'slack', 300, 300);

    M58.migrate(db);

    const rows = db
      .prepare('SELECT id, provider, connection_slug FROM app_connections ORDER BY id')
      .all() as Array<{ id: string; provider: string; connection_slug: string }>;
    const byId = new Map(rows.map((r) => [r.id, r]));

    // n-old is the oldest notion row (created_at 100, id 'n-old' < 'n-tie')
    // → bare namespace for life.
    expect(byId.get('n-old')?.connection_slug).toBe('');
    // Everyone else derives a unique non-empty slug.
    const nNew = byId.get('n-new')?.connection_slug ?? '';
    const nTie = byId.get('n-tie')?.connection_slug ?? '';
    const sOnly = byId.get('s-only')?.connection_slug ?? '';
    expect(nNew).toMatch(/^[0-9a-f]{4,8}$/);
    expect(nTie).toMatch(/^[0-9a-f]{4,8}$/);
    // s-only is slack's ONLY connection → it is that provider's oldest
    // row and holds the bare namespace.
    expect(sOnly).toBe('');
    // Uniqueness within a provider.
    expect(nNew).not.toBe(nTie);
  });

  it('is idempotent: a second run does not reassign or clobber slugs', () => {
    db.prepare(INSERT).run('n-old', 'notion', 100, 100);
    db.prepare(INSERT).run('n-new', 'notion', 200, 200);
    M58.migrate(db);
    const first = db
      .prepare('SELECT id, connection_slug FROM app_connections ORDER BY id')
      .all() as Array<{ id: string; connection_slug: string }>;

    M58.migrate(db);
    const second = db
      .prepare('SELECT id, connection_slug FROM app_connections ORDER BY id')
      .all() as Array<{ id: string; connection_slug: string }>;

    expect(second).toEqual(first);
    expect(second.find((r) => r.id === 'n-old')?.connection_slug).toBe('');
    expect(second.find((r) => r.id === 'n-new')?.connection_slug).not.toBe('');
  });

  it('handles an empty table', () => {
    expect(() => M58.migrate(db)).not.toThrow();
    const cols = (db.prepare('PRAGMA table_info(app_connections)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('connection_slug');
  });
});
