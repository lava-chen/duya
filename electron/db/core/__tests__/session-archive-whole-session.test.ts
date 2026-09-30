/**
 * Plan 582 (G1) 鈥?archiving a ROTATED session must carry its whole history.
 *
 * Before this fix, `db:session:archive` moved exactly the one file named by
 * `sessions.rollout_path`. A session in the generation layout (every bot,
 * plus any human/cron session past NON_BOT_ROTATION_THRESHOLD_BYTES) keeps its
 * history in sibling `archive-<g>.jsonl` files next to `active.jsonl`, so
 * those siblings were stranded in the active tree. The row's new
 * `rollout_path` then pointed into a directory with no segments,
 * `listBySession` resolved zero history rows, and the archived session
 * silently lost everything written before the last rotation.
 *
 * These tests drive the real filesystem (no mocked `fs`) so the
 * move-everything behaviour is actually exercised.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SqliteDatabase } from '../database';
import { MessageLog, type NewEvent } from '../message-log';
import { archivedDirFor, resolveArchivedPath, resolveUnarchivedPath } from '../archive-paths';

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
    CREATE TABLE chat_sessions (
      id         TEXT PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function insertSession(db: SqliteDatabase, id: string, createdAt: number, alsoChatSession = false) {
  db.prepare(
    `INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(id, id, createdAt, createdAt);
  if (alsoChatSession) {
    db.prepare('INSERT INTO chat_sessions (id, generation) VALUES (?, 0)').run(id);
  }
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

function makeEvent(
  sessionId: string,
  payload: ReturnType<typeof makeUserMessage>,
  turnId: string | null = null,
): NewEvent {
  return {
    id: payload.id,
    sessionId,
    turnId,
    payload,
    createdAt: payload.createdAt,
  };
}

describe('Plan 582 G1 鈥?archive moves a whole session, not one file', () => {
  let tempDir: string;
  let rootDir: string;
  let db: SqliteDatabase;
  let log: MessageLog;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-archive-g1-'));
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

  /**
   * Mirror of the `db:session:archive` file move, without the IPC layer:
   * enumerate every rollout file, then move each to its mirrored archive
   * destination. Returns the destination dir recorded on the row.
   */
  function archiveAllFiles(sessionId: string, now: number): { dir: string; liveRel: string } {
    const files = log.collectSessionRolloutFiles(sessionId);
    const rels: string[] = [];
    for (const abs of files) {
      const rel = path.relative(rootDir, abs).split(path.sep).join('/');
      const archivedRel = resolveArchivedPath(rel, now);
      const archivedAbs = path.join(rootDir, archivedRel);
      fs.mkdirSync(path.dirname(archivedAbs), { recursive: true });
      fs.renameSync(abs, archivedAbs);
      rels.push(archivedRel);
    }
    const liveRel = rels[rels.length - 1];
    return { dir: archivedDirFor(liveRel), liveRel };
  }

  function unarchiveAllFiles(archivedDirRel: string): string[] {
    const dirAbs = path.join(rootDir, archivedDirRel);
    // Mirrors `collectJsonlFiles` in db-handlers: archive-<g> by generation,
    // then active.jsonl, then any other .jsonl (a never-rotated session keeps
    // its original `rollout-*` name).
    const rank = (name: string): number => {
      if (/^archive-\d+\.jsonl$/.test(name)) return 0;
      if (name === 'active.jsonl') return 1;
      return 2;
    };
    const names = fs
      .readdirSync(dirAbs)
      .filter((n) => n.endsWith('.jsonl'))
      .sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (ra === 0) {
          return (
            Number(a.match(/^archive-(\d+)\.jsonl$/)![1]) -
            Number(b.match(/^archive-(\d+)\.jsonl$/)![1])
          );
        }
        return a.localeCompare(b);
      });
    const restored: string[] = [];
    for (const name of names) {
      const srcAbs = path.join(dirAbs, name);
      const rel = path.relative(rootDir, srcAbs).split(path.sep).join('/');
      const restoredRel = resolveUnarchivedPath(rel);
      const restoredAbs = path.join(rootDir, restoredRel);
      fs.mkdirSync(path.dirname(restoredAbs), { recursive: true });
      fs.renameSync(srcAbs, restoredAbs);
      restored.push(restoredRel);
    }
    return restored;
  }

  it('collectSessionRolloutFiles returns every generation segment in order', () => {
    const agentId = 'gamma';
    const sessionId = `bot:${agentId}`;
    const t = Date.UTC(2026, 8, 1, 10, 0, 0);
    insertSession(db, sessionId, t, true);

    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'first', t)),
      makeEvent(sessionId, makeUserMessage('m-2', 'second', t + 10)),
    ]);
    log.rotateArchive(sessionId, 'compaction', t + 20);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-3', 'third', t + 30))]);

    const files = log.collectSessionRolloutFiles(sessionId).map((abs) => path.basename(abs));

    // The pre-fix archive handler moved only the last entry 鈥?this is the
    // assertion that says "there is more than one file to move".
    expect(files).toEqual(['archive-0.jsonl', 'active.jsonl']);
  });

  it('a rotated session keeps its full history after archiving', () => {
    const agentId = 'delta';
    const sessionId = `bot:${agentId}`;
    const t = Date.UTC(2026, 8, 1, 10, 0, 0);
    insertSession(db, sessionId, t, true);

    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'first', t)),
      makeEvent(sessionId, makeUserMessage('m-2', 'second', t + 10)),
    ]);
    log.rotateArchive(sessionId, 'compaction', t + 20);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-3', 'third', t + 30))]);

    const before = log.listBySession(sessionId);
    expect(before.map((e) => e.id)).toEqual(['m-1', 'm-2', 'm-3']);

    const now = Date.UTC(2026, 8, 18, 14, 30, 0);
    const { dir, liveRel } = archiveAllFiles(sessionId, now);

    // The row is repointed at the archived live file, so the session stays
    // readable while archived.
    db.prepare('UPDATE sessions SET rollout_path = ? WHERE id = ?').run(liveRel, sessionId);
    log.invalidateRolloutPathCache(sessionId);

    const after = log.listBySession(sessionId);
    expect(after.map((e) => e.id)).toEqual(['m-1', 'm-2', 'm-3']);

    // No segment was left behind in the active tree. (The now-empty directory
    // itself may remain — the invariant is that no rollout file survives
    // outside the archive, not that the folder is pruned.)
    const activeDir = path.join(rootDir, 'agents', agentId, 'sessions');
    const leftover = fs.existsSync(activeDir)
      ? fs.readdirSync(activeDir).filter((n) => n.endsWith('.jsonl'))
      : [];
    expect(leftover).toEqual([]);
    expect(fs.existsSync(path.join(rootDir, dir))).toBe(true);
  });

  it('archive 鈫?unarchive round-trips a rotated session with history intact', () => {
    const agentId = 'epsilon';
    const sessionId = `bot:${agentId}`;
    const t = Date.UTC(2026, 8, 1, 10, 0, 0);
    insertSession(db, sessionId, t, true);

    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'first', t)),
      makeEvent(sessionId, makeUserMessage('m-2', 'second', t + 10)),
    ]);
    log.rotateArchive(sessionId, 'compaction', t + 20);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-3', 'third', t + 30))]);
    const before = log.listBySession(sessionId).map((e) => e.id);

    const now = Date.UTC(2026, 8, 18, 14, 30, 0);
    const { dir, liveRel } = archiveAllFiles(sessionId, now);
    db.prepare('UPDATE sessions SET rollout_path = ? WHERE id = ?').run(liveRel, sessionId);
    log.invalidateRolloutPathCache(sessionId);

    const restored = unarchiveAllFiles(dir);
    const restoredLive = restored[restored.length - 1];
    db.prepare('UPDATE sessions SET rollout_path = ? WHERE id = ?').run(restoredLive, sessionId);
    log.invalidateRolloutPathCache(sessionId);

    const after = log.listBySession(sessionId).map((e) => e.id);
    expect(after).toEqual(before);
    // Back in the original bot directory.
    expect(restoredLive).toBe(`agents/${agentId}/sessions/active.jsonl`);
  });

  it('two bot sessions archived on the same day do not collide', () => {
    const now = Date.UTC(2026, 8, 18, 14, 30, 0);
    const dirs: string[] = [];
    for (const agentId of ['one', 'two']) {
      const sessionId = `bot:${agentId}`;
      const t = Date.UTC(2026, 8, 1, 10, 0, 0);
      insertSession(db, sessionId, t, true);
      log.appendBatch([makeEvent(sessionId, makeUserMessage(`m-${agentId}`, agentId, t))]);
      dirs.push(archiveAllFiles(sessionId, now).dir);
    }

    // Pre-fix both sessions resolved to `archived/<date>/active.jsonl`.
    expect(dirs[0]).not.toBe(dirs[1]);
    for (const dir of dirs) {
      expect(fs.existsSync(path.join(rootDir, dir, 'active.jsonl'))).toBe(true);
    }
  });

  it('a single-file session archives and restores to the exact original path', () => {
    const sessionId = 'human-1';
    const t = Date.UTC(2026, 8, 1, 10, 0, 0);
    insertSession(db, sessionId, t);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'hello', t))]);

    const before = log.collectSessionRolloutFiles(sessionId);
    expect(before).toHaveLength(1);
    const originalRel = path.relative(rootDir, before[0]).split(path.sep).join('/');

    const now = Date.UTC(2026, 8, 18, 14, 30, 0);
    const { dir, liveRel } = archiveAllFiles(sessionId, now);
    const restored = unarchiveAllFiles(dir);

    expect(restored[restored.length - 1]).toBe(originalRel);
  });
});

