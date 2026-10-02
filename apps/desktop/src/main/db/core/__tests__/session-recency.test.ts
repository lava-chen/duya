/**
 * session-recency.test.ts — Plan 582 (G4), the data-source half.
 *
 * `session-store.test.ts` proves the schema and the sort. This file proves
 * what actually MOVES a session's position: a `turn_started` event landing
 * in the rollout, and nothing else.
 *
 *   1. A turn start advances `recency_at` and `last_turn_started_at`.
 *   2. A plain message append does NOT — otherwise every streaming token
 *      would reorder the sidebar.
 *   3. Several turn boundaries in one batch collapse to the latest.
 *   4. Bot sessions all share the id `'bot'`; one bot's turn must not mark
 *      every other bot as recently used.
 *   5. A missing sessions row is fail-open, not a crash.
 *
 * Unlike `message-log-rotation.test.ts`, this builds the schema from the
 * real `SessionStore.migrations` rather than a hand-written fixture — the
 * point is to exercise the real columns, so a hand-rolled table that drifted
 * from them would test nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SqliteDatabase } from '../database';
import { MessageLog, type NewEvent } from '../message-log';
import { SessionStore } from '../session-store';

const T0 = Date.UTC(2026, 7, 7, 10, 0, 0);

function userMessage(id: string, createdAt: number) {
  return {
    type: 'message' as const,
    id,
    parentId: null,
    message: {
      role: 'user' as const,
      id,
      content: 'hello',
      timestamp: createdAt,
      visibility: 'visible' as const,
    },
    createdAt,
  };
}

function turnStarted(id: string, turnId: string, startedAt: number) {
  return { type: 'turn_started' as const, id, turnId, startedAt };
}

function ev(sessionId: string, payload: ReturnType<typeof userMessage> | ReturnType<typeof turnStarted>): NewEvent {
  return {
    id: payload.id,
    sessionId,
    turnId: 'turn-' + payload.id,
    payload: payload as never,
    createdAt: 'createdAt' in payload ? payload.createdAt : (payload as ReturnType<typeof turnStarted>).startedAt,
  };
}

describe('session recency (Plan 582 G4)', () => {
  let tempDir: string;
  let rootDir: string;
  let db: SqliteDatabase;
  let store: SessionStore;
  let log: MessageLog;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-recency-'));
    rootDir = path.join(tempDir, 'data');
    fs.mkdirSync(rootDir, { recursive: true });
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    for (const m of SessionStore.migrations) m.up(db);
    for (const m of MessageLog.migrations) m.up(db);
    store = new SessionStore(db);
    log = new MessageLog(db, rootDir);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function seed(id: string, overrides: Record<string, unknown> = {}) {
    return store.create({
      id,
      createdAt: T0,
      updatedAt: T0,
      recencyAt: T0,
      ...overrides,
    } as never);
  }

  it('a turn start advances recency_at and stamps last_turn_started_at', () => {
    seed('s-1');
    expect(store.get('s-1')!.recencyAt).toBe(T0);

    const startedAt = T0 + 60_000;
    log.appendBatch([ev('s-1', turnStarted('t-1', 'turn-1', startedAt))]);

    const after = store.get('s-1')!;
    expect(after.recencyAt).toBe(startedAt);
    expect(after.lastTurnStartedAt).toBe(startedAt);
  });

  it('a plain message append does NOT advance recency', () => {
    seed('s-1');
    // The user is typing into a session they are already inside. Letting this
    // move recency would reorder the list on every streamed token.
    log.appendBatch([ev('s-1', userMessage('m-1', T0 + 60_000))]);

    const after = store.get('s-1')!;
    expect(after.recencyAt).toBe(T0);
    expect(after.lastTurnStartedAt).toBeNull();
  });

  it('a turn start reorders the sidebar ahead of a busier-looking neighbour', () => {
    seed('quiet', { recencyAt: T0 });
    seed('chatty', { recencyAt: T0 + 600_000 });
    expect(store.list().map((s) => s.id)).toEqual(['chatty', 'quiet']);

    log.appendBatch([ev('quiet', turnStarted('t-1', 'turn-1', T0 + 900_000))]);
    expect(store.list().map((s) => s.id)).toEqual(['quiet', 'chatty']);
  });

  it('collapses several turn boundaries in one batch to the latest', () => {
    seed('s-1');
    log.appendBatch([
      ev('s-1', turnStarted('t-1', 'turn-1', T0 + 1_000)),
      ev('s-1', turnStarted('t-2', 'turn-2', T0 + 5_000)),
      ev('s-1', turnStarted('t-3', 'turn-3', T0 + 3_000)),
    ]);
    // Not the first, not the last appended — the latest by TIME. A turn that
    // arrives out of order in the batch must not win.
    expect(store.get('s-1')!.recencyAt).toBe(T0 + 5_000);
  });

  it("one bot's turn does not mark a different bot as recently used", () => {
    // A bot session's primary key is the full `bot:<agentId>` id, not a
    // shared 'bot' row. Getting that wrong (or keying the update off
    // agent_id alone) would float every bot to the top of the list the
    // moment any one of them ran a turn.
    seed('bot:alpha', { agentType: 'bot', agentName: 'alpha' });
    seed('bot:beta', { agentType: 'bot', agentName: 'beta' });

    log.appendBatch([ev('bot:alpha', turnStarted('t-1', 'turn-1', T0 + 60_000))]);

    expect(store.get('bot:alpha')!.recencyAt).toBe(T0 + 60_000);
    expect(store.get('bot:beta')!.recencyAt).toBe(T0);
  });

  it('is fail-open when the session row does not exist', () => {
    // No seed(): the append targets a session that was never created. The
    // rollout must still be written — a missing row is a metadata problem,
    // not a reason to drop the user's turn.
    log.appendBatch([ev('ghost', turnStarted('t-1', 'turn-1', T0 + 1_000))]);
    expect(store.get('ghost')).toBeNull();

    const indexed = db
      .prepare('SELECT COUNT(*) AS n FROM message_index WHERE session_id = ?')
      .get('ghost') as { n: number };
    expect(indexed.n).toBe(1);
  });
});
