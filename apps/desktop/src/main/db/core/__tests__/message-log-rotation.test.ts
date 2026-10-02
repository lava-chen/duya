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
import { MessageLog, enforceBotArchiveCap, type NewEvent } from '../message-log';

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

function makeRebaseEvent(
  sessionId: string,
  id: string,
  reason: 'compaction' | 'edit_resend',
  createdAt: number,
  survivors: Array<ReturnType<typeof makeUserMessage>> = [
    makeUserMessage('rb-summary', 'compacted summary', createdAt),
  ],
): NewEvent {
  return {
    id,
    sessionId,
    payload: {
      type: 'rebase' as const,
      id,
      turnId: null,
      supersededUpToSeq: null,
      reason,
      newMessages: survivors,
      createdAt,
    },
    createdAt,
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

  // ── Plan 501 L4: appendBatch detects a compaction payload and rotates ──

  it('appendBatch rotates a bot session when a compaction rebase lands (Plan 501 L4 + Plan 441 wiring)', () => {
    const agentId = 'zeta';
    const sessionId = `bot:${agentId}`;
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'before compaction', t)),
    ]);

    // A compaction rebase appended through the normal append path must
    // trigger the Phase B rotation: the summary lands as the first data
    // row of the fresh generation. Plan 441 replaced the standalone
    // CompactionEntry with the rebase event; Plan 506/493 wire the
    // rotation trigger on `type:'rebase' + reason:'compaction'`.
    log.appendBatch([
      makeRebaseEvent(sessionId, 'comp-1', 'compaction', t + 100, [
        makeUserMessage('comp-1-summary', 'summary v1', t + 100),
      ]),
    ]);

    const sessionsDir = path.join(rootDir, 'agents', agentId, 'sessions');
    expect(fs.existsSync(path.join(sessionsDir, 'archive-0.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(sessionsDir, 'archive-0.jsonl'), 'utf8')).toContain('m-1');

    // active.jsonl: rotation audit line first, then the rebase — the
    // compacted summary becomes the first data row of the fresh generation.
    const newActive = fs.readFileSync(path.join(sessionsDir, 'active.jsonl'), 'utf8');
    const lines = newActive.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe('rotation');
    expect(JSON.parse(lines[1]).type).toBe('rebase');
    expect((JSON.parse(lines[1]) as { reason?: string }).reason).toBe('compaction');

    // Index rows carry the new generation; chat_sessions.generation bumped.
    const rows = db
      .prepare('SELECT id, kind, generation FROM message_index WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as Array<{ id: string; kind: string; generation: number }>;
    expect(rows.map((r) => r.kind)).toEqual(['user', 'rotation', 'rebase']);
    expect(rows[2].generation).toBe(1);
    const gen = db.prepare('SELECT generation FROM chat_sessions WHERE id = ?').get(sessionId) as {
      generation: number;
    };
    expect(gen.generation).toBe(1);

    // A second compaction rebase rotates again (archive-1), epoch == generation.
    log.appendBatch([
      makeRebaseEvent(sessionId, 'comp-2', 'compaction', t + 200, [
        makeUserMessage('comp-2-summary', 'summary v2', t + 200),
      ]),
    ]);
    expect(fs.existsSync(path.join(sessionsDir, 'archive-1.jsonl'))).toBe(true);
    const gen2 = db.prepare('SELECT generation FROM chat_sessions WHERE id = ?').get(sessionId) as {
      generation: number;
    };
    expect(gen2.generation).toBe(2);
  });

  // ── Plan 441 rebase + Plan 506/493 rotation trigger wiring ──

  it('rebase with reason="compaction" triggers bot rotation (the production path)', () => {
    // Plan 441 replaced the standalone CompactionEntry with a rebase event;
    // Plan 506/493 wire the rotation on `rebase` + `reason: 'compaction'`.
    // A rebase without `reason` (or with `reason: 'edit_resend'`) must NOT
    // rotate. This is the regression pin for the trigger wiring — without
    // it the storage layer silently never rotates, leaving each bot session
    // as a single 1.5MB+ file forever.
    const agentId = 'rot-via-rebase';
    const sessionId = `bot:${agentId}`;
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'before', t))]);
    log.appendBatch([makeRebaseEvent(sessionId, 'rb-1', 'compaction', t + 100)]);

    const sessionsDir = path.join(rootDir, 'agents', agentId, 'sessions');
    expect(fs.existsSync(path.join(sessionsDir, 'archive-0.jsonl'))).toBe(true);

    const newActive = fs.readFileSync(path.join(sessionsDir, 'active.jsonl'), 'utf8');
    const lines = newActive.split('\n').filter((l) => l.length > 0);
    expect(JSON.parse(lines[0]).type).toBe('rotation');
    expect(JSON.parse(lines[1]).type).toBe('rebase');

    const gen = db.prepare('SELECT generation FROM chat_sessions WHERE id = ?').get(sessionId) as {
      generation: number;
    };
    expect(gen.generation).toBe(1);
  });

  it('rebase with reason="edit_resend" does NOT rotate (inline mutation, not an epoch boundary)', () => {
    // Edit-resend is a session-level mutation that supersedes prior messages
    // without crossing an epoch. Rotating here would orphan the rotated-out
    // archive mid-edit and force the projection to reconcile two unrelated
    // segments. The trigger must distinguish the two reasons.
    const agentId = 'no-rotate-on-edit';
    const sessionId = `bot:${agentId}`;
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'before', t))]);
    log.appendBatch([makeRebaseEvent(sessionId, 'rb-edit', 'edit_resend', t + 100)]);

    const sessionsDir = path.join(rootDir, 'agents', agentId, 'sessions');
    // No archive created — the active file holds the rebase alongside m-1.
    expect(fs.existsSync(path.join(sessionsDir, 'archive-0.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(sessionsDir, 'active.jsonl'))).toBe(true);
    const active = fs.readFileSync(path.join(sessionsDir, 'active.jsonl'), 'utf8');
    expect(active).toContain('m-1');
    expect(active).toContain('rb-edit');

    const gen = db.prepare('SELECT generation FROM chat_sessions WHERE id = ?').get(sessionId) as {
      generation: number;
    };
    expect(gen.generation).toBe(0);
  });

  it('a compaction rebase on a non-bot session does not rotate', () => {
    const sessionId = 'human-sess-2';
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'hello', t)),
      makeRebaseEvent(sessionId, 'comp-1', 'compaction', t + 10, [
        makeUserMessage('comp-1-summary', 'summary', t + 10),
      ]),
    ]);

    // No agents/<id>/sessions tree and no rotation row — the shared dated
    // tree keeps everything at generation 0.
    expect(fs.existsSync(path.join(rootDir, 'agents'))).toBe(false);
    const rows = db
      .prepare('SELECT kind, generation FROM message_index WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as Array<{ kind: string; generation: number }>;
    expect(rows.map((r) => r.generation)).toEqual([0, 0]);
    expect(rows.map((r) => r.kind)).toEqual(['user', 'rebase']);
  });

  it('appendBatch is fail-open when rotation throws (archive collision)', () => {
    const agentId = 'theta';
    const sessionId = `bot:${agentId}`;
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'first', t))]);

    // Simulate a crash-recovery orphan: archive-0 already exists, so
    // rotateArchive refuses. The append must still succeed.
    const sessionsDir = path.join(rootDir, 'agents', agentId, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'archive-0.jsonl'), '{}\n');

    expect(() =>
      log.appendBatch([
        makeRebaseEvent(sessionId, 'comp-1', 'compaction', t + 100, [
          makeUserMessage('comp-1-summary', 'summary', t + 100),
        ]),
      ]),
    ).not.toThrow();

    // The rebase was still written (no rotation happened — the trigger
    // fired, rotateArchive threw on archive-0 collision, appendBatch
    // swallowed the error and persisted the line anyway).
    const rows = db
      .prepare('SELECT kind FROM message_index WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as Array<{ kind: string }>;
    expect(rows.map((r) => r.kind)).toEqual(['user', 'rebase']);
    const active = fs.readFileSync(path.join(sessionsDir, 'active.jsonl'), 'utf8');
    expect(active).toContain('comp-1');
  });

  it('listBySession self-heals a single-file bot session whose active.jsonl was rewritten in place', () => {
    // Regression: the active file was overwritten (crash mid-rewrite or a bot
    // rebuild) while `message_index.file_offset/byte_len` kept pointing at the
    // OLD bytes. Previously every projection read garbage -> one
    // "Unparseable rollout line skipped" WARN per stale row and the bot's
    // history went invisible. With no `archive-*.jsonl`, the active file is the
    // single authoritative source, so the projection must rebuild the index
    // from it and return the surviving messages instead of skipping.
    const agentId = 'recon';
    const sessionId = `bot:${agentId}`;
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('m-1', 'old one', t)),
      makeEvent(sessionId, makeUserMessage('m-2', 'old two', t + 1)),
      makeEvent(sessionId, makeUserMessage('m-3', 'old three', t + 2)),
    ]);

    const sessionsDir = path.join(rootDir, 'agents', agentId, 'sessions');
    const activePath = path.join(sessionsDir, 'active.jsonl');
    // No archive exists yet.
    expect(fs.existsSync(path.join(sessionsDir, 'archive-0.jsonl'))).toBe(false);

    // Simulate an in-place rewrite of the active file to a different, shorter
    // set of messages. The existing index offsets are now stale.
    fs.writeFileSync(
      activePath,
      JSON.stringify(makeUserMessage('m-4', 'new four', t + 10)).trim() +
        '\n' +
        JSON.stringify(makeUserMessage('m-5', 'new five', t + 11)).trim() +
        '\n',
      'utf8',
    );

    // Sanity: the original indexed offsets no longer parse against the new file.
    const stale = db
      .prepare('SELECT file_offset, byte_len FROM message_index WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as Array<{ file_offset: number; byte_len: number }>;
    const newContent = fs.readFileSync(activePath, 'utf8');
    const anyStaleFails = stale.some(
      (r) =>
        r.file_offset + r.byte_len > Buffer.byteLength(newContent, 'utf8') ||
        (() => {
          try {
            JSON.parse(
              newContent.slice(r.file_offset, r.file_offset + r.byte_len),
            );
            return false;
          } catch {
            return true;
          }
        })(),
    );
    expect(anyStaleFails).toBe(true);

    // listBySession must reconcile (rebuild the index from the active file) and
    // expose only the surviving messages — no throw, no dropped-history WARNs.
    const events = log.listBySession(sessionId);
    expect(events.map((e) => e.id)).toEqual(['m-4', 'm-5']);

    // The index is now consistent with the file: 2 rows, seq 1..2.
    const rebuilt = db
      .prepare('SELECT id, seq FROM message_index WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as Array<{ id: string; seq: number }>;
    expect(rebuilt.map((r) => r.id)).toEqual(['m-4', 'm-5']);
    expect(rebuilt.map((r) => r.seq)).toEqual([1, 2]);
  });

  it('does not rebuild multi-segment bot sessions from the active tail on an unparseable row', () => {
    // A session that HAS archived generations must not be collapsed into the
    // active file's rows by the self-heal path — one corrupt row in an archive
    // could otherwise silently drop the healthy segments.
    const agentId = 'multirecon';
    const sessionId = `bot:${agentId}`;
    const t = Date.now();
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-1', 'gen0', t))]);
    log.rotateArchive(sessionId, 'compaction', t + 10);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('m-2', 'gen1', t + 20))]);

    const sessionsDir = path.join(rootDir, 'agents', agentId, 'sessions');
    expect(fs.existsSync(path.join(sessionsDir, 'archive-0.jsonl'))).toBe(true);

    // Corrupt one archive row's byte range so projection would hit the guard.
    const archive = path.join(sessionsDir, 'archive-0.jsonl');
    const row = db
      .prepare(
        "SELECT file_offset, byte_len FROM message_index WHERE session_id = ? AND generation = 0 ORDER BY seq LIMIT 1",
      )
      .get(sessionId) as { file_offset: number; byte_len: number };
    const content = fs.readFileSync(archive, 'utf8');
    // Truncate the archive so that row reads past the end (unparseable).
    fs.writeFileSync(archive, content.slice(0, row.file_offset), 'utf8');

    // Self-heal must NOT collapse the session to the active tail: the guard
    // detects an archive segment and keeps skipping the stale row only.
    const events = log.listBySession(sessionId);
    // m-1 is now unrecoverable (its archive bytes were wiped) but m-2 in the
    // active segment survives and the timeline is NOT rebuilt from active alone.
    expect(events.map((e) => e.id)).toEqual(['m-2']);
    const remaining = db
      .prepare('SELECT id, generation FROM message_index WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as Array<{ id: string; generation: number }>;
    expect(remaining.some((r) => r.id === 'm-2')).toBe(true);
  });
});

describe('MessageLog non-bot rotation (Plan 506 C1)', () => {
  let tempDir: string;
  let rootDir: string;
  let db: SqliteDatabase;
  let log: MessageLog;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-msglog-nbrot-'));
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

  /** Resolve a session's current rollout file absolute path from the DB row. */
  function rolloutAbsOf(sessionId: string): string {
    const row = db
      .prepare('SELECT rollout_path FROM sessions WHERE id = ?')
      .get(sessionId) as { rollout_path: string };
    return path.join(rootDir, row.rollout_path);
  }

  /** A compaction payload — the appendBatch rotation trigger. */
  it('force-rotates a non-bot session into a per-session generation dir', () => {
    const sessionId = 'nb-1';
    const t = Date.UTC(2026, 8, 7, 1, 0, 0);
    insertSessionFixture(db, sessionId, t);
    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('nb-a', 'first', t)),
      makeEvent(sessionId, makeUserMessage('nb-b', 'second', t + 1)),
    ]);

    const originalAbs = rolloutAbsOf(sessionId);
    expect(fs.existsSync(originalAbs)).toBe(true);

    const newGen = log.rotateArchive(sessionId, 'manual', t + 100, { force: true });
    expect(newGen).toBe(1);

    // The single file moved into sessions/<Y>/<M>/<D>/<id>/archive-0.jsonl and
    // a fresh active.jsonl sits beside it.
    const genDir = path.join(path.dirname(originalAbs), sessionId);
    expect(fs.existsSync(path.join(genDir, 'archive-0.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(genDir, 'active.jsonl'))).toBe(true);
    expect(fs.existsSync(originalAbs)).toBe(false);

    // The active file opens with the rotation audit event.
    const activeLines = fs
      .readFileSync(path.join(genDir, 'active.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(JSON.parse(activeLines[0]).type).toBe('rotation');

    // The DB now points at the new active file (with its archive beside it).
    expect(rolloutAbsOf(sessionId)).toBe(path.join(genDir, 'active.jsonl'));

    // Generation stamps: messages gen=0, rotation gen=1.
    const rows = db
      .prepare(
        'SELECT kind, generation FROM message_index WHERE session_id = ? ORDER BY seq',
      )
      .all(sessionId) as Array<{ kind: string; generation: number }>;
    expect(rows.map((r) => r.generation)).toEqual([0, 0, 1]);

    // listBySession reads across archive + active (rotation events filtered).
    expect(log.listBySession(sessionId).map((e) => e.id)).toEqual(['nb-a', 'nb-b']);
  });

  it('appends after a non-bot rotation stay in the sticky generation dir', () => {
    const sessionId = 'nb-2';
    const t = Date.UTC(2026, 8, 7, 2, 0, 0);
    insertSessionFixture(db, sessionId, t);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('nb-2-a', 'seed', t))]);
    log.rotateArchive(sessionId, 'manual', t + 100, { force: true });

    // A LATER timestamp would normally re-bucket into a new date dir — the
    // generation layout is sticky, the active file must not move.
    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('nb-2-b', 'after rotate', t + 86_400_000)),
    ]);

    const activeAbs = rolloutAbsOf(sessionId);
    expect(path.basename(activeAbs)).toBe('active.jsonl');
    expect(log.listBySession(sessionId).map((e) => e.id)).toEqual(['nb-2-a', 'nb-2-b']);

    // The new row carries generation=1 (inherited from the rotation event).
    const gen = db
      .prepare(
        "SELECT generation FROM message_index WHERE session_id = ? AND id = 'nb-2-b'",
      )
      .get(sessionId) as { generation: number };
    expect(gen.generation).toBe(1);
  });

  it('a compaction rebase rotates an already-rotated non-bot session unconditionally', () => {
    const sessionId = 'nb-3';
    const t = Date.UTC(2026, 8, 7, 3, 0, 0);
    insertSessionFixture(db, sessionId, t);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('nb-3-a', 'seed', t))]);
    log.rotateArchive(sessionId, 'manual', t + 100, { force: true });
    log.appendBatch([makeEvent(sessionId, makeUserMessage('nb-3-b', 'mid', t + 200))]);

    // The second compaction rebase lands on an already-multi-generation
    // session: no size gate applies, archive-1 must appear. The trigger
    // keys on the rebase's reason field, not on a standalone compaction
    // entry (Plan 441 + Plan 506/493 wiring).
    log.appendBatch([
      makeRebaseEvent(sessionId, 'comp-3', 'compaction', t + 300, [
        makeUserMessage('comp-3-summary', 'summary', t + 300),
      ]),
    ]);
    const genDir = path.dirname(rolloutAbsOf(sessionId));
    expect(fs.existsSync(path.join(genDir, 'archive-1.jsonl'))).toBe(true);

    // chat_sessions.generation tracks the epoch.
    const gen = db
      .prepare('SELECT generation FROM chat_sessions WHERE id = ?')
      .get(sessionId) as { generation: number };
    expect(gen.generation).toBe(2);
  });

  it('thresholdBytes overrides the default size gate for non-bot rotation', () => {
    const sessionId = 'nb-4';
    const t = Date.UTC(2026, 8, 7, 4, 0, 0);
    insertSessionFixture(db, sessionId, t);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('nb-4-a', 'tiny', t))]);

    // Default gate: far below 4 MB, no rotation.
    expect(log.rotateArchive(sessionId, 'compaction', t + 100)).toBe(0);
    // A tiny threshold trips the gate.
    expect(log.rotateArchive(sessionId, 'compaction', t + 200, { thresholdBytes: 1 })).toBe(1);
    expect(fs.existsSync(path.join(path.dirname(rolloutAbsOf(sessionId)), 'archive-0.jsonl'))).toBe(
      true,
    );
  });

  it('projection discovers archive generations beyond the old 50-probe bound', () => {
    // A long-lived bot session rotates on EVERY compaction and outlives the
    // old `0..50` probe — generation 51+ silently vanished from the
    // projection. Discovery now lists the directory, so all 61 segments
    // (60 archives + active) must be present in the projection.
    const agentId = 'longlived';
    const sessionId = `bot:${agentId}`;
    const t = Date.UTC(2026, 8, 7, 4, 0, 0);
    insertSessionFixture(db, sessionId, t);
    const sessionsDir = path.join(rootDir, 'agents', agentId, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    for (let g = 0; g <= 59; g++) {
      fs.writeFileSync(
        path.join(sessionsDir, `archive-${g}.jsonl`),
        JSON.stringify({ type: 'message', id: `gen-${g}` }) + '\n',
        'utf8',
      );
    }
    fs.writeFileSync(
      path.join(sessionsDir, 'active.jsonl'),
      JSON.stringify({ type: 'message', id: 'gen-active' }) + '\n',
      'utf8',
    );

    const rows = log.project(sessionId);
    expect(rows).toHaveLength(61);
    const ids = rows.map((r) => (r.entry as { id?: string }).id);
    expect(ids[0]).toBe('gen-0');
    expect(ids[59]).toBe('gen-59');
    expect(ids[60]).toBe('gen-active');
  });

  it('enforceBotArchiveCap prunes oldest archives past the soft cap and keeps active', () => {
    const agentId = 'fatbot';
    const sessionsDir = path.join(rootDir, 'agents', agentId, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // 3 archives of 40 bytes each; soft cap 100 bytes → prune until <= 100.
    for (let g = 0; g < 3; g++) {
      fs.writeFileSync(path.join(sessionsDir, `archive-${g}.jsonl`), 'x'.repeat(40), 'utf8');
    }
    fs.writeFileSync(path.join(sessionsDir, 'active.jsonl'), 'x'.repeat(40), 'utf8');

    const pruned = enforceBotArchiveCap(agentId, rootDir, { force: true, softLimitBytes: 100 });
    // 120 bytes total -> prune the single oldest segment -> 80 bytes (under
    // the cap; the newest archive is always retained alongside active).
    expect(pruned).toBe(1);
    expect(fs.existsSync(path.join(sessionsDir, 'archive-0.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(sessionsDir, 'archive-1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, 'archive-2.jsonl'))).toBe(true);
    // The active file is never touched.
    expect(fs.existsSync(path.join(sessionsDir, 'active.jsonl'))).toBe(true);

    // Under the cap → no pruning.
    expect(enforceBotArchiveCap(agentId, rootDir, { force: true, softLimitBytes: 100 })).toBe(0);
  });
});
