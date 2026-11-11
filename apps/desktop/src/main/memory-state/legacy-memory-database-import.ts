import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database } from 'better-sqlite3';
import { DatabaseOwnerLock } from '@duya/data/database-owner-lock';

const SOURCE_SCHEMA = 'legacy_memory';
const IMPORT_MARKER = 'unified_database_imported_memory_state';

/** Merge memory-state rows into the shared application database once. */
export function importLegacyMemoryDatabase(database: Database, legacyPath: string): void {
  const sourcePath = path.resolve(legacyPath);
  if (samePath(sourcePath, path.resolve(database.name))) return;

  const marker = database.prepare('SELECT value FROM meta WHERE key = ?').get(IMPORT_MARKER);
  if (marker) {
    archiveSource(sourcePath);
    return;
  }
  if (!fs.existsSync(sourcePath)) {
    database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(IMPORT_MARKER, 'none');
    return;
  }

  const lock = DatabaseOwnerLock.acquire(sourcePath);
  let attached = false;
  try {
    database.prepare(`ATTACH DATABASE ? AS ${SOURCE_SCHEMA}`).run(sourcePath);
    attached = true;
    const tables = database.prepare(
      `SELECT name, sql FROM ${SOURCE_SCHEMA}.sqlite_master ` +
      `WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as Array<{ name: string; sql: string | null }>;

    database.transaction(() => {
      database.pragma('defer_foreign_keys = ON');
      for (const { name, sql } of tables) {
        if (name === 'memory_schema' || sql?.trimStart().toUpperCase().startsWith('CREATE VIRTUAL TABLE')) continue;
        mergeTable(database, name);
      }
      database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        IMPORT_MARKER,
        `v1@${new Date().toISOString()}`,
      );
    }).immediate();
    database.exec(`DETACH DATABASE ${SOURCE_SCHEMA}`);
    attached = false;
    archiveSource(sourcePath);
  } finally {
    if (attached) database.exec(`DETACH DATABASE ${SOURCE_SCHEMA}`);
    lock?.release();
  }
}

function mergeTable(database: Database, table: string): void {
  const quoted = quoteIdentifier(table);
  const exists = database.prepare(
    `SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table);
  if (!exists) throw new Error(`Legacy memory table has no canonical schema: ${table}`);

  const source = database.pragma(`${SOURCE_SCHEMA}.table_info(${quoted})`) as Array<{ name: string; pk: number }>;
  const target = database.pragma(`main.table_info(${quoted})`) as Array<{ name: string; pk: number }>;
  const columns = source.map((column) => column.name);
  if (columns.some((column) => !target.some((candidate) => candidate.name === column))) {
    throw new Error(`Legacy memory table ${table} contains columns unknown to this Duya version`);
  }
  const sourcePk = source.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
  const targetPk = target.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
  if (sourcePk.length === 0 || sourcePk.length !== targetPk.length || sourcePk.some((key, index) => key !== targetPk[index])) {
    throw new Error(`Legacy memory table ${table} has no compatible primary key`);
  }
  if (columns.length === 0) return;

  const columnsSql = columns.map(quoteIdentifier).join(', ');
  const conflictColumns = sourcePk.map(quoteIdentifier).join(', ');
  const updates = columns.filter((column) => !sourcePk.includes(column));
  const action = updates.length === 0
    ? 'DO NOTHING'
    : `DO UPDATE SET ${updates.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(', ')}`;
  database.exec(
    `INSERT INTO main.${quoted} (${columnsSql}) ` +
    `SELECT ${columnsSql} FROM ${SOURCE_SCHEMA}.${quoted} WHERE 1 ` +
    `ON CONFLICT (${conflictColumns}) ${action}`,
  );
}

function archiveSource(sourcePath: string): void {
  for (const suffix of ['-wal', '-shm', ''] as const) {
    const source = `${sourcePath}${suffix}`;
    if (!fs.existsSync(source)) continue;
    const destination = `${sourcePath}.pre-unification${suffix}`;
    if (fs.existsSync(destination)) throw new Error(`Legacy memory backup already exists: ${destination}`);
    fs.renameSync(source, destination);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
