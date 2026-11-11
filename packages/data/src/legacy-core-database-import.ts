import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DataLogger, SqliteDatabase } from './core-database.js';
import { DatabaseOwnerLock } from './database-owner-lock.js';

const IMPORT_MARKER = 'unified_database_imported_core';
const LEGACY_SCHEMA = 'legacy_core';
const NON_DURABLE_TABLES = new Set([
  'session_runtime_locks',
  'session_control_leases',
  'bot_scheduler_owners',
]);

export interface LegacyCoreImportReport {
  importedTables: number;
  importedRows: number;
  skipped: boolean;
  archivedPath?: string;
}

/** Merge a previous duya-core.db into the canonical main database exactly once. */
export function importLegacyCoreDatabase(
  database: SqliteDatabase,
  legacyPath: string,
  logger?: DataLogger,
): LegacyCoreImportReport {
  const resolvedLegacyPath = path.resolve(legacyPath);
  const resolvedCurrentPath = path.resolve(database.name);
  if (samePath(resolvedLegacyPath, resolvedCurrentPath)) {
    return { importedTables: 0, importedRows: 0, skipped: true };
  }

  const marker = database
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(IMPORT_MARKER) as { value?: string } | undefined;
  if (marker) {
    const ownerLock = DatabaseOwnerLock.acquire(resolvedLegacyPath);
    try {
      const archivedPath = archiveLegacyCoreDatabase(resolvedLegacyPath);
      return {
        importedTables: 0,
        importedRows: 0,
        skipped: true,
        ...(archivedPath ? { archivedPath } : {}),
      };
    } finally {
      ownerLock?.release();
    }
  }

  if (!fs.existsSync(resolvedLegacyPath)) {
    writeMarker(database, 'none');
    return { importedTables: 0, importedRows: 0, skipped: true };
  }

  const ownerLock = DatabaseOwnerLock.acquire(resolvedLegacyPath);
  let attached = false;
  try {
    const report = { importedTables: 0, importedRows: 0 };
    try {
      database.prepare(`ATTACH DATABASE ? AS ${LEGACY_SCHEMA}`).run(resolvedLegacyPath);
      attached = true;

      const sourceTables = database.prepare(
        `SELECT name, sql FROM ${LEGACY_SCHEMA}.sqlite_master ` +
        `WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      ).all() as Array<{ name: string; sql: string | null }>;
      const merge = database.transaction(() => {
        database.pragma('defer_foreign_keys = ON');
        for (const source of sourceTables) {
          if (source.name === 'meta' || NON_DURABLE_TABLES.has(source.name)) continue;
          if (source.sql?.trimStart().toUpperCase().startsWith('CREATE VIRTUAL TABLE')) continue;
          const copied = mergeTable(database, source.name);
          report.importedTables += copied.rows > 0 ? 1 : 0;
          report.importedRows += copied.rows;
        }
        mergeMeta(database);
        writeMarker(database, `v1@${new Date().toISOString()}`);
      });
      merge();
    } finally {
      if (attached) {
        attached = false;
        database.exec(`DETACH DATABASE ${LEGACY_SCHEMA}`);
      }
    }

    const archivedPath = archiveLegacyCoreDatabase(resolvedLegacyPath);

    logger?.({
      level: 'info',
      category: 'database',
      message: 'Legacy core database merged into the canonical database',
      data: { legacyPath: resolvedLegacyPath, ...report, archivedPath },
    });
    return { ...report, skipped: false, ...(archivedPath ? { archivedPath } : {}) };
  } finally {
    if (attached) database.exec(`DETACH DATABASE ${LEGACY_SCHEMA}`);
    ownerLock?.release();
  }
}

function archiveLegacyCoreDatabase(legacyPath: string): string | null {
  const sourcePath = path.resolve(legacyPath);
  if (!fs.existsSync(sourcePath) && !fs.existsSync(`${sourcePath}-wal`) && !fs.existsSync(`${sourcePath}-shm`)) {
    return null;
  }
  const archivedPath = `${sourcePath}.pre-unification`;
  const suffixes = ['-wal', '-shm', ''] as const;
  for (const suffix of suffixes) {
    const source = `${sourcePath}${suffix}`;
    if (!fs.existsSync(source)) continue;
    const destination = `${archivedPath}${suffix}`;
    if (fs.existsSync(destination)) {
      throw new Error(`Legacy core database backup already exists and cannot be overwritten: ${destination}`);
    }
    fs.renameSync(source, destination);
  }
  return archivedPath;
}

function mergeTable(database: SqliteDatabase, table: string): { rows: number } {
  const quotedTable = quoteIdentifier(table);
  const targetExists = database.prepare(
    `SELECT 1 AS present FROM main.sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table) as { present?: number } | undefined;
  if (!targetExists) {
    throw new Error(`Legacy core table has no canonical schema: ${table}`);
  }

  const sourceInfo = database.pragma(`${LEGACY_SCHEMA}.table_info(${quotedTable})`) as TableColumn[];
  const targetInfo = database.pragma(`main.table_info(${quotedTable})`) as TableColumn[];
  const sourceColumns = sourceInfo.map((column) => column.name);
  const targetColumns = new Set(targetInfo.map((column) => column.name));
  const unsupportedColumns = sourceColumns.filter((name) => !targetColumns.has(name));
  if (unsupportedColumns.length > 0) {
    throw new Error(
      `Legacy core table ${table} contains columns unknown to this Duya version: ${unsupportedColumns.join(', ')}`,
    );
  }

  const sourcePrimaryKey = sourceInfo.filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk).map((column) => column.name);
  const targetPrimaryKey = targetInfo.filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk).map((column) => column.name);
  if (sourcePrimaryKey.length === 0 || !sameList(sourcePrimaryKey, targetPrimaryKey)) {
    throw new Error(`Legacy core table ${table} has no compatible primary key for an idempotent merge`);
  }

  const sourceCount = rowCount(database, `${LEGACY_SCHEMA}.${quotedTable}`);
  if (sourceCount === 0) return { rows: 0 };

  const columnsSql = sourceColumns.map(quoteIdentifier).join(', ');
  const primaryKeySql = sourcePrimaryKey.map(quoteIdentifier).join(', ');
  const updates = sourceColumns.filter((column) => !sourcePrimaryKey.includes(column));
  const conflictAction = updates.length === 0
    ? 'DO NOTHING'
    : `DO UPDATE SET ${updates.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(', ')}`;
  database.exec(
    `INSERT INTO main.${quotedTable} (${columnsSql}) ` +
    `SELECT ${columnsSql} FROM ${LEGACY_SCHEMA}.${quotedTable} WHERE 1 ` +
    `ON CONFLICT (${primaryKeySql}) ${conflictAction}`,
  );

  const unmatched = database.prepare(
    `SELECT COUNT(*) AS count FROM (` +
    `SELECT ${primaryKeySql} FROM ${LEGACY_SCHEMA}.${quotedTable} ` +
    `EXCEPT SELECT ${primaryKeySql} FROM main.${quotedTable})`,
  ).get() as { count: number };
  if (unmatched.count > 0) {
    throw new Error(`Legacy core table ${table} still has ${unmatched.count} rows without canonical keys after merge`);
  }
  return { rows: sourceCount };
}

interface TableColumn {
  name: string;
  pk: number;
}

function rowCount(database: SqliteDatabase, from: string, where?: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${from}${where ? ` WHERE ${where}` : ''}`)
    .get() as { count: number };
  return row.count;
}

function mergeMeta(database: SqliteDatabase): void {
  const rows = database.prepare(
    `SELECT key, value FROM ${LEGACY_SCHEMA}.meta WHERE key <> 'schema_version'`,
  ).all() as Array<{ key: string; value: string }>;
  const insert = database.prepare('INSERT OR IGNORE INTO main.meta (key, value) VALUES (?, ?)');
  for (const row of rows) insert.run(row.key, row.value);
}

function writeMarker(database: SqliteDatabase, value: string): void {
  database.prepare(
    'INSERT INTO main.meta (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(IMPORT_MARKER, value);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
