/**
 * electron/cli/handlers/messages.test.ts
 *
 * Regression tests for the messages CLI handler. Specifically guards:
 *   - handleGetMessage wraps the row in `{ message }` (client expects
 *     `body.message`; the previous bare DTO caused
 *     "Cannot read properties of undefined (reading 'id')").
 *   - handleGetMessage returns 404 for missing message id.
 *   - handleGetMessage rejects empty sessionId / messageId with 400.
 *
 * Plan 328 Phase 5: the handler now reads from the core `MessageLog`
 * (rollout files + `message_index`), not the legacy `messages` table.
 * Tests inject core stores via `_setCoreStoresForTesting` with a real
 * `CoreDatabase` instance backed by a temp directory (rollout files
 * require a real filesystem path, not `:memory:`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CoreDatabase,
  MessageLog,
  SessionStore,
  type Migration,
} from '../../db/core';
import { _setCoreStoresForTesting } from '../../db/core-connection';
import { ipcMessageToNewEvent } from '../../ipc/core-db-adapters';

let tmpDir: string;
let coreDb: CoreDatabase;
let handleGetMessage: typeof import('./messages.js').handleGetMessage;

// Core store migrations: only MessageLog (id=1) + SessionStore (id=2)
// are needed for these tests.
const MIGRATIONS: Migration[] = [
  ...MessageLog.migrations,
  ...SessionStore.migrations,
].sort((a, b) => a.id - b.id);

const SESSION_ID = 'sess-1';
const MSG_ID = 'msg-1';

interface CapturedResponse {
  status: number;
  body: unknown;
  headers: Record<string, string | number | undefined>;
}

function makeRes(): { res: ServerResponse; capture: CapturedResponse } {
  const capture: CapturedResponse = { status: 0, body: undefined, headers: {} };
  const res = {
    writeHead(status: number, headers?: Record<string, string | number | undefined>) {
      capture.status = status;
      if (headers) capture.headers = { ...capture.headers, ...headers };
    },
    end(payload?: string | unknown) {
      if (typeof payload === 'string') {
        try { capture.body = JSON.parse(payload); } catch { capture.body = payload; }
      } else {
        capture.body = payload;
      }
    },
  } as unknown as ServerResponse;
  return { res, capture };
}

function makeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-messages-test-'));
  const dbPath = path.join(tmpDir, 'core.db');
  const rolloutRoot = path.join(tmpDir, 'sessions');

  // Construct a CoreDatabase with the bundled better-sqlite3.
  // `CoreDatabase` accepts an injected sqlite constructor; fall back to
  // the default require if not provided (same as production).
  const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
  coreDb = new CoreDatabase({
    filename: dbPath,
    sqlite: BetterSqlite3,
    migrations: MIGRATIONS,
  });

  const db = coreDb.db;
  const messageLog = new MessageLog(db, rolloutRoot);
  const sessions = new SessionStore(db);
  _setCoreStoresForTesting({ coreDb, messageLog, sessions } as Parameters<typeof _setCoreStoresForTesting>[0]);

  // Seed a session + a message so handleGetMessage has something to find.
  sessions.create({
    id: SESSION_ID,
    title: 'Test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const now = Date.now();
  messageLog.appendBatch([
    ipcMessageToNewEvent(SESSION_ID, {
      id: MSG_ID,
      session_id: SESSION_ID,
      role: 'assistant',
      content: 'hello world',
      msg_type: 'text',
      created_at: now,
    }),
  ]);

  const handlers = await import('./messages.js');
  handleGetMessage = handlers.handleGetMessage;
});

afterEach(() => {
  _setCoreStoresForTesting(null);
  try { coreDb?.close(); } catch { /* already closed */ }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

describe('handleGetMessage', () => {
  it('returns the row wrapped in `{ message }` (client reads `body.message`)', () => {
    const { res, capture } = makeRes();
    handleGetMessage(makeReq(), res, SESSION_ID, MSG_ID);

    expect(capture.status).toBe(200);
    const body = capture.body as { message: { id: string; sessionId?: string; content: string } };
    expect(body.message).toBeDefined();
    expect(body.message.id).toBe(MSG_ID);
    expect(body.message.content).toBe('hello world');
  });

  it('returns 404 with message_not_found for missing message id', () => {
    const { res, capture } = makeRes();
    handleGetMessage(makeReq(), res, SESSION_ID, 'does-not-exist');
    expect(capture.status).toBe(404);
    expect((capture.body as { error: { code: string } }).error.code).toBe('message_not_found');
  });

  it('rejects empty sessionId with 400', () => {
    const { res, capture } = makeRes();
    handleGetMessage(makeReq(), res, '   ', MSG_ID);
    expect(capture.status).toBe(400);
  });

  it('rejects empty messageId with 400', () => {
    const { res, capture } = makeRes();
    handleGetMessage(makeReq(), res, SESSION_ID, '   ');
    expect(capture.status).toBe(400);
  });
});

// Keep Database import referenced for type-only usage; the actual
// constructor comes from require() in beforeEach so the test can fall
// back to the agent workspace's better-sqlite3 if needed.
void Database;
