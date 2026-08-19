/**
 * agent-run.test.ts — Cron session creation for immediate/scheduled runs.
 *
 * Coverage:
 *   - createCronSessionRow creates the session row AND pre-inserts the cron
 *     prompt as a durable user message (the run view shows the task
 *     immediately; the worker reuses the row via its same-content duplicate
 *     check instead of writing a second copy at turn end).
 *   - Idempotency: runCronNow creates the row eagerly and runCronInSession
 *     reuses it — a second call must not duplicate the prompt message.
 *   - Empty prompts are skipped (no empty bubble in the run view).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MessageLog } from '../db/core/message-log';
import { SessionStore } from '../db/core/session-store';
import type { SqliteDatabase } from '../db/core/database';
import { createCronSessionRow } from './agent-run';

// Mock state shared between the vi.mock factories (hoisted) and the tests.
const mocks = vi.hoisted(() => ({
  stores: null as {
    sessions: { get: (id: string) => unknown; create: (input: unknown) => unknown };
    messageLog: { appendBatch: (events: unknown[]) => void; listBySession: (id: string) => unknown[] };
  } | null,
  windows: [] as unknown[],
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mocks.windows },
}));

vi.mock('../db/core-connection', () => ({
  getCoreStores: () => {
    if (!mocks.stores) throw new Error('stores not initialized in test');
    return mocks.stores;
  },
}));

describe('createCronSessionRow', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let sessions: SessionStore;
  let messageLog: MessageLog;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-agent-run-test-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    for (const m of [...SessionStore.migrations, ...MessageLog.migrations].sort((a, b) => a.id - b.id)) {
      m.up(db);
    }
    sessions = new SessionStore(db);
    messageLog = new MessageLog(db, path.join(tempDir, 'rollouts'));
    mocks.stores = {
      sessions: {
        get: (id) => sessions.get(id) ?? null,
        create: (input) => sessions.create(input as never),
      },
      messageLog: {
        appendBatch: (events) => messageLog.appendBatch(events as never),
        listBySession: (id) => messageLog.listBySession(id),
      },
    };
  });

  afterEach(() => {
    mocks.stores = null;
    try {
      db.close();
    } catch {
      // already closed
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  const params = {
    sessionId: 'cron:job-1:1710000000000:run-1',
    title: '[Cron] Daily digest',
    model: 'gpt-4o',
    providerId: 'openai',
    workingDirectory: tempDir,
    cronId: 'job-1',
    prompt: 'Summarize yesterday\'s commits',
  };

  it('creates the session row and pre-inserts the prompt as a user message', () => {
    createCronSessionRow(params);

    expect(sessions.get(params.sessionId)).not.toBeNull();
    const events = messageLog.listBySession(params.sessionId);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as { type: string; message: { role: string; content: string; msgType?: string } };
    expect(payload.type).toBe('message');
    expect(payload.message.role).toBe('user');
    expect(payload.message.content).toBe(params.prompt);
  });

  it('is idempotent across the eager runCronNow create and runCronInSession reuse', () => {
    createCronSessionRow(params);
    createCronSessionRow(params);

    expect(messageLog.listBySession(params.sessionId)).toHaveLength(1);
  });

  it('skips the prompt message when the cron prompt is empty', () => {
    createCronSessionRow({ ...params, prompt: '   ' });

    expect(sessions.get(params.sessionId)).not.toBeNull();
    expect(messageLog.listBySession(params.sessionId)).toHaveLength(0);
  });
});
