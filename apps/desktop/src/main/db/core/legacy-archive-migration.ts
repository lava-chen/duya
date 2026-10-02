/**
 * legacy-archive-migration.ts — Plan 582 (G1 follow-up, §8.1).
 *
 * Plan 549 archived a session by moving exactly ONE file to
 * `archived/<date>/<basename>` and recording that file path in
 * `sessions.archived_path`. Plan 582 (G1) redefined archiving to mirror the
 * full rollout-relative path under `archived/<date>/<full rel>` and to record
 * the destination DIRECTORY, so that unarchive is a pure prefix strip.
 *
 * Rows written by 549 therefore violate the invariant G1 assumes, and two
 * user-visible things are wrong with them:
 *
 *   1. The archived session reads as EMPTY. 549 wrote `archived_path` but
 *      left `sessions.rollout_path` pointing at the pre-archive path, which no
 *      longer exists on disk. `MessageLog.findRolloutFileBySessionId` only
 *      scans `<rolloutRoot>/sessions` — never `archived/` — so the drift
 *      recovery finds no candidate, `listBySession` resolves nothing, and the
 *      session's history silently disappears from the archive view.
 *   2. Unarchiving lands the file in the wrong place. `resolveUnarchivedPath`
 *      strips `archived/<date>/` down to a bare basename, so the file is
 *      restored to `<rolloutRoot>/<basename>` instead of the date tree it came
 *      from.
 *
 * What makes this recoverable without guessing is 549's own handler: it never
 * touched `rollout_path`, so the original rollout-relative path is still on the
 * row. `recoverOriginalRel` reads it back and the file is re-filed into the
 * mirrored location, after which the row satisfies the same invariant as a
 * freshly archived one — the archived session is readable again and unarchive
 * is a lossless prefix strip with no special case.
 *
 * The transform is idempotent and self-healing: it only acts on rows whose
 * `archived_path` resolves to a FILE, so once a row is normalized a re-run
 * finds nothing to do. A fresh install has no archived rows at all and pays
 * one indexed SELECT. Run it from `initCoreDatabase`, next to
 * `migrateRolloutRoots()` and the legacy import.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger, LogComponent } from '../../logging/logger';
import type { SqliteDatabase } from './database';
import {
  archivedBucketDate,
  archivedDirFor,
  formatArchiveDate,
  resolveArchivedPathInBucket,
} from './archive-paths';

/** Why a Plan 549 row was left as-is. */
export type LegacyArchiveSkipReason =
  /** `archived_path` points at a file that is not on disk any more. */
  | 'archived_file_missing'
  /** The row carries no usable `rollout_path`, so the original path is unknown. */
  | 'rollout_path_unrecoverable'
  /** The mirrored destination already exists — never overwrite a live file. */
  | 'destination_taken'
  /** A rename or the row update failed; both disk and SQL were left consistent. */
  | 'io_error';

export interface LegacyArchiveSkip {
  sessionId: string;
  reason: LegacyArchiveSkipReason;
  detail?: string;
}

export interface LegacyArchiveMigrationReport {
  /** Sessions whose file was moved and whose columns were rewritten. */
  migrated: string[];
  /** Archived rows already on the G1 directory convention — left untouched. */
  alreadyCurrent: number;
  /** Rows deliberately not touched, with the reason. */
  skipped: LegacyArchiveSkip[];
}

/** A Plan 549 row, as read out of the `sessions` table. */
interface LegacyArchiveRow {
  id: string;
  archivedPath: string | null;
  rolloutPath: string | null;
  archivedAt: number | null;
}

/**
 * The rollout-relative path a Plan 549 row occupied before it was archived.
 *
 * Returns `null` when the original location cannot be established, which is
 * the caller's signal to leave the row alone rather than guess. Three cases
 * are rejected deliberately:
 *
 *   - `null` / empty: a non-null `archived_path` implies `rollout_path` was
 *     set at archive time, so this only reaches hand-edited or partially
 *     imported rows.
 *   - a path inside the archive tree: that is the G1 shape, not a 549 row —
 *     mirroring it again would nest `archived/archived/…`.
 *   - an absolute path that does not live under the rollout root: the row
 *     points outside the tree we are allowed to move files within.
 */
export function recoverOriginalRel(
  rolloutPath: string | null | undefined,
  rolloutRoot: string,
): string | null {
  if (!rolloutPath) return null;

  const native = path.isAbsolute(rolloutPath)
    ? path.relative(rolloutRoot, rolloutPath)
    : rolloutPath;
  if (!native || path.isAbsolute(native)) return null;

  const rel = native.split(path.sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../')) return null;
  if (rel === 'archived' || rel.startsWith('archived/')) return null;
  return rel;
}

/** `fs.statSync` that reports a vanished or unreadable entry as `null`. */
function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

/**
 * Re-file every Plan 549 archive row onto the G1 directory convention.
 *
 * For each row whose `archived_path` resolves to a FILE, the recorded
 * rollout-relative path is recovered, the file is renamed to the mirrored
 * destination inside the bucket it is already in, and both `archived_path`
 * (now the directory) and `rollout_path` (now the archived live file) are
 * rewritten to match what a fresh G1 archive produces.
 *
 * The rename happens before the UPDATE, and a failed UPDATE renames the file
 * back — the same "disk and SQL never disagree" guarantee the archive and
 * unarchive handlers make in `db-handlers.ts`.
 */
export function migrateLegacyArchivedRows(
  db: SqliteDatabase,
  rolloutRoot: string,
  now: number = Date.now(),
): LegacyArchiveMigrationReport {
  const logger = getLogger();
  const report: LegacyArchiveMigrationReport = { migrated: [], alreadyCurrent: 0, skipped: [] };

  let rows: LegacyArchiveRow[];
  try {
    rows = db
      .prepare(
        `SELECT id,
                archived_path AS archivedPath,
                rollout_path  AS rolloutPath,
                archived_at   AS archivedAt
           FROM sessions
          WHERE status = 'archived' AND archived_path IS NOT NULL`,
      )
      .all() as unknown as LegacyArchiveRow[];
  } catch (err) {
    logger.warn(
      'legacy archive migration: could not read archived sessions',
      { error: String(err) },
      LogComponent.DB,
    );
    return report;
  }
  if (rows.length === 0) return report;

  const updateRow = db.prepare('UPDATE sessions SET archived_path = ?, rollout_path = ? WHERE id = ?');

  for (const row of rows) {
    if (!row.archivedPath) continue;
    const archivedAbs = path.join(rolloutRoot, row.archivedPath);

    const stat = statOrNull(archivedAbs);
    if (!stat) {
      // Unarchive already degrades to a metadata-only status flip for a
      // missing archive, so there is nothing to re-file and nothing to fix.
      report.skipped.push({ sessionId: row.id, reason: 'archived_file_missing' });
      continue;
    }
    if (!stat.isFile()) {
      report.alreadyCurrent += 1;
      continue;
    }

    const originalRel = recoverOriginalRel(row.rolloutPath, rolloutRoot);
    if (!originalRel) {
      report.skipped.push({ sessionId: row.id, reason: 'rollout_path_unrecoverable' });
      continue;
    }

    // Stay in the bucket the file already sits in. Re-deriving the date from
    // `archived_at` would be equivalent in the normal case, but the recorded
    // path is the ground truth for where the bytes actually are.
    const bucket = archivedBucketDate(row.archivedPath) ?? formatArchiveDate(row.archivedAt ?? now);
    const targetRel = resolveArchivedPathInBucket(originalRel, bucket);
    const targetAbs = path.join(rolloutRoot, targetRel);

    if (fs.existsSync(targetAbs)) {
      report.skipped.push({ sessionId: row.id, reason: 'destination_taken' });
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.renameSync(archivedAbs, targetAbs);
    } catch (err) {
      report.skipped.push({ sessionId: row.id, reason: 'io_error', detail: String(err) });
      continue;
    }

    try {
      updateRow.run(archivedDirFor(targetRel), targetRel, row.id);
      report.migrated.push(row.id);
    } catch (err) {
      // Put the file back so the row's columns and the filesystem keep
      // describing the same session; a half-applied row is worse than none.
      try {
        fs.renameSync(targetAbs, archivedAbs);
      } catch (rollbackErr) {
        logger.error(
          'legacy archive migration: file moved but row update failed, and the rollback rename also failed',
          rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)),
          { sessionId: row.id, from: targetAbs, to: archivedAbs },
          LogComponent.DB,
        );
      }
      report.skipped.push({ sessionId: row.id, reason: 'io_error', detail: String(err) });
    }
  }

  if (report.migrated.length > 0 || report.skipped.length > 0) {
    logger.info(
      'legacy archive migration: normalized Plan 549 archive rows',
      {
        scanned: rows.length,
        migrated: report.migrated.length,
        alreadyCurrent: report.alreadyCurrent,
        skipped: report.skipped.length,
      },
      LogComponent.DB,
    );
  }
  for (const skip of report.skipped) {
    logger.warn(
      'legacy archive migration: row left on the Plan 549 convention',
      { sessionId: skip.sessionId, reason: skip.reason, detail: skip.detail },
      LogComponent.DB,
    );
  }

  return report;
}
