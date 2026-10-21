import { startWalCheckpoint as startDataWalCheckpoint } from '@duya/data/core-database';
import type { DataLogEvent, SqliteDatabase } from '@duya/data/core-database';
import { getLogger, LogComponent } from '../../logging/logger';

export { CoreDatabase } from '@duya/data/core-database';
export type {
  CoreDatabaseOptions,
  DataLogEvent,
  DataLogger,
  Migration,
  SqliteCtor,
  SqliteDatabase,
} from '@duya/data/core-database';

/** Compatibility bridge for the legacy main database lifecycle. */
export function startWalCheckpoint(db: SqliteDatabase): () => void {
  return startDataWalCheckpoint(db, forwardDataLog);
}

function forwardDataLog(event: DataLogEvent): void {
  const logger = getLogger();
  const component = event.category === 'database-migration'
    ? LogComponent.DBMigration
    : LogComponent.DB;
  if (event.level === 'error') {
    logger.error(event.message, event.error, event.data, component);
  } else {
    logger.info(event.message, event.data, component);
  }
}
