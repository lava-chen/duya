/**
 * core-connection.ts — CoreDatabase singleton lifecycle for the Electron
 * main process. Initialized right after `initDatabaseFromBoot()` in main.ts.
 *
 * The core store (`duya-core.db` + rollout files) holds the six core
 * aggregates (messages, sessions, mailbox, tasks, permissions, locks).
 * The legacy `duya-main.db` stays for subsystem tables (conductor, research,
 * gateway, etc.) until those are migrated in follow-up plans.
 *
 * See `docs/design-docs/2026-08-06-core-database-architecture.md` and
 * `docs/exec-plans/active/328-core-db-electron-wiring.md` Phase 1.
 */

import { resolveCoreDatabasePath, resolveDatabasePath, resolveRolloutRoot } from '../config/boot-config';
import { getLogger, LogComponent } from '../logging/logger';
import {
  CoreDatabase,
  MessageLog,
  SessionStore,
  Mailbox,
  TaskStore,
  PermissionLedger,
  LockStore,
  LegacyImport,
  type SqliteCtor,
  type Migration,
} from './core';
import { isSafeMode } from './connection';

export interface CoreStores {
  coreDb: CoreDatabase;
  messageLog: MessageLog;
  sessions: SessionStore;
  mailbox: Mailbox;
  tasks: TaskStore;
  permissions: PermissionLedger;
  locks: LockStore;
}

let stores: CoreStores | null = null;

/** All migrations from the six aggregates, sorted by id. */
function collectMigrations(): Migration[] {
  return [
    ...MessageLog.migrations,
    ...SessionStore.migrations,
    ...Mailbox.migrations,
    ...TaskStore.migrations,
    ...PermissionLedger.migrations,
    ...LockStore.migrations,
  ].sort((a, b) => a.id - b.id);
}

/**
 * Initialize the core database + stores. Idempotent — returns the existing
 * singleton on repeated calls. In safe mode (legacy DB failed to init), this
 * also degrades: stores stay null and `getCoreStores()` throws.
 */
export function initCoreDatabase(sqlite: SqliteCtor): CoreStores | null {
  if (stores) return stores;
  if (isSafeMode()) {
    getLogger().warn(
      'Core database skipped — legacy DB in safe mode',
      undefined,
      LogComponent.DB,
    );
    return null;
  }

  const logger = getLogger();
  const filename = resolveCoreDatabasePath();
  const rolloutRoot = resolveRolloutRoot();

  logger.info('Initializing core database', { filename, rolloutRoot }, LogComponent.DB);

  try {
    const coreDb = new CoreDatabase({
      filename,
      sqlite,
      migrations: collectMigrations(),
    });
    const db = coreDb.db;

    stores = {
      coreDb,
      messageLog: new MessageLog(db, rolloutRoot),
      sessions: new SessionStore(db),
      mailbox: new Mailbox(db),
      tasks: new TaskStore(db),
      permissions: new PermissionLedger(db),
      locks: new LockStore(db),
    };

    // Plan 329: auto-run the legacy import on first boot. Runs before any
    // session service accepts requests (initCoreDatabase precedes session
    // handlers in main.ts), so there is no concurrent-write window. Failures
    // are caught and logged — the marker is not written, so the import is
    // naturally retried on the next startup. A fresh user (no legacy file)
    // writes a `none@<ts>` marker so startup stops probing.
    try {
      const impl = new LegacyImport(stores, resolveDatabasePath().dbPath, sqlite);
      if (impl.needsImport()) {
        const report = impl.run();
        logger.info(
          'Legacy import completed',
          {
            sessions: report.sessions,
            events: report.events,
            mailboxItems: report.mailboxItems,
            tasks: report.tasks,
            permissions: report.permissions,
            locks: report.locks,
            renumberedSessions: report.renumberedSessions,
            durationMs: report.durationMs,
          },
          LogComponent.DB,
        );
      }
    } catch (error) {
      logger.warn(
        'Legacy import failed (will retry on next startup)',
        error instanceof Error ? error : new Error(String(error)),
        LogComponent.DB,
      );
    }

    logger.info('Core database initialized', undefined, LogComponent.DB);
    return stores;
  } catch (error) {
    logger.error(
      'Core database initialization failed',
      error instanceof Error ? error : new Error(String(error)),
      { filename },
      LogComponent.DB,
    );
    return null;
  }
}

/**
 * Get the initialized core stores. Throws if not yet initialized (safe mode
 * or init failure) — callers that can tolerate absence should check
 * `getCoreStoresOrNull()` instead.
 */
export function getCoreStores(): CoreStores {
  if (!stores) {
    throw new Error('Core stores not initialized — call initCoreDatabase() first');
  }
  return stores;
}

/** Safe accessor — returns null when core stores are unavailable. */
export function getCoreStoresOrNull(): CoreStores | null {
  return stores;
}

/**
 * Close the core database (graceful shutdown). Idempotent.
 */
export function closeCoreDatabase(): void {
  if (!stores) return;
  stores.coreDb.close();
  stores = null;
}

/**
 * Test-only: inject core stores without running the full init sequence.
 * Used by CLI/handler unit tests that need to exercise `getCoreStores()`
 * without booting the entire Electron main process. Pass `null` to reset
 * (mirrors the `setDb(null)` pattern in `connection.ts`).
 */
export function _setCoreStoresForTesting(s: CoreStores | null): void {
  stores = s;
}
