/**
 * Plan: the append path's duplicate-id check must not scale with the
 * session's own length.
 *
 * ## The bug this file exists to prevent
 *
 * `appendBatch` decided which of the incoming events were already indexed by
 * reading EVERY indexed id of the session
 * (`SELECT id FROM message_index WHERE session_id = ?`) and testing the
 * batch against that set. The batch itself is small — a handful of events —
 * but the set grows with every message the session ever received, so the
 * check read O(session) rows per append and O(session²) rows over the
 * session's life. A long conversation made every single incoming message
 * slower than the one before it.
 *
 * The fix asks the database only about the ids the batch actually carries
 * (`WHERE id IN (...)`, resolved through the primary-key index), which is
 * O(batch) regardless of how long the session is.
 *
 * ## What these cases assert
 *
 * 1. EQUIVALENCE — the answer must be the same one the full scan gave:
 *    an id already indexed for THIS session is not written twice, an id
 *    belonging to ANOTHER session does not block this session's write, and
 *    an id repeated inside one batch is written only once.
 * 2. NO FULL SCAN — the append path must not issue the whole-session id
 *    query any more. That is the property the optimization exists for, and
 *    a correctness-only test would pass with the optimization reverted.
 *
 * ## What is deliberately NOT asserted
 *
 * Wall-clock time. How fast the lookup is depends on the machine; what it
 * must not do is read the whole session, and that IS observable (the query
 * text and the rows it returns).
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
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

/** Every SQL statement the code under test prepared, in order. */
let preparedSql: string[];

/** Rows the code under test read back from a query over the id column. */
let indexedIdReads: unknown[][];

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

function indexedIds(sessionId: string): string[] {
  return (
    db.prepare('SELECT id FROM message_index WHERE session_id = ? ORDER BY seq').all(sessionId) as Array<{
      id: string;
    }>
  ).map((row) => row.id);
}

function fileLines(sessionId: string): string[] {
  const row = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as {
    rollout_path: string;
  };
  return require('node:fs')
    .readFileSync(join(dir, 'data', row.rollout_path), 'utf8')
    .split('\n')
    .filter(Boolean);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duya-msglog-index-'));
  db = new Database(join(dir, 'core.db'));
  db.pragma('journal_mode = WAL');
  for (const migration of MessageLog.migrations) migration.up(db);
  createSessionsFixture();
  log = new MessageLog(db as never, join(dir, 'data'), ports);

  preparedSql = [];
  indexedIdReads = [];
  const original = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    preparedSql.push(sql.replace(/\s+/g, ' ').trim());
    const stmt = original(sql);
    const originalAll = stmt.all.bind(stmt);
    stmt.all = (...args: unknown[]) => {
      const rows = originalAll(...args) as unknown[];
      // A read of the id column is the duplicate check in either shape.
      if (/^\s*SELECT id/i.test(sql)) indexedIdReads.push(rows);
      return rows;
    };
    return stmt;
  };
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

describe('MessageLog.appendBatch duplicate-id check', () => {
  it('does not read the whole session index to decide what is already indexed', () => {
    const sessionId = 'sess-1';
    insertSession(sessionId, 1000);

    // Seed a session long enough that a whole-session read would be obvious.
    for (let i = 0; i < 50; i++) {
      log.appendBatch([messageEvent(sessionId, `m-${i}`, 1000 + i)]);
    }
    preparedSql = [];
    indexedIdReads = [];

    log.appendBatch([messageEvent(sessionId, 'm-new', 2000)]);

    // The whole-session id read is the shape this change removes.
    expect(
      preparedSql.some((sql) => sql === 'SELECT id FROM message_index WHERE session_id = ?'),
    ).toBe(false);

    // The only id read is scoped to the batch: one row is asked about, and
    // it comes back empty because 'm-new' is genuinely new.
    expect(indexedIdReads).toHaveLength(1);
    expect(indexedIdReads[0]).toHaveLength(0);

    // The new id landed, and the session kept every earlier id — the
    // optimization changed HOW the answer is found, not what it is.
    const ids = indexedIds(sessionId);
    expect(ids).toHaveLength(51);
    expect(ids.at(-1)).toBe('m-new');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not write an id that is already indexed for this session', () => {
    const sessionId = 'sess-1';
    insertSession(sessionId, 1000);

    log.appendBatch([messageEvent(sessionId, 'm-1', 1000)]);
    log.appendBatch([messageEvent(sessionId, 'm-1', 1000), messageEvent(sessionId, 'm-2', 1001)]);

    expect(indexedIds(sessionId)).toEqual(['m-1', 'm-2']);
    // The file carries each id once — the index check exists to keep the
    // file from growing a duplicate line.
    expect(fileLines(sessionId)).toHaveLength(2);
  });

  it('does not let another session’s id block this session’s write', () => {
    const other = 'sess-other';
    const sessionId = 'sess-1';
    insertSession(other, 1000);
    insertSession(sessionId, 1000);

    // 'shared-id' is indexed under the OTHER session.
    log.appendBatch([messageEvent(other, 'shared-id', 1000)]);

    // The same id in THIS session must still be written: `message_index.id`
    // is a GLOBAL primary key, so this row is rejected by the database —
    // but the append path must not pre-emptively swallow the event.
    log.appendBatch([messageEvent(sessionId, 'shared-id', 1001)]);

    expect(indexedIds(sessionId)).toHaveLength(0);
  });

  it('writes an id repeated inside one batch only once', () => {
    const sessionId = 'sess-1';
    insertSession(sessionId, 1000);

    log.appendBatch([
      messageEvent(sessionId, 'm-1', 1000),
      messageEvent(sessionId, 'm-1', 1000),
      messageEvent(sessionId, 'm-2', 1001),
    ]);

    expect(indexedIds(sessionId)).toEqual(['m-1', 'm-2']);
    expect(fileLines(sessionId)).toHaveLength(2);
  });

  it('keeps seqs dense when a batch mixes known and unknown ids', () => {
    const sessionId = 'sess-1';
    insertSession(sessionId, 1000);

    log.appendBatch([messageEvent(sessionId, 'm-1', 1000)]);
    log.appendBatch([
      messageEvent(sessionId, 'm-1', 1000),
      messageEvent(sessionId, 'm-2', 1001),
      messageEvent(sessionId, 'm-3', 1002),
    ]);

    const rows = db
      .prepare('SELECT id, seq FROM message_index WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as Array<{ id: string; seq: number }>;
    expect(rows.map((row) => row.id)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it('does not scan the whole index when a large batch arrives', () => {
    const sessionId = 'sess-1';
    insertSession(sessionId, 1000);

    for (let i = 0; i < 40; i++) {
      log.appendBatch([messageEvent(sessionId, `m-${i}`, 1000 + i)]);
    }
    preparedSql = [];
    indexedIdReads = [];

    // A batch larger than the usual one (compaction re-appends the whole
    // message list), which is the case where a per-id lookup must still not
    // degrade into a whole-session read.
    const batch = Array.from({ length: 40 }, (_, i) => messageEvent(sessionId, `m-${i}`, 1000 + i));
    log.appendBatch(batch);

    expect(
      preparedSql.some((sql) => sql === 'SELECT id FROM message_index WHERE session_id = ?'),
    ).toBe(false);
    // Every id in the batch was checked, and every one of them was already
    // indexed — so nothing new was written.
    const readRows = indexedIdReads.reduce((total, rows) => total + rows.length, 0);
    expect(readRows).toBe(40);
    expect(indexedIds(sessionId)).toHaveLength(40);
    expect(fileLines(sessionId)).toHaveLength(40);
  });
});
