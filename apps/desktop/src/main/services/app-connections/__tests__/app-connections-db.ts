/**
 * app-connections-db.ts — the one `app_connections` fixture for this suite.
 *
 * Every app-connections suite used to hand-roll the same
 * `CREATE TABLE app_connections (...)` DDL inline. Plan 580's migration 58
 * added `connection_slug`, and three of the six copies were never updated, so
 * `ConnectionStore.upsert` failed with
 * `table app_connections has no column named connection_slug` while the three
 * copies that had been updated passed. A second copy of the schema in a test
 * is the drift mechanism, not a fix for it.
 *
 * So there is no second copy here: this builds the table through
 * `initializeSchema`, the same entry point the main process uses, which ends
 * by calling `runMigrations`. The fixture is at the current migration head by
 * construction, and adding a column to the real schema is all it takes to
 * add it here.
 *
 * `app-connections-fixture-head.test.ts` guards that invariant.
 */
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initializeSchema } from '../../../db/schema';

/** In-memory database with the full real schema, migrated to head. */
export function makeAppConnectionsDb(): DatabaseType {
  const db = new Database(':memory:') as unknown as DatabaseType;
  initializeSchema(db);
  return db;
}
