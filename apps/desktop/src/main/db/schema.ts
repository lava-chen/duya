import {
  createMainSchemaMigrations,
  initializeFts5 as initializeDataFts5,
  initializeSchema as initializeDataSchema,
  runMigrations as runDataMigrations,
  selfCheckAndRepairSchema as selfCheckDataSchema,
} from '@duya/data/main-schema';
import type { DataLogEvent } from '@duya/data/core-database';
import { deriveConnectionSlug } from '@duya/plugin-core/mcp/core/alias';
import { getLogger, LogComponent } from '../logging/logger';

type BetterSqlite3Db = import('better-sqlite3').Database;

export const dataLogger = (event: DataLogEvent): void => {
  const logger = getLogger();
  const component = event.category === 'database-migration' ? LogComponent.DBMigration : LogComponent.DB;
  if (event.level === 'error') {
    logger.error(event.message, event.error, event.data, component);
  } else if (event.level === 'warn') {
    logger.warn(event.message, event.data, component);
  } else {
    logger.info(event.message, event.data, component);
  }
};

export const mainSchemaPorts = { deriveConnectionSlug };

/** Desktop logging adapter for the Electron-free main-database schema. */
export function initializeSchema(db: BetterSqlite3Db): void {
  initializeDataSchema(db, mainSchemaPorts, dataLogger);
}

export function initializeFts5(db: BetterSqlite3Db): void {
  initializeDataFts5(db, dataLogger);
}

export const migrations = createMainSchemaMigrations(mainSchemaPorts);

export function runMigrations(db: BetterSqlite3Db): void {
  runDataMigrations(db, mainSchemaPorts, dataLogger);
}

export function selfCheckAndRepairSchema(db: BetterSqlite3Db): void {
  selfCheckDataSchema(db, dataLogger);
}
