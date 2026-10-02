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

import { resolveCoreDatabasePath, resolveDatabasePath, resolveRolloutRoot, resolveAttachmentsRoot } from '../config/boot-config';
import { getLogger, LogComponent } from '../logging/logger';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CoreDatabase,
  MessageLog,
  SessionStore,
  Mailbox,
  TaskStore,
  PermissionLedger,
  LockStore,
  GoalStore,
  SpawnEdgeStore,
  AttachmentStore,
  ModeStateStore,
  PendingWakeStore,
  ProjectStore,
  ResearchStore,
  ConductorStore,
  WorkflowRunStore,
  RunStore,
  LegacyImport,
  migrateLegacyArchivedRows,
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
  goals: GoalStore;
  spawnEdges: SpawnEdgeStore;
  attachments: AttachmentStore;
  modeState: ModeStateStore;
  /** Durable pending-wake markers (Plan 476 Phase 3 / Plan 500 P5.2). */
  wakes: PendingWakeStore;
  /** Project entity registry (plan 534 — migrated from memory-state). */
  projects: ProjectStore;
  /** Research subsystem store (Plan 423 — deep research). */
  research: ResearchStore;
  /** Conductor subsystem store (canvas/groups/widgets/elements/actions). */
  conductor: ConductorStore;
  /** Workflow run store (plan 552 Phase 4 — run metadata + snapshot blobs). */
  workflowRuns: WorkflowRunStore;
  /**
   * Reference Run store (plan 586 — `runs` + `run_events`).
   *
   * Distinct from `workflowRuns` on purpose: a workflow run is a library
   * feature, while a run here is the durable record of one agent turn. They
   * will eventually share a lineage (`parentRunId` already exists on the
   * manifest); until then two stores keep two different lifecycles from
   * sharing one table.
   */
  runs: RunStore;
}

let stores: CoreStores | null = null;

/**
 * Migrate rollout JSONL files from the previous location (`<databases>/sessions/`,
 * where the rollout root was `dirname(dbPath)`) to the Codex-style `~/.duya/sessions/`
 * layout. Idempotent: files already present at the destination are left untouched
 * and the source is only removed when the copy succeeded. A no-op when the old
 * and new roots coincide (e.g. a fresh install or already-migrated data).
 */
function migrateRolloutRoots(): void {
  const { dbPath } = resolveDatabasePath();
  const oldRoot = path.dirname(dbPath);
  const newRoot = resolveRolloutRoot();
  if (oldRoot === newRoot) return;

  const oldSessions = path.join(oldRoot, 'sessions');
  const newSessions = path.join(newRoot, 'sessions');
  if (!fs.existsSync(oldSessions)) return;

  const logger = getLogger();
  let moved = 0;
  let skipped = 0;
  const walk = (from: string, to: string): void => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        walk(src, dst);
        // Remove now-empty source dirs after their children are moved.
        try { fs.rmdirSync(src); } catch { /* best-effort */ }
      } else if (entry.isFile()) {
        if (fs.existsSync(dst)) {
          skipped += 1;
          continue;
        }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        moved += 1;
        try { fs.unlinkSync(src); } catch { /* best-effort */ }
      }
    }
  };
  walk(oldSessions, newSessions);
  logger.info(
    'Migrated rollout files to ~/.duya/sessions',
    { oldRoot, newRoot, moved, skipped },
    LogComponent.DB,
  );
}

/**
 * All migrations from the aggregates, sorted by id.
 *
 * Exported so the composition can be tested as the real thing. A test that
 * re-declared this list would pass while the real one drifted — and a drifted
 * list is precisely how a migration id collides and a column gets silently
 * skipped (`stores.ts`, "Duplicate core migration id 26").
 */
export function collectMigrations(): Migration[] {
  return [
    ...MessageLog.migrations,
    ...SessionStore.migrations,
    ...Mailbox.migrations,
    ...TaskStore.migrations,
    ...PermissionLedger.migrations,
    ...LockStore.migrations,
    ...GoalStore.migrations,
    ...SpawnEdgeStore.migrations,
    ...AttachmentStore.migrations,
    ...ModeStateStore.migrations,
    ...PendingWakeStore.migrations,
    ...ProjectStore.migrations,
    ...ResearchStore.migrations,
    ...ConductorStore.migrations,
    ...WorkflowRunStore.migrations,
    ...RunStore.migrations,
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
  const attachmentsRoot = resolveAttachmentsRoot();

  logger.info('Initializing core database', { filename, rolloutRoot, attachmentsRoot }, LogComponent.DB);

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
      goals: new GoalStore(db),
      spawnEdges: new SpawnEdgeStore(db),
      attachments: new AttachmentStore(db, attachmentsRoot),
      modeState: new ModeStateStore(db),
      wakes: new PendingWakeStore(db),
      projects: new ProjectStore(db),
      research: new ResearchStore(db),
      conductor: new ConductorStore(db),
      workflowRuns: new WorkflowRunStore(db),
      runs: new RunStore(db),
    };

    // Plan 329: auto-run the legacy import on first boot. Runs before any
    // session service accepts requests (initCoreDatabase precedes session
    // handlers in main.ts), so there is no concurrent-write window. Failures
    // are caught and logged — the marker is not written, so the import is
    // naturally retried on the next startup. A fresh user (no legacy file)
    // writes a `none@<ts>` marker so startup stops probing.
    try {
      // First relocate any rollout files written under the old
      // `<databases>/sessions/` layout to `~/.duya/sessions/` (Codex-style).
      migrateRolloutRoots();

      // Plan 582 (G1 follow-up, §8.1): re-file archive rows that Plan 549
      // wrote on the old single-file convention. Runs before any session
      // service accepts requests, so no archived session can be read in its
      // broken (empty-history) state. Idempotent, and a no-op for users with
      // nothing archived under 549.
      const archiveReport = migrateLegacyArchivedRows(db, rolloutRoot);
      for (const sessionId of archiveReport.migrated) {
        stores.messageLog.invalidateRolloutPathCache(sessionId);
      }

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
        { error: error instanceof Error ? error.message : String(error) },
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
