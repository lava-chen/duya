/**
 * app-connections-fixture-head.test.ts
 *
 * Guard for `app-connections-db.ts`, the shared `app_connections` fixture.
 *
 * Six suites in this directory used to hand-roll the same
 * `CREATE TABLE app_connections (...)`. Plan 580's migration 58 added
 * `connection_slug`; three copies were updated and three were not, so
 * `ConnectionStore.upsert` failed with
 * `table app_connections has no column named connection_slug` in exactly the
 * suites whose copy had been missed. The drift was invisible by construction:
 * a copy that is stale only fails the test that happens to write the column,
 * and a copy nobody exercises never fails at all.
 *
 * The fixture now goes through `initializeSchema`, so the table is at the
 * current migration head by construction. This test is what keeps that true:
 *
 *   1. the fixture really is at the head of the real migration list, so a
 *      future fixture that stops running migrations fails loudly instead of
 *      quietly reverting to a partial schema;
 *   2. `connection_slug` is actually present, so a migration 58 regression
 *      cannot hide behind a fixture that stopped applying it;
 *   3. no second hand-rolled copy of the table has crept back into this
 *      directory, which is the mechanism that caused the original drift.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    time: () => () => {},
    timeAsync: async <T>(_label: string, fn: () => Promise<T>) => fn(),
  }),
  LogComponent: {
    AppConnectionStore: 'AppConnectionStore',
    DB: 'DB',
    DBMigration: 'DBMigration',
  },
}));

import { migrations } from '../../../db/schema';
import { makeAppConnectionsDb } from './app-connections-db';

function columnNames(db: DatabaseType, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe('app-connections-db fixture is at the real migration head', () => {
  it('applies every migration in the shipped list', () => {
    const db = makeAppConnectionsDb();
    const head = Math.max(...migrations.map((m) => m.id));
    const row = db.prepare('SELECT MAX(id) AS head FROM _schema_migrations').get() as
      | { head: number | null }
      | undefined;

    expect(row?.head, 'the fixture did not record any migration').toBe(head);
    db.close();
  });

  it('has the migration-58 connection_slug column the store writes', () => {
    const db = makeAppConnectionsDb();
    expect(columnNames(db, 'app_connections')).toContain('connection_slug');
    db.close();
  });

  it('has no hand-rolled copy of app_connections left in this directory', () => {
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(__dirname)) {
      if (!entry.endsWith('.ts') || entry === path.basename(__filename)) continue;
      const source = fs.readFileSync(path.join(__dirname, entry), 'utf8');
      // Strip comments first: the sanctioned fixture's own doc comment
      // quotes the DDL it exists to stop people writing, and prose is not
      // schema. Line comments are only stripped at line start so a URL
      // inside a string ('https://...') is not mistaken for one.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/CREATE\s+TABLE[^;]*\bapp_connections\b/i.test(code)) {
        offenders.push(entry);
      }
    }
    expect(
      offenders,
      'these files hand-roll the app_connections DDL; use makeAppConnectionsDb() from ./app-connections-db instead',
    ).toEqual([]);
  });
});
