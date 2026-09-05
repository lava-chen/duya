/**
 * MessageLog.listBySession source filter — Plan 489 P0.3
 *
 * The bot-direct chat surface (BotDirectChatView) is required to show
 * ONLY messages produced by SendMessage. The data-layer guarantee lives
 * in MessageLog.listBySession's `{source}` option: when the caller
 * passes `['send_message', 'user']` (or any subset), rows whose
 * `entry.source` is not in the list are dropped from the projected
 * timeline. CompactionEntry / RolloutEvent rows bypass the filter
 * because they carry no `source` field — they are not user-visible
 * anyway, but kept so audit / timeline endpoints still see them.
 *
 * better-sqlite3 may not load when DUYA.exe is running (ABI lock on
 * Windows). The probe below mirrors the convention used in
 * electron/ipc/__tests__/core-db-adapters-source.test.ts: when sqlite
 * is unavailable the test skips cleanly instead of erroring.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentMessage, MessageEntry } from '@duya/agent/message';
import { MessageLog, type NewEvent, type SqliteDatabase } from '../message-log';

let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  source: MessageEntry['source'],
  createdAt: number,
): MessageEntry {
  const msg: AgentMessage = {
    role,
    id,
    content: role === 'assistant' ? [{ type: 'text', text }] : text,
    timestamp: createdAt,
    visibility: 'visible',
    source,
  };
  return { type: 'message', id, parentId: null, createdAt, message: msg };
}

function makeEvent(sessionId: string, entry: MessageEntry): NewEvent {
  return {
    id: entry.id,
    sessionId,
    turnId: null,
    payload: entry,
    createdAt: entry.createdAt,
  };
}

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
      draft             TEXT,
      extensions        TEXT NOT NULL DEFAULT '{}',
      rollout_path      TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
  `);
}

function insertSession(db: SqliteDatabase, id: string, createdAt: number): void {
  db.prepare(
    'INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'BotDirect', 'active', createdAt, createdAt);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe.skipIf(!nativeSqliteAvailable)(
  'MessageLog.listBySession source filter (Plan 489 P0.3)',
  () => {
    let tempDir: string;
    let rootDir: string;
    let db: SqliteDatabase;
    let log: MessageLog;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msglog-source-test-'));
      rootDir = path.join(tempDir, 'data');
      fs.mkdirSync(rootDir, { recursive: true });
      db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      for (const m of MessageLog.migrations) m.up(db);
      createSessionsFixture(db);
      log = new MessageLog(db, rootDir);
    });

    afterEach(() => {
      try { db.close(); } catch { /* already closed */ }
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('returns all rows when no source allowlist is provided', () => {
      const sessionId = 'bot:agent1-abc';
      const createdAt = Date.UTC(2026, 8, 1, 0, 0, 0);
      insertSession(db, sessionId, createdAt);
      log.appendBatch([
        makeEvent(sessionId, makeMessage('u1', 'user', 'hi', 'user', createdAt + 1)),
        makeEvent(sessionId, makeMessage('a1', 'assistant', 'reply', 'send_message', createdAt + 2)),
        makeEvent(sessionId, makeMessage('t1', 'assistant', '', 'tool_use', createdAt + 3)),
        makeEvent(sessionId, makeMessage('th1', 'assistant', 'plan', 'thinking', createdAt + 4)),
      ]);
      const all = log.listBySession(sessionId);
      expect(all.map((r) => r.id)).toEqual(['u1', 'a1', 't1', 'th1']);
    });

    it('keeps ONLY source IN [send_message, user] when allowlist is set', () => {
      const sessionId = 'bot:agent1-abc';
      const createdAt = Date.UTC(2026, 8, 1, 0, 0, 0);
      insertSession(db, sessionId, createdAt);
      log.appendBatch([
        makeEvent(sessionId, makeMessage('u1', 'user', 'hi', 'user', createdAt + 1)),
        makeEvent(sessionId, makeMessage('a1', 'assistant', 'reply', 'send_message', createdAt + 2)),
        makeEvent(sessionId, makeMessage('t1', 'assistant', '', 'tool_use', createdAt + 3)),
        makeEvent(sessionId, makeMessage('th1', 'assistant', 'plan', 'thinking', createdAt + 4)),
        makeEvent(sessionId, makeMessage('s1', 'assistant', 'sys', 'system', createdAt + 5)),
        makeEvent(sessionId, makeMessage('sc1', 'assistant', 'scratch', 'scratchpad', createdAt + 6)),
      ]);
      const filtered = log.listBySession(sessionId, {
        source: ['send_message', 'user'],
      });
      const ids = filtered.map((r) => r.id);
      expect(ids).toEqual(['u1', 'a1']);
    });

    it('allows a strict send_message-only filter', () => {
      const sessionId = 'bot:agent1-abc';
      const createdAt = Date.UTC(2026, 8, 1, 0, 0, 0);
      insertSession(db, sessionId, createdAt);
      log.appendBatch([
        makeEvent(sessionId, makeMessage('u1', 'user', 'hi', 'user', createdAt + 1)),
        makeEvent(sessionId, makeMessage('a1', 'assistant', 'reply', 'send_message', createdAt + 2)),
      ]);
      const filtered = log.listBySession(sessionId, { source: ['send_message'] });
      expect(filtered.map((r) => r.id)).toEqual(['a1']);
    });

    it('returns [] for an empty allowlist (filter out everything)', () => {
      const sessionId = 'bot:agent1-abc';
      const createdAt = Date.UTC(2026, 8, 1, 0, 0, 0);
      insertSession(db, sessionId, createdAt);
      log.appendBatch([
        makeEvent(sessionId, makeMessage('u1', 'user', 'hi', 'user', createdAt + 1)),
      ]);
      const filtered = log.listBySession(sessionId, { source: [] });
      expect(filtered).toEqual([]);
    });
  },
);
