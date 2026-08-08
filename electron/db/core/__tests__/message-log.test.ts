import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MessageEntry, CompactionEntry, AgentMessage } from '@duya/agent/message';
import { MessageLog, type NewEvent } from '../message-log';
import type { SqliteDatabase } from '../database';

// ─── Test fixtures ───

function makeUserMessage(id: string, text: string, createdAt: number): MessageEntry {
  const msg: AgentMessage = {
    role: 'user',
    id,
    content: text,
    timestamp: createdAt,
    visibility: 'visible',
  };
  return { type: 'message', id, parentId: null, createdAt, message: msg };
}

function makeAssistantMessage(id: string, text: string, createdAt: number): MessageEntry {
  const msg: AgentMessage = {
    role: 'assistant',
    id,
    content: [{ type: 'text', text }],
    timestamp: createdAt,
    visibility: 'visible',
  };
  return { type: 'message', id, parentId: null, createdAt, message: msg };
}

function makeCompactionEntry(id: string, summary: string, createdAt: number): CompactionEntry {
  return {
    type: 'compaction',
    id,
    parentId: null,
    createdAt,
    summary,
    firstKeptMessageId: 'kept-1',
    compactedMessageIds: ['old-1', 'old-2'],
    tokensBefore: 1000,
    tokensAfter: 200,
    strategy: 'summary',
  };
}

function makeEvent(sessionId: string, entry: MessageEntry | CompactionEntry, turnId: string | null = null): NewEvent {
  return {
    id: entry.id,
    sessionId,
    turnId,
    payload: entry,
    createdAt: entry.createdAt,
  };
}

/** Create a sessions table fixture matching the design doc DDL (subset used by MessageLog). */
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

function insertSessionFixture(
  db: SqliteDatabase,
  id: string,
  createdAt: number,
  overrides: Partial<{ title: string; status: string; updated_at: number }> = {},
): void {
  db.prepare(
    'INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, overrides.title ?? 'Test', overrides.status ?? 'active', createdAt, overrides.updated_at ?? createdAt);
}

// ─── Tests ───

describe('MessageLog', () => {
  let tempDir: string;
  let rootDir: string;
  let db: SqliteDatabase;
  let log: MessageLog;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-msglog-test-'));
    rootDir = path.join(tempDir, 'data');
    fs.mkdirSync(rootDir, { recursive: true });
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Run MessageLog migration
    for (const m of MessageLog.migrations) m.up(db);
    createSessionsFixture(db);
    log = new MessageLog(db, rootDir);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ─── resolvePath layout ───

  it('resolves the rollout path with date-directory layout', () => {
    const sessionId = 'sess-1';
    const createdAt = Date.UTC(2026, 7, 6, 12, 0, 0); // 2026-08-06 UTC
    insertSessionFixture(db, sessionId, createdAt);
    const entry = makeUserMessage('m-1', 'hello', createdAt);
    log.appendBatch([makeEvent(sessionId, entry)]);

    const expectedFileName = `rollout-${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}-${sessionId}.jsonl`;
    const expectedRel = path.join('sessions', '2026', '08', '06', expectedFileName);
    const row = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as { rollout_path: string };
    expect(row.rollout_path).toBe(expectedRel);
    expect(fs.existsSync(path.join(rootDir, expectedRel))).toBe(true);
  });

  // ─── append idempotency & file_offset monotonicity ───

  it('appends idempotently — same id re-append does not duplicate index rows', () => {
    const sessionId = 'sess-1';
    const createdAt = Date.now();
    insertSessionFixture(db, sessionId, createdAt);
    const entry = makeUserMessage('m-1', 'hello', createdAt);

    log.appendBatch([makeEvent(sessionId, entry)]);
    log.appendBatch([makeEvent(sessionId, entry)]); // idempotent re-append

    expect(log.getCount(sessionId)).toBe(1);
    const rows = db.prepare('SELECT id FROM message_index WHERE session_id = ?').all(sessionId) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('m-1');
  });

  it('file_offset is monotonically increasing across appends', () => {
    const sessionId = 'sess-1';
    const createdAt = Date.now();
    insertSessionFixture(db, sessionId, createdAt);

    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'first', createdAt))]);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-2', 'second', createdAt + 1))]);

    const rows = db.prepare('SELECT file_offset, byte_len FROM message_index WHERE session_id = ? ORDER BY seq').all(sessionId) as Array<{ file_offset: number; byte_len: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].file_offset).toBe(0);
    expect(rows[1].file_offset).toBeGreaterThan(rows[0].file_offset);
    expect(rows[1].file_offset).toBe(rows[0].file_offset + rows[0].byte_len + 1); // +1 for newline
  });

  // ─── seq monotonicity & cross-session isolation ───

  it('seq is monotonic and independent across sessions', () => {
    const t = Date.now();
    insertSessionFixture(db, 'sess-A', t);
    insertSessionFixture(db, 'sess-B', t);

    log.appendBatch([makeEvent('sess-A', makeUserMessage('a-1', 'a1', t))]);
    log.appendBatch([makeEvent('sess-B', makeUserMessage('b-1', 'b1', t))]);
    log.appendBatch([makeEvent('sess-A', makeUserMessage('a-2', 'a2', t + 1))]);
    log.appendBatch([makeEvent('sess-B', makeUserMessage('b-2', 'b2', t + 1))]);

    const aRows = db.prepare('SELECT seq FROM message_index WHERE session_id = ? ORDER BY seq').all('sess-A') as Array<{ seq: number }>;
    const bRows = db.prepare('SELECT seq FROM message_index WHERE session_id = ? ORDER BY seq').all('sess-B') as Array<{ seq: number }>;
    expect(aRows.map((r) => r.seq)).toEqual([1, 2]);
    expect(bRows.map((r) => r.seq)).toEqual([1, 2]);
  });

  // ─── project restores entry sequence with compaction ───

  it('project restores entry sequence including a compaction entry', () => {
    const sessionId = 'sess-1';
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    const entries = [
      makeUserMessage('u-1', 'first user', t),
      makeAssistantMessage('a-1', 'first assistant', t + 1),
      makeCompactionEntry('c-1', 'compaction summary', t + 2),
      makeUserMessage('u-2', 'second user', t + 3),
    ];

    log.appendBatch(entries.map((e) => makeEvent(sessionId, e)));

    const projected = log.project(sessionId);
    expect(projected).toHaveLength(4);
    expect(projected.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(projected[0].entry.type).toBe('message');
    expect(projected[0].entry.id).toBe('u-1');
    expect(projected[1].entry.type).toBe('message');
    expect(projected[1].entry.id).toBe('a-1');
    expect(projected[2].entry.type).toBe('compaction');
    expect(projected[2].entry.id).toBe('c-1');
    expect(projected[3].entry.type).toBe('message');
    expect(projected[3].entry.id).toBe('u-2');

    // Verify kind values in index
    const kinds = (db.prepare('SELECT kind FROM message_index WHERE session_id = ? ORDER BY seq').all(sessionId) as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).toEqual(['user', 'assistant', 'compaction', 'user']);
  });

  // ─── getCount & deleteBySession ───

  it('getCount and deleteBySession work correctly', () => {
    const sessionId = 'sess-1';
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);
    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'a', t)),
      makeEvent(sessionId, makeAssistantMessage('m-2', 'b', t + 1)),
    ]);
    expect(log.getCount(sessionId)).toBe(2);

    log.deleteBySession(sessionId);
    expect(log.getCount(sessionId)).toBe(0);

    // File is preserved
    const row = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as { rollout_path: string };
    expect(fs.existsSync(path.join(rootDir, row.rollout_path))).toBe(true);
  });

  // ─── scan rebuilds after index truncation ───

  it('scan rebuilds missing index rows after truncation', () => {
    const sessionId = 'sess-1';
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);
    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'first', t)),
      makeEvent(sessionId, makeAssistantMessage('m-2', 'second', t + 1)),
      makeEvent(sessionId, makeUserMessage('m-3', 'third', t + 2)),
    ]);
    expect(log.getCount(sessionId)).toBe(3);

    // Simulate crash: delete the last index row (m-3)
    db.prepare('DELETE FROM message_index WHERE id = ?').run('m-3');
    expect(log.getCount(sessionId)).toBe(2);

    // scan should rebuild m-3
    log.scan(sessionId);
    expect(log.getCount(sessionId)).toBe(3);
    const rows = db.prepare('SELECT id, seq FROM message_index WHERE session_id = ? ORDER BY seq').all(sessionId) as Array<{ id: string; seq: number }>;
    expect(rows.map((r) => r.id)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  // ─── readRange exact line retrieval ───

  it('listBySession reads exact payload via readRange', () => {
    const sessionId = 'sess-1';
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);
    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'first message', t)),
      makeEvent(sessionId, makeAssistantMessage('m-2', 'second message', t + 1)),
    ]);

    const events = log.listBySession(sessionId);
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe('m-1');
    expect(events[0].seq).toBe(1);
    expect(events[0].kind).toBe('user');
    const payload0 = JSON.parse(events[0].payload) as MessageEntry;
    expect(payload0.type).toBe('message');
    expect(payload0.message.content).toBe('first message');

    expect(events[1].id).toBe('m-2');
    expect(events[1].kind).toBe('assistant');
    const payload1 = JSON.parse(events[1].payload) as MessageEntry;
    expect(payload1.message.content).toEqual([{ type: 'text', text: 'second message' }]);
  });

  it('listBySession tolerates a missing rollout file and clears stale index', () => {
    const sessionId = 'sess-1';
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'hello', t))]);
    expect(log.getCount(sessionId)).toBe(1);

    // Simulate the file being gone externally (orphaned/legacy path), while the
    // session's rollout_path + index rows still exist.
    const rel = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as { rollout_path: string };
    fs.rmSync(path.join(rootDir, rel.rollout_path));

    // Must NOT throw ENOENT — returns empty and drops the stale index rows.
    expect(log.listBySession(sessionId)).toEqual([]);
    expect(log.getCount(sessionId)).toBe(0);
  });

  // ─── searchText ───

  it('searchText hits content and returns snippet', () => {
    const sessionId = 'sess-1';
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);
    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'Hello world from duya', t)),
      makeEvent(sessionId, makeAssistantMessage('m-2', 'random text without keyword', t + 1)),
    ]);

    const hits = log.searchText('world');
    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe(sessionId);
    expect(hits[0].messageId).toBe('m-1');
    expect(hits[0].seq).toBe(1);
    expect(hits[0].snippet).toContain('world');
  });

  it('searchText respects scoped sessionIds', () => {
    const t = Date.now();
    insertSessionFixture(db, 'sess-A', t);
    insertSessionFixture(db, 'sess-B', t);
    log.appendBatch([makeEvent('sess-A', makeUserMessage('a-1', 'shared keyword', t))]);
    log.appendBatch([makeEvent('sess-B', makeUserMessage('b-1', 'shared keyword', t))]);

    const hits = log.searchText('keyword', { sessionIds: ['sess-A'] });
    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe('sess-A');
  });

  it('searchText respects limit early exit', () => {
    const t = Date.now();
    insertSessionFixture(db, 'sess-A', t, { updated_at: t + 2 });
    insertSessionFixture(db, 'sess-B', t, { updated_at: t + 1 });
    log.appendBatch([
      makeEvent('sess-A', makeUserMessage('a-1', 'unique keyword one', t)),
      makeEvent('sess-A', makeUserMessage('a-2', 'unique keyword two', t + 1)),
      makeEvent('sess-B', makeUserMessage('b-1', 'unique keyword three', t)),
    ]);

    const hits = log.searchText('keyword', { limit: 2 });
    expect(hits).toHaveLength(2);
  });

  it('searchText hits compaction summary', () => {
    const sessionId = 'sess-1';
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);
    log.appendBatch([
      makeEvent(sessionId, makeCompactionEntry('c-1', 'summary mentioning important context', t)),
    ]);

    const hits = log.searchText('important');
    expect(hits).toHaveLength(1);
    expect(hits[0].messageId).toBe('c-1');
  });

  // ─── rollout_path writeback on first append ───

  it('writes back sessions.rollout_path on first append', () => {
    const sessionId = 'sess-1';
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    // Before append: rollout_path is NULL
    const before = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as { rollout_path: string | null };
    expect(before.rollout_path).toBeNull();

    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'hello', t))]);

    // After append: rollout_path is set
    const after = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as { rollout_path: string | null };
    expect(after.rollout_path).not.toBeNull();
    expect(after.rollout_path).toContain(`rollout-${new Date(t).toISOString().replace(/[:.]/g, '-')}-${sessionId}.jsonl`);
  });

  // ─── cross-midnight date-bucket move ───

  it('moves the rollout file to the new date bucket on a cross-midnight session', () => {
    const sessionId = 'sess-1';
    const t1 = Date.UTC(2026, 7, 7, 13, 47, 42); // 2026-08-07 UTC
    const t2 = Date.UTC(2026, 7, 8, 4, 6, 44); // 2026-08-08 UTC
    insertSessionFixture(db, sessionId, t1);

    // First append on 08-07 sets the initial bucket.
    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'first', t1))]);
    const firstPath = (db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as { rollout_path: string }).rollout_path;
    expect(firstPath).toContain(path.join('sessions', '2026', '08', '07'));
    expect(fs.existsSync(path.join(rootDir, firstPath))).toBe(true);

    // Session stays active into 08-08 — the rollout must move buckets.
    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-2', 'second', t2))]);
    const movedPath = (db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as { rollout_path: string }).rollout_path;
    expect(movedPath).toContain(path.join('sessions', '2026', '08', '08'));
    expect(movedPath).not.toBe(firstPath);
    // Old file is gone, new file exists with all messages.
    expect(fs.existsSync(path.join(rootDir, firstPath))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, movedPath))).toBe(true);

    // Both events remain readable via the new path.
    const events = log.listBySession(sessionId);
    expect(events.map((e) => e.id)).toEqual(['m-1', 'm-2']);
    expect(log.project(sessionId).map((r) => r.entry.id)).toEqual(['m-1', 'm-2']);
  });
});
