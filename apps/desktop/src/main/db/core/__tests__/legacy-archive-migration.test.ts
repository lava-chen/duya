/**
 * Plan 582 (G1 follow-up, §8.1) — normalize archive rows that Plan 549 wrote.
 *
 * Plan 549 archived one file to `archived/<date>/<basename>` and recorded that
 * FILE in `sessions.archived_path`, while leaving `sessions.rollout_path`
 * pointing at the pre-archive path. Two things are wrong with such a row under
 * the Plan 582 G1 convention, and both are asserted here against the real
 * filesystem and a real SQLite schema:
 *
 *   1. The archived session reads as EMPTY. `rollout_path` no longer resolves,
 *      and `MessageLog.findRolloutFileBySessionId` only scans
 *      `<root>/sessions` — never `archived/` — so drift recovery finds no
 *      candidate and `listBySession` returns nothing.
 *   2. Unarchiving would restore the file to `<rolloutRoot>/<basename>`,
 *      because stripping `archived/<date>/` leaves only a basename.
 *
 * `migrateLegacyArchivedRows` re-files the rollout into the mirrored location
 * and rewrites both columns, which fixes (1) outright and reduces (2) to the
 * ordinary prefix strip with no special case.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SqliteDatabase } from '../database';
import { MessageLog, type NewEvent } from '../message-log';
import { formatArchiveDate, resolveUnarchivedPath } from '../archive-paths';
import { migrateLegacyArchivedRows, recoverOriginalRel } from '../legacy-archive-migration';

const ARCHIVE_DAY = Date.UTC(2026, 8, 18, 14, 30, 0);
const ARCHIVE_BUCKET = formatArchiveDate(ARCHIVE_DAY);

function createSessionsFixture(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE sessions (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL DEFAULT 'New Chat',
      working_directory TEXT NOT NULL DEFAULT '',
      project_name      TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'active',
      model             TEXT NOT NULL DEFAULT '',
      provider_id       TEXT NOT NULL DEFAULT 'env',
      mode              TEXT NOT NULL DEFAULT 'code',
      permission_mode   TEXT NOT NULL DEFAULT 'default',
      agent_profile_id  TEXT,
      parent_session_id TEXT,
      agent_type        TEXT NOT NULL DEFAULT 'main',
      agent_name        TEXT NOT NULL DEFAULT '',
      agent_id          TEXT,
      draft             TEXT,
      extensions        TEXT NOT NULL DEFAULT '{}',
      rollout_path      TEXT,
      archived_at       INTEGER,
      archived_path     TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      generation        INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function makeUserMessage(id: string, text: string, createdAt: number) {
  return {
    id,
    type: 'message' as const,
    parentId: null,
    message: {
      role: 'user' as const,
      id,
      content: text,
      timestamp: createdAt,
      visibility: 'visible' as const,
    },
    createdAt,
  };
}

function makeEvent(sessionId: string, payload: ReturnType<typeof makeUserMessage>): NewEvent {
  return {
    id: payload.id,
    sessionId,
    turnId: null,
    payload,
    createdAt: payload.createdAt,
  };
}

describe('Plan 582 §8.1 — legacy archive migration', () => {
  let tempDir: string;
  let rootDir: string;
  let db: SqliteDatabase;
  let log: MessageLog;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-legacy-archive-'));
    rootDir = path.join(tempDir, 'data');
    fs.mkdirSync(rootDir, { recursive: true });
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    for (const m of MessageLog.migrations) m.up(db);
    createSessionsFixture(db);
    log = new MessageLog(db, rootDir);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function insertSession(id: string, createdAt: number): void {
    db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      id,
      id,
      createdAt,
      createdAt,
    );
  }

  function rowOf(sessionId: string): { status: string; rolloutPath: string | null; archivedPath: string | null } {
    const r = db
      .prepare('SELECT status, rollout_path AS rolloutPath, archived_path AS archivedPath FROM sessions WHERE id = ?')
      .get(sessionId) as { status: string; rolloutPath: string | null; archivedPath: string | null };
    return r;
  }

  /** Plan 549 recorded a single FILE, and left `rollout_path` untouched. */
  function archiveThe549Way(sessionId: string, when: number): { originalRel: string; legacyRel: string } {
    // `MessageLog` stores `rollout_path` with native separators (backslashes on
    // Windows), so normalize before taking the basename — otherwise the "legacy"
    // path would keep the whole date tree and collide with its own migration
    // target instead of reproducing Plan 549's basename-only layout.
    const originalRel = rowOf(sessionId).rolloutPath!.split(path.sep).join('/');
    const legacyRel = `archived/${formatArchiveDate(when)}/${path.posix.basename(originalRel)}`;
    const legacyAbs = path.join(rootDir, legacyRel);
    fs.mkdirSync(path.dirname(legacyAbs), { recursive: true });
    fs.renameSync(path.join(rootDir, originalRel), legacyAbs);
    db.prepare(
      'UPDATE sessions SET status = ?, archived_at = ?, archived_path = ? WHERE id = ?',
    ).run('archived', when, legacyRel, sessionId);
    log.invalidateRolloutPathCache(sessionId);
    return { originalRel, legacyRel };
  }

  /** Write `count` messages and return the session's rollout-relative path. */
  function seedHistory(sessionId: string, createdAt: number, count: number): string {
    insertSession(sessionId, createdAt);
    log.appendBatch(
      Array.from({ length: count }, (_, i) =>
        makeEvent(sessionId, makeUserMessage(`${sessionId}-m-${i}`, `msg ${i}`, createdAt + i)),
      ),
    );
    log.invalidateRolloutPathCache(sessionId);
    return rowOf(sessionId).rolloutPath!.split(path.sep).join('/');
  }

  it('a Plan 549 archive row reads as empty history — the bug being fixed', () => {
    const sessionId = 'legacy-empty';
    const created = Date.UTC(2026, 8, 1, 10, 0, 0);
    seedHistory(sessionId, created, 2);
    expect(log.listBySession(sessionId).map((e) => e.id)).toEqual([`${sessionId}-m-0`, `${sessionId}-m-1`]);

    archiveThe549Way(sessionId, ARCHIVE_DAY);

    // The file really is on disk, just at the Plan 549 archive location.
    expect(fs.existsSync(path.join(rootDir, rowOf(sessionId).archivedPath!))).toBe(true);
    // ...and the session is invisible, because recovery never scans `archived/`.
    expect(log.listBySession(sessionId)).toEqual([]);
  });

  it('migrates a Plan 549 row to the mirrored layout and restores its history', () => {
    const sessionId = 'legacy-mirror';
    const created = Date.UTC(2026, 8, 1, 10, 0, 0);
    seedHistory(sessionId, created, 3);
    const { originalRel, legacyRel } = archiveThe549Way(sessionId, ARCHIVE_DAY);

    const report = migrateLegacyArchivedRows(db, rootDir, ARCHIVE_DAY);

    expect(report.migrated).toEqual([sessionId]);
    expect(report.skipped).toEqual([]);

    // The file moved into the mirrored location, inside the SAME bucket.
    const expectedRel = `archived/${ARCHIVE_BUCKET}/${originalRel}`;
    expect(fs.existsSync(path.join(rootDir, expectedRel))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, legacyRel))).toBe(false);

    // Both columns now match what a fresh G1 archive would have written.
    const row = rowOf(sessionId);
    expect(row.rolloutPath).toBe(expectedRel);
    expect(row.archivedPath).toBe(path.posix.dirname(expectedRel));

    // And the user-visible symptom is gone: the archived session has history.
    log.invalidateRolloutPathCache(sessionId);
    expect(log.listBySession(sessionId).map((e) => e.id)).toEqual([
      `${sessionId}-m-0`,
      `${sessionId}-m-1`,
      `${sessionId}-m-2`,
    ]);
  });

  it('a migrated row unarchives back to the exact original path', () => {
    const sessionId = 'legacy-roundtrip';
    const created = Date.UTC(2026, 8, 1, 10, 0, 0);
    const originalRel = seedHistory(sessionId, created, 1);
    archiveThe549Way(sessionId, ARCHIVE_DAY);

    migrateLegacyArchivedRows(db, rootDir, ARCHIVE_DAY);

    // Walk the real unarchive path: read the recorded directory, then invert
    // each archived rel with the production prefix strip. This is the
    // property Plan 582 G1 was built for — that the archive mapping is exactly
    // invertible — and it only holds for migrated rows.
    const { archivedPath } = rowOf(sessionId);
    const dirAbs = path.join(rootDir, archivedPath!);
    const files = fs.readdirSync(dirAbs).filter((name) => name.endsWith('.jsonl'));
    expect(files).toHaveLength(1);

    const restoredRels = files.map((name) => {
      const archivedRel = path.posix.join(...(archivedPath! as string).split('/'), name);
      const restoredRel = resolveUnarchivedPath(archivedRel);
      fs.mkdirSync(path.join(rootDir, path.posix.dirname(restoredRel)), { recursive: true });
      fs.renameSync(path.join(dirAbs, name), path.join(rootDir, restoredRel));
      return restoredRel;
    });

    expect(restoredRels).toEqual([originalRel]);
    expect(fs.existsSync(path.join(rootDir, originalRel))).toBe(true);
  });

  it('leaves rows already on the directory convention untouched', () => {
    const sessionId = 'current-shape';
    const created = Date.UTC(2026, 8, 1, 10, 0, 0);
    const originalRel = seedHistory(sessionId, created, 1);

    // What Plan 582 G1 writes: mirrored path, directory in `archived_path`.
    const mirroredRel = `archived/${ARCHIVE_BUCKET}/${originalRel}`;
    const mirroredAbs = path.join(rootDir, mirroredRel);
    fs.mkdirSync(path.dirname(mirroredAbs), { recursive: true });
    fs.renameSync(path.join(rootDir, originalRel), mirroredAbs);
    db.prepare(
      'UPDATE sessions SET status = ?, archived_at = ?, archived_path = ?, rollout_path = ? WHERE id = ?',
    ).run('archived', ARCHIVE_DAY, path.posix.dirname(mirroredRel), mirroredRel, sessionId);

    const report = migrateLegacyArchivedRows(db, rootDir, ARCHIVE_DAY);

    expect(report.migrated).toEqual([]);
    expect(report.alreadyCurrent).toBe(1);
    expect(fs.existsSync(mirroredAbs)).toBe(true);
  });

  it('is idempotent — a second run finds nothing to do', () => {
    const sessionId = 'legacy-idempotent';
    const created = Date.UTC(2026, 8, 1, 10, 0, 0);
    seedHistory(sessionId, created, 1);
    archiveThe549Way(sessionId, ARCHIVE_DAY);

    const first = migrateLegacyArchivedRows(db, rootDir, ARCHIVE_DAY);
    const afterFirst = rowOf(sessionId);
    const second = migrateLegacyArchivedRows(db, rootDir, ARCHIVE_DAY);

    expect(first.migrated).toEqual([sessionId]);
    expect(second.migrated).toEqual([]);
    expect(second.alreadyCurrent).toBe(1);
    expect(rowOf(sessionId)).toEqual(afterFirst);
  });

  it('skips a row whose archived file is gone, leaving the row intact', () => {
    const sessionId = 'legacy-missing';
    const created = Date.UTC(2026, 8, 1, 10, 0, 0);
    seedHistory(sessionId, created, 1);
    const { legacyRel } = archiveThe549Way(sessionId, ARCHIVE_DAY);
    fs.rmSync(path.join(rootDir, legacyRel));

    const before = rowOf(sessionId);
    const report = migrateLegacyArchivedRows(db, rootDir, ARCHIVE_DAY);

    expect(report.migrated).toEqual([]);
    expect(report.skipped).toEqual([{ sessionId, reason: 'archived_file_missing' }]);
    expect(rowOf(sessionId)).toEqual(before);
  });

  it('never overwrites an existing file at the mirrored destination', () => {
    const sessionId = 'legacy-collision';
    const created = Date.UTC(2026, 8, 1, 10, 0, 0);
    const originalRel = seedHistory(sessionId, created, 1);
    archiveThe549Way(sessionId, ARCHIVE_DAY);

    // Something already occupies the destination the migration would pick.
    const targetAbs = path.join(rootDir, `archived/${ARCHIVE_BUCKET}/${originalRel}`);
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    fs.writeFileSync(targetAbs, 'pre-existing\n', 'utf8');

    const before = rowOf(sessionId);
    const report = migrateLegacyArchivedRows(db, rootDir, ARCHIVE_DAY);

    expect(report.migrated).toEqual([]);
    expect(report.skipped).toEqual([{ sessionId, reason: 'destination_taken' }]);
    expect(fs.readFileSync(targetAbs, 'utf8')).toBe('pre-existing\n');
    expect(rowOf(sessionId)).toEqual(before);
  });

  it('skips a row with no recoverable rollout_path instead of guessing', () => {
    const sessionId = 'legacy-unrecoverable';
    const created = Date.UTC(2026, 8, 1, 10, 0, 0);
    seedHistory(sessionId, created, 1);
    archiveThe549Way(sessionId, ARCHIVE_DAY);
    db.prepare('UPDATE sessions SET rollout_path = NULL WHERE id = ?').run(sessionId);

    const before = rowOf(sessionId);
    const report = migrateLegacyArchivedRows(db, rootDir, ARCHIVE_DAY);

    expect(report.migrated).toEqual([]);
    expect(report.skipped).toEqual([{ sessionId, reason: 'rollout_path_unrecoverable' }]);
    expect(rowOf(sessionId)).toEqual(before);
  });

  describe('recoverOriginalRel', () => {
    it('returns a stored relative path unchanged', () => {
      expect(recoverOriginalRel('sessions/2026/09/18/rollout-x.jsonl', '/root')).toBe(
        'sessions/2026/09/18/rollout-x.jsonl',
      );
    });

    it('normalizes an absolute path that lives under the rollout root', () => {
      const abs = path.join('/root', 'agents', 'a1', 'sessions', 'active.jsonl');
      expect(recoverOriginalRel(abs, path.join('/root'))).toBe('agents/a1/sessions/active.jsonl');
    });

    it('rejects a path outside the rollout root', () => {
      expect(recoverOriginalRel(path.join('/elsewhere', 'x.jsonl'), path.join('/root'))).toBeNull();
    });

    it('rejects a path that is already inside the archive tree', () => {
      expect(recoverOriginalRel('archived/2026-09-18/sessions/x.jsonl', '/root')).toBeNull();
    });

    it('rejects an empty rollout_path', () => {
      expect(recoverOriginalRel(null, '/root')).toBeNull();
      expect(recoverOriginalRel('', '/root')).toBeNull();
    });
  });
});
