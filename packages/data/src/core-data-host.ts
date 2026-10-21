import { CoreDatabase, type DataLogger, type Migration, type SqliteCtor } from './core-database.js';
import { createCoreDataStores, collectCoreDataMigrations, type CoreDataStores } from './core-stores.js';
import { MessageLog, type MessageLogPorts } from './message-log.js';
import { migrateLegacyArchivedRows } from './legacy-archive-migration.js';
import { dirname, join } from 'node:path';
import { needsProjectsImport, runProjectsImport } from './projects-import.js';

export interface CoreDataHostOptions {
  filename: string;
  rolloutRoot: string;
  attachmentsRoot: string;
  messageLogPorts: MessageLogPorts;
  sqlite?: SqliteCtor;
  logger?: DataLogger;
  now?: () => number;
}

export interface CoreDataHostStores extends CoreDataStores {
  messageLog: MessageLog;
}

/** Own the core database connection, its migrations, and its durable stores. */
export class CoreDataHost {
  readonly database: CoreDatabase;
  readonly stores: CoreDataHostStores;
  private closed = false;

  constructor(options: CoreDataHostOptions) {
    this.database = new CoreDatabase({
      filename: options.filename,
      ...(options.sqlite ? { sqlite: options.sqlite } : {}),
      migrations: collectCoreDatabaseMigrations(),
      ...(options.logger ? { logger: options.logger } : {}),
    });

    try {
      const db = this.database.db;
      const stores = createCoreDataStores(db, { attachmentsRoot: options.attachmentsRoot });
      const messageLog = new MessageLog(db, options.rolloutRoot, options.messageLogPorts);

      // Repair archive rows before exposing the stores to session callers.
      const archiveReport = migrateLegacyArchivedRows(
        db,
        options.rolloutRoot,
        (options.now ?? Date.now)(),
        options.logger,
      );
      for (const sessionId of archiveReport.migrated) {
        messageLog.invalidateRolloutPathCache(sessionId);
      }

      try {
        if (needsProjectsImport(db)) {
          runProjectsImport({
            memoryDbPath: join(dirname(options.filename), 'memory-state.db'),
            coreDb: db,
            ...(options.sqlite ? { sqlite: options.sqlite } : {}),
            ...(options.logger ? { logger: options.logger } : {}),
          });
        }
      } catch (error) {
        options.logger?.({
          level: 'warn',
          category: 'database',
          message: 'Projects one-time import failed; it will retry on the next startup',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }

      this.stores = { ...stores, messageLog };
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}

/** The canonical migration list for the core database. */
export function collectCoreDatabaseMigrations(): Migration[] {
  return [
    ...MessageLog.migrations,
    ...collectCoreDataMigrations(),
  ].sort((a, b) => a.id - b.id);
}
