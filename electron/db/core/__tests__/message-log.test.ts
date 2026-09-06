import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MessageEntry, CompactionEntry, AgentMessage } from '@duya/agent/message';
import { MessageLog, type NewEvent } from '../message-log';
import { SessionStore } from '../session-store';
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
      agent_id          TEXT,
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

  it('sanitizes Windows-invalid chars in legacy session IDs for the rollout filename', () => {
    const sessionId = 'cron:e15b518d-88d1-471a-b52a-789467caade9:1785498179603:8deaa464-751f-4a35-9864-64319615ec45';
    const createdAt = Date.UTC(2026, 6, 31, 11, 48, 12); // 2026-07-31 UTC
    insertSessionFixture(db, sessionId, createdAt);
    const entry = makeUserMessage('m-1', 'hello', createdAt);
    log.appendBatch([makeEvent(sessionId, entry)]);

    const expectedFileName = `rollout-${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}-cron-e15b518d-88d1-471a-b52a-789467caade9-1785498179603-8deaa464-751f-4a35-9864-64319615ec45.jsonl`;
    const expectedRel = path.join('sessions', '2026', '07', '31', expectedFileName);
    const row = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as { rollout_path: string };
    expect(row.rollout_path).toBe(expectedRel);
    // The file must be created with no colon-bearing name (ENOENT on Windows).
    expect(fs.existsSync(path.join(rootDir, expectedRel))).toBe(true);
    expect(log.getCount(sessionId)).toBe(1);
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

    // The rollout FILE must also stay append-once — a re-append of an already
    // indexed id must NOT add a duplicate line (regression: compaction re-appends
    // the full message list, which used to bloat the file ~Nx while the index
    // INSERT OR IGNORE silently deduped).
    const rel = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as { rollout_path: string };
    const fileLines = fs.readFileSync(path.join(rootDir, rel.rollout_path), 'utf8').trim().split('\n').filter(Boolean);
    expect(fileLines).toHaveLength(1);
  });

  it('re-appending a mixed batch writes only the fresh ids to the file', () => {
    const sessionId = 'sess-1';
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);
    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'a', t)),
      makeEvent(sessionId, makeUserMessage('m-2', 'b', t + 1)),
    ]);

    // Re-send m-1 (already indexed) alongside a brand-new m-3 in one batch.
    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'a', t)),
      makeEvent(sessionId, makeUserMessage('m-3', 'c', t + 2)),
    ]);

    expect(log.getCount(sessionId)).toBe(3);
    const bySeq = db.prepare('SELECT id FROM message_index WHERE session_id = ? ORDER BY seq').all(sessionId) as Array<{ id: string }>;
    expect(bySeq.map((r) => r.id)).toEqual(['m-1', 'm-2', 'm-3']);

    const rel = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as { rollout_path: string };
    const fileLines = fs.readFileSync(path.join(rootDir, rel.rollout_path), 'utf8').trim().split('\n').filter(Boolean);
    expect(fileLines).toHaveLength(3);
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

  it('listBySession tolerates a missing rollout file without dropping the index', () => {
    const sessionId = 'sess-1';
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'hello', t))]);
    expect(log.getCount(sessionId)).toBe(1);

    // Simulate the file being gone externally (orphaned/legacy path), while the
    // session's rollout_path + index rows still exist. Before this fix the
    // index rows were DELETEd on the spot — that was destructive and the
    // /compact hot path tripped "conversation is empty" immediately after.
    const rel = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as { rollout_path: string };
    fs.rmSync(path.join(rootDir, rel.rollout_path));

    // Must NOT throw ENOENT — returns empty without dropping the index. The
    // index rows are preserved so a future scan()/recovery can repopulate
    // from a restored file instead of the user losing the session outright.
    expect(log.listBySession(sessionId)).toEqual([]);
    expect(log.getCount(sessionId)).toBe(1);
  });

  it('listBySession auto-recovers a drifted rollout_path by sessionId pattern', () => {
    const sessionId = 'sess-recover';
    const t1 = Date.now();
    const t2 = t1 + 24 * 60 * 60 * 1000; // +1 day
    insertSessionFixture(db, sessionId, t1);

    // Initial append at t1 stamps the rollout at the original date bucket.
    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'hello day 1', t1)),
    ]);
    const original = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as { rollout_path: string };
    expect(original.rollout_path).toBeTruthy();

    // Simulate the user's bug: moveRollout renamed the file to a new date
    // bucket but the DB UPDATE silently failed, so the DB still points at
    // the old bucket while the physical file lives under a later stamp.
    // We simulate by directly writing a new file with the same sessionId
    // under a different date directory.
    const newStamp = new Date(t2).toISOString().replace(/[:.]/g, '-');
    const yyyy = String(new Date(t2).getUTCFullYear()).padStart(4, '0');
    const mm = String(new Date(t2).getUTCMonth() + 1).padStart(2, '0');
    const dd = String(new Date(t2).getUTCDate()).padStart(2, '0');
    const newRel = `sessions/${yyyy}/${mm}/${dd}/rollout-${newStamp}-${sessionId}.jsonl`;
    const newAbs = path.join(rootDir, newRel);
    fs.mkdirSync(path.dirname(newAbs), { recursive: true });
    const driftEntry: MessageEntry = {
      type: 'message',
      id: 'm-drift',
      parentId: null,
      createdAt: t2,
      message: {
        role: 'user',
        id: 'm-drift',
        content: 'after move',
        timestamp: t2,
        visibility: 'visible',
      },
    };
    fs.writeFileSync(newAbs, JSON.stringify(driftEntry) + '\n', 'utf8');

    // At this point the original file still exists too — both candidate
    // files match the sessionId pattern. The newer stamp must win.
    // (delete the original to make the test deterministic about which file
    // listBySession will read).
    fs.rmSync(path.join(rootDir, original.rollout_path));

    const events = log.listBySession(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('m-drift');
    expect(events[0].seq).toBe(1);

    // sessions.rollout_path must now point at the recovered file.
    const updated = db.prepare('SELECT rollout_path FROM sessions WHERE id = ?').get(sessionId) as { rollout_path: string };
    expect(updated.rollout_path).toBe(newRel);
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

  // ─── S3: UPDATE failure path ───
  // moveRollout and getOrCreateRolloutPath both catch UPDATE failures and
  // log them at WARN (instead of silently swallowing as before). We do not
  // exhaustively assert the log line here — that would require mocking the
  // logger singleton — but we verify the function completes without
  // throwing when the UPDATE raises, which was the user-visible failure
  // mode in production.

  it('first-append writeback survives a sessions-table UPDATE failure (logs warn, does not throw)', () => {
    const sessionId = 'sess-no-sessions-table';
    const t = Date.now();

    // Drop the sessions table so the first-time UPDATE inside
    // getOrCreateRolloutPath throws "no such table: sessions" — exactly the
    // pre-fix behaviour that hid the production drift. We keep
    // `message_index` intact so getIndexedIds / appendLines still work.
    db.exec('DROP TABLE sessions');

    // Pre-fix this would throw "SqliteError: no such table: sessions" out
    // of appendBatch via the empty catch in getOrCreateRolloutPath. After
    // the fix, the catch logs WARN and the function returns; the file is
    // still created and the message_index row is still inserted.
    expect(() => log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'hello', t))]))
      .not.toThrow();

    expect(log.getCount(sessionId)).toBe(1);
    const stamp = new Date(t).toISOString().replace(/[:.]/g, '-');
    const yyyy = String(new Date(t).getUTCFullYear()).padStart(4, '0');
    const mm = String(new Date(t).getUTCMonth() + 1).padStart(2, '0');
    const dd = String(new Date(t).getUTCDate()).padStart(2, '0');
    const expectedPath = `sessions/${yyyy}/${mm}/${dd}/rollout-${stamp}-${sessionId}.jsonl`;
    expect(fs.existsSync(path.join(rootDir, expectedPath))).toBe(true);
  });

  // ─── Plan 493 Phase A: bot session physical isolation ───
  //
  // Bot persistent sessions (`bot:<agentId>`) write to a separate
  // `<rootDir>/agents/<agentId>/sessions/active.jsonl` so the JSONL travels
  // with the bot directory and is purged atomically when the bot is
  // deleted. These tests verify:
  //   1. First append creates the bot-owned JSONL under the agent dir.
  //   2. sessions.rollout_path is stamped with the absolute bot path,
  //      and `agent_type` / `agent_id` columns are populated.
  //   3. listBySession reads back the bot JSONL.
  //   4. resolvePathOnDisk's absolute-path bypass keeps the legacy
  //      doubled-tree fallback from triggering for bot paths.
  //
  // Note: these tests assume the bot agent directory lives under
  // `<rootDir>/agents/<agentId>`. resolveConfigRoot returns the duya
  // root; for tests we override by constructing the path manually.

  it('bot sessionId routes the rollout to <rootDir>/agents/<agentId>/sessions/active.jsonl (Plan 493 P-A)', () => {
    const agentId = 'alpha';
    const sessionId = `bot:${agentId}`;
    const t = Date.now();

    // Pre-create the bot session in the sessions table so getOrCreateRolloutPath
    // can find it on first append.
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'hello', t))]);

    const expectedDir = path.join(rootDir, 'agents', agentId, 'sessions');
    const expectedFile = path.join(expectedDir, 'active.jsonl');
    expect(fs.existsSync(expectedFile)).toBe(true);

    // sessions.rollout_path is the absolute path returned by
    // getBotSessionLogPath — NOT a sessions/<YYYY>/.../...jsonl layout.
    const row = db
      .prepare(
        'SELECT rollout_path, agent_type, agent_id FROM sessions WHERE id = ?',
      )
      .get(sessionId) as {
      rollout_path: string;
      agent_type: string;
      agent_id: string | null;
    };
    expect(row.rollout_path).toBe(expectedFile);
    expect(row.rollout_path).not.toContain(`rollout-`);
    // agent_id is stamped on first append (COALESCE — only fills NULL rows).
    expect(row.agent_id).toBe(agentId);
    // agent_type is NOT overwritten: pre-existing rows keep whatever value
    // they had ('main' default, 'sub' for sub-agents, etc.). Callers that
    // need to recognize bot sessions should check `agent_id IS NOT NULL`
    // or the `bot:` prefix on the session id — `agent_type = 'bot'` is
    // reserved for bot-owned sessions created with that type explicitly.
  });

  it('listBySession reads the bot JSONL after append (Plan 493 P-A)', () => {
    const agentId = 'beta';
    const sessionId = `bot:${agentId}`;
    const t1 = Date.now();
    insertSessionFixture(db, sessionId, t1);

    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'first', t1))]);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-2', 'second', t1 + 1))]);

    const events = log.listBySession(sessionId);
    expect(events.map((e) => e.id)).toEqual(['m-1', 'm-2']);
  });

  it('resolvePathOnDisk does NOT apply the legacy doubled-tree fallback to bot absolute paths (Plan 493 P-A)', () => {
    // Build a bot path that does NOT exist on disk. resolvePathOnDisk must
    // return it verbatim — the doubled-tree fallback would have constructed
    // `<rootDir>/sessions/<botAbsPath>` which is wrong.
    const agentId = 'gamma';
    const sessionId = `bot:${agentId}`;
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'hi', t))]);

    const row = db
      .prepare('SELECT rollout_path FROM sessions WHERE id = ?')
      .get(sessionId) as { rollout_path: string };
    expect(path.isAbsolute(row.rollout_path)).toBe(true);

    // The doubled-tree fallback would resolve to `<rootDir>/sessions/<abs>` —
    // verify that path does NOT exist (we never wrote there).
    const doubledTree = path.join(rootDir, 'sessions', row.rollout_path);
    expect(fs.existsSync(doubledTree)).toBe(false);
  });

  it('non-bot sessions keep the dated shared-tree layout after Phase A changes (Plan 493 P-A regression guard)', () => {
    // Human (non-bot) sessions must continue to land under
    // `<rootDir>/sessions/<YYYY>/<MM>/<DD>/...`. This is the path the
    // rest of the codebase depends on for searchText, drift recovery, and
    // cross-midnight moves.
    const sessionId = 'human-sess-1';
    const t = Date.UTC(2026, 7, 7, 13, 47, 42); // fixed UTC for deterministic path
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'hi', t))]);

    const row = db
      .prepare('SELECT rollout_path, agent_type, agent_id FROM sessions WHERE id = ?')
      .get(sessionId) as {
      rollout_path: string;
      agent_type: string;
      agent_id: string | null;
    };
    expect(row.rollout_path).toContain(
      path.join('sessions', '2026', '08', '07', 'rollout-'),
    );
    expect(row.rollout_path).toContain(`-${sessionId}.jsonl`);
    // agent_type / agent_id must NOT have been overwritten for non-bot rows.
    expect(row.agent_type).toBe('main');
    expect(row.agent_id).toBeNull();
  });

  it('migration id=13 adds agent_id and message_index.generation columns (Plan 493 P-A)', () => {
    // Build a fresh in-memory DB and run migration id=1 (creates message_index)
    // before id=13, so the generation ALTER has a target. Sessions table is
    // absent — the migration must skip the sessions branch.
    const fresh = new Database(':memory:') as unknown as SqliteDatabase;
    fresh.pragma('foreign_keys = ON');
    const id1 = MessageLog.migrations.find((m) => m.id === 1)!;
    const id13 = MessageLog.migrations.find((m) => m.id === 13)!;
    id1.up(fresh);
    id13.up(fresh);

    const indexCols = (
      fresh.prepare('PRAGMA table_info(message_index)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(indexCols).toContain('generation');

    // Re-running migration id=13 is a no-op (PRAGMA table_info guards).
    id13.up(fresh);
    const indexColsAfter = (
      fresh.prepare('PRAGMA table_info(message_index)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(indexColsAfter).toContain('generation');

    fresh.close();
  });

  it('migration id=13 adds sessions.agent_id when sessions table exists (Plan 493 P-A)', () => {
    const fresh = new Database(':memory:') as unknown as SqliteDatabase;
    fresh.pragma('foreign_keys = ON');
    const id13 = MessageLog.migrations.find((m) => m.id === 13)!;

    // First pass: no sessions table. Migration must detect via sqlite_master
    // and skip the ALTER gracefully.
    id13.up(fresh);
    expect(() => fresh.prepare('SELECT 1 FROM sessions LIMIT 0').all()).toThrow();

    // Now create the sessions table (the same shape SessionStore.migrations
    // would create) and re-run migration id=13. It must add agent_id.
    createSessionsFixture(fresh);
    id13.up(fresh);

    const cols = (
      fresh.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain('agent_id');

    // Idempotent: running migration id=13 a third time is a no-op.
    expect(() => id13.up(fresh)).not.toThrow();

    fresh.close();
  });

  it('production migration union runs MessageLog after SessionStore (plan 493 regression)', () => {
    // Mirrors CoreDatabase.runMigrations: the combined migration lists are
    // sorted by id and each id runs exactly once (`id <= current` is skipped).
    // With duplicate ids (both create_sessions and add_agent_id_to_sessions
    // at id=2) the SessionStore migration was skipped, so neither
    // message_index.generation nor sessions.agent_id ever existed and the
    // very first append died with SQLITE_ERROR. add_agent_id_to_sessions must
    // be >= the highest id across all stores — here we assert the production
    // ordering lands create_sessions (id=2) before add_agent_id (id=13).
    const all = [...MessageLog.migrations, ...SessionStore.migrations].sort(
      (a, b) => a.id - b.id,
    );
    // Guard: every migration id in the union must be unique, else the runner
    // silently skips one and leaves the schema short (the exact bug here).
    const ids = all.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    const fresh = new Database(':memory:') as unknown as SqliteDatabase;
    fresh.pragma('foreign_keys = ON');
    let current = 0;
    for (const m of all) {
      if (m.id <= current) continue;
      m.up(fresh);
      current = m.id;
    }

    const indexCols = (
      fresh.prepare('PRAGMA table_info(message_index)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(indexCols).toContain('generation');

    const sessionCols = (
      fresh.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(sessionCols).toContain('agent_id');

    fresh.close();
  });

  it('migration id=14 repairs DBs stuck at schema_version=13 without the Plan 493 columns', () => {
    // Mirrors the production failure: CoreDatabase skips migrations with
    // `id <= meta.schema_version`. The affected dev DB recorded
    // schema_version=13 before the columns landed, so id=13 is skipped
    // forever and id=14 must be the one to repair it.
    const fresh = new Database(':memory:') as unknown as SqliteDatabase;
    fresh.pragma('foreign_keys = ON');

    // Bring the DB to the "broken" state: message_index (id=1) + sessions
    // fixture exist, but neither generation nor agent_id, and the runner
    // believes id=13 is already applied.
    const id1 = MessageLog.migrations.find((m) => m.id === 1)!;
    id1.up(fresh);
    createSessionsFixture(fresh);
    let current = 13;

    const all = [...MessageLog.migrations, ...SessionStore.migrations].sort(
      (a, b) => a.id - b.id,
    );
    for (const m of all) {
      if (m.id <= current) continue;
      m.up(fresh);
      current = m.id;
    }
    expect(current).toBe(14);

    const indexCols = (
      fresh.prepare('PRAGMA table_info(message_index)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(indexCols).toContain('generation');

    const sessionCols = (
      fresh.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(sessionCols).toContain('agent_id');

    // Repair must be idempotent — re-running the full union is a no-op.
    expect(() => {
      for (const m of all) {
        if (m.id <= current) continue;
        m.up(fresh);
        current = m.id;
      }
    }).not.toThrow();

    fresh.close();
  });

  // ─── message_search incremental index (unified space search) ───

  describe('message_search index', () => {
    function searchRows(sessionId: string): Array<{ message_id: string; seq: number; searchable_text: string }> {
      return db
        .prepare('SELECT message_id, seq, searchable_text FROM message_search WHERE session_id = ? ORDER BY seq')
        .all(sessionId) as Array<{ message_id: string; seq: number; searchable_text: string }>;
    }

    it('indexes message text into message_search on normal append', () => {
      insertSessionFixture(db, 's1', 1000);
      log.appendBatch([
        makeEvent('s1', makeUserMessage('m1', 'alpha needle beta', 1000)),
        makeEvent('s1', makeAssistantMessage('m2', 'gamma delta', 1100)),
      ]);
      const rows = searchRows('s1');
      expect(rows).toHaveLength(2);
      expect(rows[0].searchable_text).toContain('alpha needle beta');
      expect(rows[1].searchable_text).toContain('gamma delta');
    });

    it('docker-first append after a wipe backfills all history (post-migration)', () => {
      insertSessionFixture(db, 's1', 1000);
      // A message that predates the index (simulated by wiping the table).
      log.appendBatch([makeEvent('s1', makeUserMessage('old-msg', 'old needle term', 1000))]);
      db.prepare('DELETE FROM message_search').run();
      // Next append triggers a full rebuild → history is re-indexed.
      log.appendBatch([makeEvent('s1', makeUserMessage('new-msg', 'new needle term', 2000))]);
      const texts = searchRows('s1').map((r) => r.searchable_text);
      expect(texts).toHaveLength(2);
      expect(texts).toEqual(
        expect.arrayContaining([
          expect.stringContaining('old needle term'),
          expect.stringContaining('new needle term'),
        ]),
      );
    });

    it('rebase drops superseded rows and keeps survivors', () => {
      insertSessionFixture(db, 's1', 1000);
      log.appendBatch([
        makeEvent('s1', makeUserMessage('older', 'stale needle', 1000)),
        makeEvent('s1', makeUserMessage('stale', 'also stale', 1100)),
      ]);
      // Supercede seqs 1..2, replacing them with a fresh survivor.
      log.appendRebase('s1', null, 2, [makeEvent('s1', makeUserMessage('fresh', 'fresh needle', 1200))]);
      const rows = searchRows('s1');
      expect(rows).toHaveLength(1);
      expect(rows[0].message_id).toBe('fresh');
      expect(rows[0].searchable_text).toContain('fresh needle');
    });
  });
});
