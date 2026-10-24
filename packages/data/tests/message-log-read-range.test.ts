/**
 * Plan: projecting a session must not open the rollout file once per
 * message.
 *
 * ## The bug this file exists to prevent
 *
 * `listBySession` reads one byte range per message, and the reader it
 * used opened and closed the rollout file for EVERY range. A session with
 * 8000 messages paid 8000 opens, 8000 reads and 8000 closes — two thirds
 * of those syscalls had nothing to do with the content.
 *
 * The reader now keeps one handle open for the whole projection.
 *
 * ## What these cases assert
 *
 * 1. THE COUNT — how many times the rollout file is opened while a
 *    session is projected. This is the property the optimization exists
 *    for, and a correctness-only test would pass with the optimization
 *    reverted.
 * 2. THE CONTENT — the projection still returns the same messages, in the
 *    same order, and still skips a corrupt line instead of failing.
 *
 * ## What is deliberately NOT asserted
 *
 * Wall-clock time. How fast the projection is depends on the machine; what
 * it must not do is open the file per message, and that IS observable.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const counters = vi.hoisted(() => ({ openSync: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const patched = {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      counters.openSync += 1;
      return actual.openSync(...args);
    },
  };
  return { ...patched, default: patched };
});

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
let log: InstanceType<typeof MessageLog>;

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

function rolloutFile(sessionId: string): string {
  const row = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as {
    rollout_path: string;
  };
  return join(dir, 'data', row.rollout_path);
}

beforeEach(() => {
  counters.openSync = 0;
  dir = mkdtempSync(join(tmpdir(), 'duya-msglog-read-'));
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

describe('MessageLog.listBySession file handle use', () => {
  it('opens the rollout file once for a whole session, not once per message', () => {
    const sessionId = 'sess-1';
    const base = Date.UTC(2026, 9, 25, 8, 0, 0);
    insertSession(sessionId, base);

    const total = 25;
    for (let i = 0; i < total; i++) {
      log.appendBatch([messageEvent(sessionId, `m-${i}`, base + i * 1000)]);
    }

    counters.openSync = 0;
    const rows = log.listBySession(sessionId);

    expect(rows).toHaveLength(total);
    // One handle for the whole projection — the reads happen on it, the
    // file is not reopened per message.
    expect(counters.openSync).toBe(1);
  });

  it('returns the same messages in the same order as the append order', () => {
    const sessionId = 'sess-1';
    const base = Date.UTC(2026, 9, 25, 8, 0, 0);
    insertSession(sessionId, base);

    for (let i = 0; i < 5; i++) {
      log.appendBatch([messageEvent(sessionId, `m-${i}`, base + i * 1000)]);
    }

    const rows = log.listBySession(sessionId);
    expect(rows.map((row) => row.id)).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4']);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('still skips a corrupt line instead of failing the projection', () => {
    const sessionId = 'sess-1';
    const base = Date.UTC(2026, 9, 25, 8, 0, 0);
    insertSession(sessionId, base);

    log.appendBatch([messageEvent(sessionId, 'm-1', base)]);
    log.appendBatch([messageEvent(sessionId, 'm-2', base + 1000)]);
    log.appendBatch([messageEvent(sessionId, 'm-3', base + 2000)]);

    // Corrupt the middle line on disk: the index still points at it, but
    // the bytes are no longer parseable. The replacement keeps the line's
    // byte length, so the offsets of the lines after it still point at the
    // right bytes — only the corrupt line itself is lost.
    const file = rolloutFile(sessionId);
    const original = require('node:fs').readFileSync(file, 'utf8') as string;
    const lines = original.split('\n');
    const corrupt = lines[1]!;
    lines[1] = '{' + 'x'.repeat(Math.max(0, corrupt.length - 2)) + '}';
    writeFileSync(file, lines.join('\n'), 'utf8');

    const rows = log.listBySession(sessionId);
    expect(rows.map((row) => row.id)).toEqual(['m-1', 'm-3']);
  });

  it('keeps the index and returns empty when the rollout file is gone', () => {
    const sessionId = 'sess-1';
    const base = Date.UTC(2026, 9, 25, 8, 0, 0);
    insertSession(sessionId, base);

    log.appendBatch([messageEvent(sessionId, 'm-1', base)]);
    require('node:fs').rmSync(rolloutFile(sessionId));

    // A missing file must not take the index with it.
    expect(log.listBySession(sessionId)).toEqual([]);
    expect(log.getCount(sessionId)).toBe(1);
  });
});
