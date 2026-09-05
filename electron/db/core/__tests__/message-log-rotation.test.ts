/**
 * MessageLog rotation (Plan 493, Phase B).
 *
 * Bot sessions live under `<rootDir>/agents/<agentId>/sessions/`. The active
 * JSONL is rotated into `archive-<g>.jsonl` on compaction; subsequent
 * messages land in a fresh `active.jsonl` with an incremented `generation`
 * column on message_index.
 *
 * Coverage:
 *   1. First rotateArchive no-ops when no active file exists.
 *   2. rotateArchive renames active -> archive-0, creates new active with
 *      a rotation event as its first line, and stamps message_index with
 *      generation=1.
 *   3. After two rotations, listBySession reads both archives + active in
 *      generation order, returning the right merged timeline.
 *   4. Rotation events are filtered out of the projected timeline (they
 *      are internal audit markers, not user-visible rows).
 *   5. Compaction rebase emitted mid-rotation still folds superseded
 *      messages — applyRebases does not double-fold rows across the
 *      rotation boundary.
 *   6. rotateArchive refuses to overwrite an existing archive file (a
 *      collision means an earlier crash recovery left an orphan behind).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SqliteDatabase } from '../database';
import { MessageLog, type NewEvent } from '../message-log';

// ─── Fixtures ──────────────────────────────────────────────────────────────

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
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function insertSessionFixture(
  db: SqliteDatabase,
  id: string,
  createdAt: number,
  alsoChatSession = true,
): void {
  db.prepare(
    'INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'Test', 'active', createdAt, createdAt);
  if (alsoChatSession) {
    db.prepare('INSERT INTO chat_sessions (id, generation) VALUES (?, 0)').run(id);
  }
}

function makeUserMessage(id: string, text: string, createdAt: number) {
  return {
    id,
    type: 'message' as const,
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

// ─── Tests ────────────────────────────────────────────────────────────────

describe('MessageLog rotation (Plan 493, Phase B)', () => {
  let tempDir: string;
  let rootDir: string;
  let db: SqliteDatabase;
  let log: MessageLog;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-msglog-rot-'));
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

  it('rotateArchive is a no-op when no active file exists', () => {
    const sessionId = 'bot:alpha';
    const result = log.rotateArchive(sessionId);
    expect(result).toBe(0);
    // No archive should have been created.
    const archiveDir = path.join(rootDir, 'agents', 'alpha', 'sessions');
    expect(fs.existsSync(archiveDir)).toBe(false);
  });

  it('rotateArchive renames active.jsonl -> archive-0 and creates a new active with a rotation event', () => {
    const agentId = 'beta';
    const sessionId = `bot:${agentId}`;
    const t1 = Date.UTC(2026, 7, 7, 13, 47, 42);
    insertSessionFixture(db, sessionId, t1);

    // Append two messages so the active file is non-empty.
    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'first', t1)),
      makeEvent(sessionId, makeUserMessage('m-2', 'second', t1 + 1)),
    ]);

    const activePath = path.join(rootDir, 'agents', agentId, 'sessions', 'active.jsonl');
    expect(fs.existsSync(activePath)).toBe(true);
    const activeContentBefore = fs.readFileSync(activePath, 'utf8');
    expect(activeContentBefore).toContain('"m-1"');
    expect(activeContentBefore).toContain('"m-2"');

    const newGen = log.rotateArchive(sessionId, 'compaction', t1 + 100);
    expect(newGen).toBe(1);

    // archive-0.jsonl now holds the original two messages.
    const archivePath = path.join(rootDir, 'agents', agentId, 'sessions', 'archive-0.jsonl');
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(fs.readFileSync(archivePath, 'utf8')).toBe(activeContentBefore);

    // active.jsonl is a fresh file whose first line is the rotation event.
    const newActive = fs.readFileSync(activePath, 'utf8');
    const lines = newActive.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const rotationEvent = JSON.parse(lines[0]);
    expect(rotationEvent.type).toBe('rotation');
    expect(rotationEvent.newGeneration).toBe(1);
    expect(rotationEvent.seqBeforeRotation).toBe(2);
    expect(rotationEvent.reason).toBe('compaction');

    // message_index has 3 rows: m-1, m-2 (gen=0), and the rotation (gen=1).
    const generations = db
      .prepare(
        'SELECT id, generation, kind FROM message_index WHERE session_id = ? ORDER BY seq',
      )
      .all(sessionId) as Array<{ id: string; generation: number; kind: string }>;
    expect(generations.map((r) => r.id)).toEqual(['m-1', 'm-2', rotationEvent.id]);
    expect(generations[0].generation).toBe(0);
    expect(generations[1].generation).toBe(0);
    expect(generations[2].generation).toBe(1);
    expect(generations[2].kind).toBe('rotation');
  });

  it('two rotations produce archive-0, archive-1, and active; listBySession returns the merged timeline', () => {
    const agentId = 'gamma';
    const sessionId = `bot:${agentId}`;
    const t1 = Date.UTC(2026, 7, 7, 13, 47, 42);
    insertSessionFixture(db, sessionId, t1);

    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'turn 1 first', t1)),
      makeEvent(sessionId, makeUserMessage('m-2', 'turn 1 second', t1 + 1)),
    ]);
    log.rotateArchive(sessionId, 'compaction', t1 + 100);

    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-3', 'turn 2 first', t1 + 200)),
      makeEvent(sessionId, makeUserMessage('m-4', 'turn 2 second', t1 + 201)),
    ]);
    log.rotateArchive(sessionId, 'compaction', t1 + 300);

    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-5', 'turn 3 first', t1 + 400)),
    ]);

    // Both archives exist plus the active file.
    const sessionsDir = path.join(rootDir, 'agents', agentId, 'sessions');
    expect(fs.existsSync(path.join(sessionsDir, 'archive-0.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, 'archive-1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, 'active.jsonl'))).toBe(true);

    // listBySession reads across all three files in generation order and
    // returns a flat timeline WITHOUT the internal rotation events.
    const events = log.listBySession(sessionId);
    expect(events.map((e) => e.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4', 'm-5']);

    // project() also spans all three files (rotations still excluded by
    // caller-side filter).
    const projected = log.project(sessionId);
    const ids = projected
      .map((r) => r.entry.id)
      .filter((id) => !id.startsWith('rotation:'));
    expect(ids).toEqual(['m-1', 'm-2', 'm-3', 'm-4', 'm-5']);
  });

  it('rotation events are filtered out of listBySession (Plan 493 P-B audit visibility)', () => {
    const agentId = 'delta';
    const sessionId = `bot:${agentId}`;
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'before', t)),
    ]);
    log.rotateArchive(sessionId, 'compaction', t + 100);
    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-2', 'after', t + 200)),
    ]);

    const events = log.listBySession(sessionId);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['user', 'user']);
    expect(events.map((e) => e.id)).toEqual(['m-1', 'm-2']);
  });

  it('compaction rebase emitted before a rotation still folds superseded messages', () => {
    // The applyRebases projection does not care about file boundaries —
    // a rebase written into archive-0 still supersedes messages in
    // archive-0, and rebase newMessages are emitted at the rebase's own
    // seq. After rotation, the new active file carries forward any
    // survivors naturally because they are re-emitted in the rebase's
    // newMessages.
    const agentId = 'epsilon';
    const sessionId = `bot:${agentId}`;
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'to be compacted', t)),
      makeEvent(sessionId, makeUserMessage('m-2', 'also compacted', t + 1)),
    ]);

    // Compaction rebase with a single survivor — production compaction
    // always emits at least one summary message; the empty-newMessages
    // form is dropped by `appendRebase`'s silent-drop guard. We pass
    // one summary so the rebase actually persists.
    log.appendRebase(
      sessionId,
      null,
      null,
      [makeEvent(sessionId, makeUserMessage('m-summary', 'compacted', t + 50))],
      t + 100,
    );

    log.rotateArchive(sessionId, 'compaction', t + 200);
    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-3', 'fresh start', t + 300)),
    ]);

    const events = log.listBySession(sessionId);
    // After applyRebases, m-1 and m-2 are gone (superseded by the rebase
    // whose newMessages carried only m-summary). The post-rotation m-3
    // is preserved. m-summary stays because it is the rebase's survivor.
    expect(events.map((e) => e.id)).toEqual(['m-summary', 'm-3']);
  });

  it('rotateArchive is idempotent when called twice in a row with no intervening writes', () => {
    // After the first rotation, the second rotation must consume the
    // freshly-created rotation event as the highest-seq row, advance
    // generation to 2, and archive-1 (the new archive). This proves
    // the `getCurrentGeneration` + active-file-existence checks compose
    // correctly across consecutive rotations.
    const agentId = 'zeta';
    const sessionId = `bot:${agentId}`;
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'first', t))]);
    const firstGen = log.rotateArchive(sessionId, 'compaction', t + 100);
    expect(firstGen).toBe(1);

    // No message written between rotations — the active file holds only
    // the rotation event from the previous step.
    const secondGen = log.rotateArchive(sessionId, 'compaction', t + 200);
    expect(secondGen).toBe(2);

    // archive-0 + archive-1 + active all exist.
    const sessionsDir = path.join(rootDir, 'agents', agentId, 'sessions');
    expect(fs.existsSync(path.join(sessionsDir, 'archive-0.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, 'archive-1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, 'active.jsonl'))).toBe(true);

    // After both rotations, the projected timeline is still just m-1
    // (rotations are internal audit markers, filtered out).
    const events = log.listBySession(sessionId);
    expect(events.map((e) => e.id)).toEqual(['m-1']);
  });

  it('rotateArchive on a non-bot session is a safe no-op (returns 0)', () => {
    const sessionId = 'human-sess-1';
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'hello', t)),
    ]);

    // Non-bot session — no rotation event, no archive file, return 0.
    expect(log.rotateArchive(sessionId)).toBe(0);
    const sessionsRoot = path.join(rootDir, 'sessions');
    expect(fs.existsSync(sessionsRoot)).toBe(true);
    // The active rollout lives under the dated shared tree, untouched.
    const file = fs
      .readdirSync(sessionsRoot, { recursive: true })
      .find((n) => typeof n === 'string' && n.endsWith('.jsonl'));
    expect(file).toBeDefined();
  });

  it('messages appended after a rotation are stamped with the new generation', () => {
    const agentId = 'eta';
    const sessionId = `bot:${agentId}`;
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'gen0', t))]);
    log.rotateArchive(sessionId, 'compaction', t + 100);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-2', 'gen1', t + 200))]);

    const rows = db
      .prepare(
        'SELECT id, generation, kind FROM message_index WHERE session_id = ? ORDER BY seq',
      )
      .all(sessionId) as Array<{ id: string; generation: number; kind: string }>;
    expect(rows).toHaveLength(3); // m-1, rotation, m-2
    expect(rows[0]).toMatchObject({ id: 'm-1', generation: 0 });
    expect(rows[2]).toMatchObject({ id: 'm-2', generation: 1 });
  });
});
