/**
 * Plan: the rollout file must land in the date bucket it belongs to — and
 * stay there while the session keeps writing.
 *
 * ## The bug this file exists to prevent
 *
 * `resolvePath` builds `sessions/<yyyy>/<mm>/<dd>/rollout-<stamp>-<id>.jsonl`
 * where `<stamp>` is a MILLISECOND-precision timestamp. `getOrCreateRolloutPath`
 * then decided "the path changed, so move the file" by comparing the whole
 * path against the recorded one. The stamp differs on every batch, so the
 * comparison was true on every batch: each append renamed the rollout file
 * and rewrote `sessions.rollout_path`.
 *
 * The intent, stated in the code that does the move, is a DATE BUCKET change
 * — a session that crosses midnight. The comparison was on the wrong
 * granularity.
 *
 * ## What these cases assert
 *
 * 1. STABILITY — appending again inside the same bucket must not touch the
 *    path, the file name, or the file. A session that is simply being used
 *    must not have its rollout renamed under it.
 * 2. STILL MOVES — a session that crosses midnight still moves to the new
 *    bucket, and a path in a layout this code does not recognise still moves
 *    exactly as it did before (it cannot be compared bucket-by-bucket, so it
 *    is treated as "different").
 * 3. THE COUNT — the number of path changes over a long run of appends. This
 *    is the property the optimization exists for, and a correctness-only test
 *    would pass with the comparison reverted.
 *
 * ## What is deliberately NOT asserted
 *
 * Wall-clock time. How fast the append is depends on the machine; what it
 * must not do is rename the file per batch, and that IS observable (the
 * recorded path and the file on disk).
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageLog, type NewEvent } from '../src/message-log';
import type { MessageLogPorts } from '../src/message-log-ports';

const ports: MessageLogPorts = {
  botSessionIdPrefix: 'bot:',
  parseBotSessionId: (sessionId) => (sessionId.startsWith('bot:') ? sessionId.slice(4) : null),
  getBotSessionsDir: () => '',
  getBotSessionLogPath: () => '',
};

let dir: string;
let db: Database.Database;
let log: MessageLog;

function createSessionsFixture(): void {
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
      created_at        INTEGER NOT NULL DEFAULT 0,
      updated_at        INTEGER NOT NULL DEFAULT 0,
      recency_at        INTEGER,
      last_turn_started_at INTEGER,
      rollout_path      TEXT
    );`);
}

function insertSession(id: string, createdAt: number): void {
  db.prepare('INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)').run(id, createdAt, createdAt);
}

function messageEvent(sessionId: string, id: string, createdAt: number): NewEvent {
  return {
    id,
    sessionId,
    turnId: null,
    payload: {
      type: 'message',
      id,
      parentId: null,
      createdAt,
      message: { role: 'user', id, content: `hello ${id}`, timestamp: createdAt, visibility: 'visible' },
    } as never,
    createdAt,
  };
}

function rolloutPath(sessionId: string): string {
  const row = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as {
    rollout_path: string | null;
  };
  return row.rollout_path ?? '';
}

function bucketOf(relativePath: string): string {
  return relativePath.split(/[\\/]/).slice(0, 4).join('/');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duya-msglog-bucket-'));
  db = new Database(join(dir, 'core.db'));
  db.pragma('journal_mode = WAL');
  for (const migration of MessageLog.migrations) migration.up(db);
  createSessionsFixture();
  log = new MessageLog(db as never, join(dir, 'data'), ports);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('MessageLog rollout date bucket', () => {
  it('keeps the rollout file in place while the session stays inside one bucket', () => {
    const sessionId = 'sess-1';
    const first = Date.UTC(2026, 9, 25, 8, 0, 0);
    const later = Date.UTC(2026, 9, 25, 19, 30, 0); // same day, hours later
    insertSession(sessionId, first);

    log.appendBatch([messageEvent(sessionId, 'm-1', first)]);
    const pathAfterFirst = rolloutPath(sessionId);
    const fileAfterFirst = join(dir, 'data', pathAfterFirst);
    expect(existsSync(fileAfterFirst)).toBe(true);

    log.appendBatch([messageEvent(sessionId, 'm-2', later)]);

    // The recorded path is untouched, and so is the file behind it.
    expect(rolloutPath(sessionId)).toBe(pathAfterFirst);
    expect(existsSync(fileAfterFirst)).toBe(true);

    // The message still landed — this is about the file's location, not
    // about writes being dropped.
    expect(log.getCount(sessionId)).toBe(2);
    const lines = readdirSync(join(dir, 'data', bucketOf(pathAfterFirst)));
    expect(lines).toHaveLength(1);
  });

  it('changes the recorded path once, not once per batch', () => {
    const sessionId = 'sess-1';
    const start = Date.UTC(2026, 9, 25, 8, 0, 0);
    insertSession(sessionId, start);

    let changes = 0;
    let last: string | null = null;
    for (let i = 0; i < 40; i++) {
      log.appendBatch([messageEvent(sessionId, `m-${i}`, start + i * 1000)]);
      const current = rolloutPath(sessionId);
      if (current !== last) changes += 1;
      last = current;
    }

    // One bucket for the whole run: the path is set once and stays.
    expect(changes).toBe(1);
    expect(log.getCount(sessionId)).toBe(40);
  });

  it('still moves the rollout to the new bucket when the session crosses midnight', () => {
    const sessionId = 'sess-1';
    const day1 = Date.UTC(2026, 9, 25, 23, 50, 0);
    const day2 = Date.UTC(2026, 9, 26, 0, 20, 0);
    insertSession(sessionId, day1);

    log.appendBatch([messageEvent(sessionId, 'm-1', day1)]);
    const firstPath = rolloutPath(sessionId);
    const firstFile = join(dir, 'data', firstPath);
    expect(bucketOf(firstPath)).toBe('sessions/2026/10/25');
    expect(existsSync(firstFile)).toBe(true);

    log.appendBatch([messageEvent(sessionId, 'm-2', day2)]);
    const movedPath = rolloutPath(sessionId);
    const movedFile = join(dir, 'data', movedPath);

    expect(bucketOf(movedPath)).toBe('sessions/2026/10/26');
    expect(existsSync(movedFile)).toBe(true);
    expect(existsSync(firstFile)).toBe(false);
    // The move carries the content, not just the name.
    expect(log.getCount(sessionId)).toBe(2);
  });

  it('still moves a rollout whose path is not in the bucketed layout', () => {
    const sessionId = 'sess-legacy';
    const createdAt = Date.UTC(2026, 9, 25, 8, 0, 0);
    insertSession(sessionId, createdAt);

    // A path from the older flat layout: it cannot be compared bucket by
    // bucket, so it must keep moving the way it always did.
    const legacyRel = 'sessions/rollout-legacy.jsonl';
    const legacyAbs = join(dir, 'data', legacyRel);
    mkdirSync(join(dir, 'data', 'sessions'), { recursive: true });
    writeFileSync(legacyAbs, '', 'utf8');
    db.prepare('UPDATE sessions SET rollout_path = ? WHERE id = ?').run(legacyRel, sessionId);

    log.appendBatch([messageEvent(sessionId, 'm-1', createdAt)]);

    const movedPath = rolloutPath(sessionId);
    expect(movedPath).not.toBe(legacyRel);
    expect(bucketOf(movedPath)).toBe('sessions/2026/10/25');
    expect(existsSync(join(dir, 'data', movedPath))).toBe(true);
    expect(existsSync(legacyAbs)).toBe(false);
  });
});
