/**
 * MessageLog portability (Plan 506, Track A).
 *
 * The rollout JSONL files are the source of truth; message_index is a
 * rebuildable projection. These tests pin the three user-facing promises:
 *
 *   A1 exportRollout  — one file is one session (single-file sessions copied
 *                       verbatim; rotated sessions concatenate archive
 *                       generations + active in generation order; read-only).
 *   A2 importRestoreFromFile / importContinueFromFile — external .jsonl files
 *                       can rebuild a new session or extend an existing one,
 *                       with validation and global-id-collision remapping.
 *   A3 reconcileAll   — the index rebuild is an explicit, user-triggerable
 *                       operation with missing-file / orphan reporting.
 *
 * Pure helpers (validateImportLines / remapImportNamespace / shiftRebaseBounds)
 * are covered at the bottom.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MessageEntry, CompactionEntry, AgentMessage } from '@duya/agent/message';
import { THREAD_METADATA_KEY } from '@duya/agent/message';
import {
  MessageLog,
  ImportValidationError,
  validateImportLines,
  remapImportNamespace,
  shiftRebaseBounds,
  type NewEvent,
  type RolloutLine,
} from '../message-log';
import type { SqliteDatabase } from '../database';

// ─── Fixtures ──────────────────────────────────────────────────────────────

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

function makeCompactionEntry(id: string, createdAt: number): CompactionEntry {
  return {
    type: 'compaction',
    id,
    parentId: null,
    createdAt,
    summary: 'summarized',
    firstKeptMessageId: 'kept-1',
    compactedMessageIds: ['old-1'],
    tokensBefore: 100,
    tokensAfter: 20,
    strategy: 'summary',
  };
}

function makeEvent(
  sessionId: string,
  entry: MessageEntry | CompactionEntry,
  turnId: string | null = null,
): NewEvent {
  return {
    id: entry.id,
    sessionId,
    turnId,
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

function insertSessionFixture(db: SqliteDatabase, id: string, createdAt: number): void {
  db.prepare(
    'INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'Test', 'active', createdAt, createdAt);
  db.prepare('INSERT OR IGNORE INTO chat_sessions (id, generation) VALUES (?, 0)').run(id);
}

/** Parse a rollout JSONL file into typed lines, dropping empty lines. */
function readLines(absPath: string): RolloutLine[] {
  return fs
    .readFileSync(absPath, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RolloutLine);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('MessageLog portability (Plan 506 Track A)', () => {
  let tempDir: string;
  let rootDir: string;
  let db: SqliteDatabase;
  let log: MessageLog;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-msglog-port-'));
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

  // ─── A1: exportRollout ───

  it('exportRollout copies a single-file session verbatim and is read-only', () => {
    const t = Date.UTC(2026, 8, 7, 1, 0, 0);
    insertSessionFixture(db, 'plain-1', t);
    log.appendBatch([
      makeEvent('plain-1', makeUserMessage('p-1', 'hello', t)),
      makeEvent('plain-1', makeUserMessage('p-2', 'world', t + 1)),
      makeEvent('plain-1', makeUserMessage('p-3', 'again', t + 2)),
    ]);

    const result = log.exportRollout('plain-1');
    expect(result.lines).toBe(3);
    expect(fs.existsSync(result.absolutePath)).toBe(true);

    // Byte-for-byte copy of the rollout file.
    const srcRow = db
      .prepare('SELECT rollout_path FROM sessions WHERE id = ?')
      .get('plain-1') as { rollout_path: string };
    const srcAbs = path.join(rootDir, srcRow.rollout_path);
    expect(fs.readFileSync(result.absolutePath)).toEqual(fs.readFileSync(srcAbs));

    // Read-only: source file and index untouched.
    expect(log.getCount('plain-1')).toBe(3);
    expect(fs.existsSync(srcAbs)).toBe(true);
  });

  it('exportRollout concatenates bot archive generations + active in order', () => {
    const agentId = 'omega';
    const sessionId = `bot:${agentId}`;
    const t = Date.UTC(2026, 8, 7, 2, 0, 0);
    insertSessionFixture(db, sessionId, t);

    log.appendBatch([
      makeEvent(sessionId, makeUserMessage('b-1', 'gen0 a', t)),
      makeEvent(sessionId, makeUserMessage('b-2', 'gen0 b', t + 1)),
    ]);
    log.rotateArchive(sessionId, 'compaction', t + 100);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('b-3', 'gen1', t + 200))]);
    log.rotateArchive(sessionId, 'compaction', t + 300);
    log.appendBatch([makeEvent(sessionId, makeUserMessage('b-4', 'gen2', t + 400))]);

    const result = log.exportRollout(sessionId);
    // archive-0 (b-1, b-2) + archive-1 (rotation, b-3) + active (rotation, b-4).
    expect(result.lines).toBe(6);

    const lines = readLines(result.absolutePath);
    // Rotation audit events are part of the portable trace; the message
    // subsequence must stay in generation order.
    const messageIds = lines.filter((l) => l.type === 'message').map((l) => l.id);
    expect(messageIds).toEqual(['b-1', 'b-2', 'b-3', 'b-4']);
    expect(lines.filter((l) => l.type === 'rotation')).toHaveLength(2);
  });

  it('exportRollout of a never-written session produces an empty file', () => {
    insertSessionFixture(db, 'empty-1', Date.UTC(2026, 8, 7, 3, 0, 0));
    const result = log.exportRollout('empty-1');
    expect(result.lines).toBe(0);
    expect(result.bytes).toBe(0);
    expect(fs.existsSync(result.absolutePath)).toBe(true);
  });

  it('exportRollout throws for an unknown session', () => {
    expect(() => log.exportRollout('no-such-session')).toThrow(/session not found/);
  });

  it('exportRollout honors a custom destDir', () => {
    const t = Date.UTC(2026, 8, 7, 4, 0, 0);
    insertSessionFixture(db, 'plain-2', t);
    log.appendBatch([makeEvent('plain-2', makeUserMessage('x-1', 'x', t))]);

    const destDir = path.join(tempDir, 'elsewhere');
    const result = log.exportRollout('plain-2', destDir);
    expect(path.dirname(result.absolutePath)).toBe(destDir);
    expect(result.lines).toBe(1);
  });

  // ─── A3: reconcileAll ───

  it('reconcileAll back-fills missing index rows from rollout files', () => {
    const t = Date.UTC(2026, 8, 7, 5, 0, 0);
    insertSessionFixture(db, 'r-1', t);
    log.appendBatch([
      makeEvent('r-1', makeUserMessage('r-1-a', 'a', t)),
      makeEvent('r-1', makeUserMessage('r-1-b', 'b', t + 1)),
    ]);
    expect(log.getCount('r-1')).toBe(2);

    // Simulate index loss.
    db.prepare('DELETE FROM message_index WHERE session_id = ?').run('r-1');
    expect(log.getCount('r-1')).toBe(0);

    const stats = log.reconcileAll();
    expect(stats.rowsAdded).toBe(2);
    expect(stats.sessionsScanned).toBeGreaterThanOrEqual(1);
    expect(stats.missingFiles).toEqual([]);
    expect(log.getCount('r-1')).toBe(2);
    expect(log.listBySession('r-1').map((e) => e.id)).toEqual(['r-1-a', 'r-1-b']);
  });

  it('reconcileAll reports missing rollout files and orphan jsonl files', () => {
    const t = Date.UTC(2026, 8, 7, 6, 0, 0);
    insertSessionFixture(db, 'ok-1', t);
    log.appendBatch([makeEvent('ok-1', makeUserMessage('ok-1-a', 'a', t))]);

    // A session row whose rollout file is gone.
    insertSessionFixture(db, 'ghost-1', t);
    db.prepare('UPDATE sessions SET rollout_path = ? WHERE id = ?').run(
      'sessions/2099/01/01/rollout-0-ghost-1.jsonl',
      'ghost-1',
    );

    // A stray jsonl file no session references.
    const strayDir = path.join(rootDir, 'sessions', '2026', '01', '01');
    fs.mkdirSync(strayDir, { recursive: true });
    const strayAbs = path.join(strayDir, 'stray.jsonl');
    fs.writeFileSync(strayAbs, '{"type":"message","id":"s-1","message":{}}\n', 'utf8');

    const stats = log.reconcileAll();
    expect(stats.missingFiles).toEqual(['ghost-1']);
    expect(stats.orphanFiles).toEqual([strayAbs]);
    // The orphan file must not be deleted.
    expect(fs.existsSync(strayAbs)).toBe(true);
  });

  // ─── A2: importRestoreFromFile ───

  it('importRestoreFromFile rebuilds a new session from a foreign rollout file', () => {
    // Hand-crafted external file with ids that exist NOWHERE in this DB —
    // the remapped=false happy path (the collision path has its own test).
    const t = Date.UTC(2026, 8, 7, 7, 0, 0);
    const src = path.join(tempDir, 'foreign.jsonl');
    const entries = [
      makeUserMessage('imp-a', 'first', t),
      makeUserMessage('imp-b', 'second', t + 1),
    ];
    fs.writeFileSync(
      src,
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );

    insertSessionFixture(db, 'dst-1', t + 1000);
    const result = log.importRestoreFromFile('dst-1', src);

    expect(result.sessionId).toBe('dst-1');
    expect(result.linesImported).toBe(2);
    expect(result.remapped).toBe(false);

    // The restored session reads back with payload + order intact.
    const events = log.listBySession('dst-1');
    expect(events.map((e) => e.id)).toEqual(['imp-a', 'imp-b']);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);

    // The copy landed in the dated rollout tree and is referenced by the row.
    const dstRow = db
      .prepare('SELECT rollout_path FROM sessions WHERE id = ?')
      .get('dst-1') as { rollout_path: string };
    expect(dstRow.rollout_path).toMatch(/^sessions[/\\]\d{4}[/\\]\d{2}[/\\]\d{2}[/\\]/);
    expect(fs.existsSync(path.join(rootDir, dstRow.rollout_path))).toBe(true);

    // The external source file is untouched (import reads, never writes it).
    expect(readLines(src).map((l) => l.id)).toEqual(['imp-a', 'imp-b']);
  });

  it('importRestoreFromFile rejects an invalid line with its line number', () => {
    insertSessionFixture(db, 'dst-bad', Date.UTC(2026, 8, 7, 8, 0, 0));
    const src = path.join(tempDir, 'bad-import.jsonl');
    const valid = JSON.stringify(makeUserMessage('v-1', 'ok', 1));
    fs.writeFileSync(src, `${valid}\nnot-json-at-all\n`, 'utf8');

    expect(() => log.importRestoreFromFile('dst-bad', src)).toThrowError(
      ImportValidationError,
    );
    expect(() => log.importRestoreFromFile('dst-bad', src)).toThrowError(
      /Invalid rollout line 2: not valid JSON/,
    );
    // All-or-nothing: nothing was written for the failed import.
    expect(log.getCount('dst-bad')).toBe(0);
  });

  it('importRestoreFromFile remaps colliding ids into the import namespace', () => {
    const t = Date.UTC(2026, 8, 7, 9, 0, 0);
    // The original session still lives in the DB, so its ids collide with
    // the export's ids on the message_index GLOBAL primary key.
    insertSessionFixture(db, 'src-2', t);
    log.appendBatch([
      makeEvent('src-2', makeUserMessage('coll-1', 'first', t)),
      makeEvent('src-2', makeUserMessage('coll-2', 'second', t + 1)),
    ]);
    const exportResult = log.exportRollout('src-2');

    insertSessionFixture(db, 'dst-2', t + 1000);
    const result = log.importRestoreFromFile('dst-2', exportResult.absolutePath);

    expect(result.remapped).toBe(true);
    expect(result.linesImported).toBe(2);

    // The restored session is COMPLETE (no rows silently dropped) with new ids.
    const events = log.listBySession('dst-2');
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.id)).toEqual([
      'import:dst-2:coll-1',
      'import:dst-2:coll-2',
    ]);
    // The original session keeps its identity.
    expect(log.listBySession('src-2').map((e) => e.id)).toEqual(['coll-1', 'coll-2']);
  });

  it('importRestoreFromFile throws when the session row is missing', () => {
    const src = path.join(tempDir, 'no-row.jsonl');
    fs.writeFileSync(src, `${JSON.stringify(makeUserMessage('n-1', 'x', 1))}\n`, 'utf8');
    expect(() => log.importRestoreFromFile('no-such-row', src)).toThrow(
      /session row missing/,
    );
  });

  // ─── A2: importContinueFromFile ───

  /** Hand-craft an external rollout file with plain user messages. */
  function writeExternalFile(
    name: string,
    entries: Array<{ id: string; text: string }>,
  ): string {
    const abs = path.join(tempDir, name);
    const lines = entries.map(({ id, text }) =>
      JSON.stringify(makeUserMessage(id, text, Date.now())),
    );
    fs.writeFileSync(abs, `${lines.join('\n')}\n`, 'utf8');
    return abs;
  }

  it('importContinueFromFile appends fresh lines onto an existing tail', () => {
    const t = Date.UTC(2026, 8, 7, 10, 0, 0);
    insertSessionFixture(db, 't-1', t);
    log.appendBatch([makeEvent('t-1', makeUserMessage('t-1-keep', 'keep', t))]);

    const src = writeExternalFile('cont.jsonl', [
      { id: 'cont-a', text: 'cont a' },
      { id: 'cont-b', text: 'cont b' },
    ]);
    const result = log.importContinueFromFile('t-1', src);

    expect(result.linesImported).toBe(2);
    expect(result.linesSkipped).toBe(0);
    expect(result.remapped).toBe(false);

    expect(log.listBySession('t-1').map((e) => e.id)).toEqual([
      't-1-keep',
      'cont-a',
      'cont-b',
    ]);
  });

  it('importContinueFromFile is idempotent for re-imports', () => {
    const t = Date.UTC(2026, 8, 7, 11, 0, 0);
    insertSessionFixture(db, 't-2', t);
    log.appendBatch([makeEvent('t-2', makeUserMessage('t-2-keep', 'keep', t))]);

    const src = writeExternalFile('cont2.jsonl', [
      { id: 'dup-a', text: 'dup' },
    ]);
    const first = log.importContinueFromFile('t-2', src);
    expect(first.linesImported).toBe(1);

    const second = log.importContinueFromFile('t-2', src);
    expect(second.linesImported).toBe(0);
    expect(second.linesSkipped).toBe(1);
    expect(log.getCount('t-2')).toBe(2);
  });

  it('importContinueFromFile remaps ids owned by another session', () => {
    const t = Date.UTC(2026, 8, 7, 12, 0, 0);
    insertSessionFixture(db, 'other-1', t);
    log.appendBatch([makeEvent('other-1', makeUserMessage('shared-1', 'mine', t))]);

    insertSessionFixture(db, 't-3', t + 1000);
    log.appendBatch([makeEvent('t-3', makeUserMessage('t-3-keep', 'keep', t + 1000))]);

    // 'shared-1' is owned by other-1 — a verbatim append would be dropped
    // by the global message_index PK. 'fresh-1' does not collide.
    const src = writeExternalFile('cont3.jsonl', [
      { id: 'shared-1', text: 'colliding' },
      { id: 'fresh-1', text: 'fresh' },
    ]);
    const result = log.importContinueFromFile('t-3', src);

    expect(result.remapped).toBe(true);
    expect(result.linesImported).toBe(2);
    expect(result.linesSkipped).toBe(0);
    expect(log.listBySession('t-3').map((e) => e.id)).toEqual([
      't-3-keep',
      'import:t-3:shared-1',
      'fresh-1',
    ]);
    // The other session is untouched.
    expect(log.listBySession('other-1').map((e) => e.id)).toEqual(['shared-1']);
  });

  it('importContinueFromFile throws for an unknown session or missing file', () => {
    const src = writeExternalFile('cont4.jsonl', [{ id: 'x-1', text: 'x' }]);
    expect(() => log.importContinueFromFile('no-such-target', src)).toThrow(
      /session not found/,
    );
    insertSessionFixture(db, 't-4', Date.now());
    expect(() => log.importContinueFromFile('t-4', path.join(tempDir, 'missing.jsonl'))).toThrow(
      /source file not found/,
    );
  });
});

// ─── Pure helpers ──────────────────────────────────────────────────────────

describe('import pure helpers (Plan 506 Track A2)', () => {
  it('validateImportLines accepts every known line type and rejects unknown shapes', () => {
    const message = JSON.stringify(makeUserMessage('ok-1', 'hi', 1));
    const compaction = JSON.stringify(makeCompactionEntry('ok-2', 2));
    const rebase = JSON.stringify({
      type: 'rebase',
      id: 'ok-3',
      turnId: 'turn-1',
      supersededUpToSeq: null,
      newMessages: [],
      createdAt: 3,
    });
    const rotation = JSON.stringify({
      type: 'rotation',
      id: 'ok-4',
      archiveFile: 'agents/a/sessions/archive-0.jsonl',
      newGeneration: 1,
      reason: 'compaction',
      seqBeforeRotation: 2,
      createdAt: 4,
    });

    const lines = validateImportLines([message, compaction, rebase, rotation]);
    expect(lines.map((l) => l.id)).toEqual(['ok-1', 'ok-2', 'ok-3', 'ok-4']);

    // Unparseable line reports the 1-based line number.
    expect(() => validateImportLines([message, 'garbage{'])).toThrowError(
      /line 2: not valid JSON/,
    );
    // Unknown discriminator.
    expect(() =>
      validateImportLines(['{"type":"bogus","id":"z-1"}']),
    ).toThrowError(/unknown rollout line type "bogus"/);
    // Missing id.
    expect(() =>
      validateImportLines(['{"type":"message","message":{}}']),
    ).toThrowError(/missing non-empty string "id"/);
  });

  it('remapImportNamespace remaps only colliding ids and every cross-reference', () => {
    const base = Date.UTC(2026, 8, 7, 13, 0, 0);
    const parent: MessageEntry = {
      ...makeUserMessage('keep-1', 'parent', base),
    };
    // Child references the colliding id via parentId + threadMeta.replyToId.
    const child: MessageEntry = {
      type: 'message',
      id: 'child-1',
      parentId: 'gone-1',
      createdAt: base + 1,
      message: {
        role: 'user',
        id: 'child-1',
        content: 'child',
        timestamp: base + 1,
        visibility: 'visible',
        metadata: { [THREAD_METADATA_KEY]: { replyToId: 'gone-1', branched: false } },
      },
    };
    const compaction: CompactionEntry = {
      ...makeCompactionEntry('comp-1', base + 2),
      firstKeptMessageId: 'gone-1',
      compactedMessageIds: ['keep-1', 'gone-1'],
      previousCompactionId: 'gone-1',
    };
    const lines: RolloutLine[] = [parent, child, compaction];

    const remapped = remapImportNamespace(lines, 's-9', 'import', new Set(['gone-1']));

    // Only the colliding line mints a new id; others keep their identity.
    expect(remapped.map((l) => l.id)).toEqual(['keep-1', 'child-1', 'comp-1']);
    // parentId reference remapped.
    expect((remapped[1] as MessageEntry).parentId).toBe('import:s-9:gone-1');
    // Inner message.id untouched (not colliding) but threadMeta.replyToId remapped.
    const childMsg = (remapped[1] as MessageEntry).message as {
      id: string;
      metadata?: Record<string, unknown>;
    };
    expect(childMsg.id).toBe('child-1');
    expect(childMsg.metadata?.[THREAD_METADATA_KEY]).toMatchObject({
      replyToId: 'import:s-9:gone-1',
    });
    // Compaction references remapped where they pointed at the colliding id.
    const c = remapped[2] as CompactionEntry;
    expect(c.firstKeptMessageId).toBe('import:s-9:gone-1');
    expect(c.compactedMessageIds).toEqual(['keep-1', 'import:s-9:gone-1']);
    expect(c.previousCompactionId).toBe('import:s-9:gone-1');
    // Inputs are never mutated.
    expect((lines[1] as MessageEntry).parentId).toBe('gone-1');
    expect((lines[2] as CompactionEntry).firstKeptMessageId).toBe('gone-1');
  });

  it('shiftRebaseBounds shifts numeric bounds and leaves null bounds untouched', () => {
    const rebase: RolloutLine = {
      type: 'rebase',
      id: 'rb-1',
      turnId: 't',
      supersededUpToSeq: 3,
      newMessages: [],
      createdAt: 1,
    };
    const nullBound: RolloutLine = {
      type: 'rebase',
      id: 'rb-2',
      turnId: 't',
      supersededUpToSeq: null,
      newMessages: [],
      createdAt: 2,
    };
    const message: RolloutLine = makeUserMessage('m-1', 'x', 3);

    const shifted = shiftRebaseBounds([rebase, nullBound, message], 5);
    expect((shifted[0] as { supersededUpToSeq?: number }).supersededUpToSeq).toBe(8);
    expect((shifted[1] as { supersededUpToSeq?: number | null }).supersededUpToSeq).toBeNull();
    expect(shifted[2]).toBe(message); // non-rebase lines pass through untouched
  });
});
