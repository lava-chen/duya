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
 * Uses an in-memory better-sqlite3 injected via `setDb()` from
 * `electron/db/connection.ts`. The handler module pulls the db from
 * `getDatabase()` at call time, so injecting before the test runs is
 * sufficient.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { IncomingMessage, ServerResponse } from 'node:http';

let db: Database.Database;
let handleGetMessage: typeof import('./messages.js').handleGetMessage;
let setDb: typeof import('../../db/connection.js').setDb;
let addMessage: typeof import('../../db/queries/messages.js').addMessage;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New Chat',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  working_directory TEXT NOT NULL DEFAULT '',
  project_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  mode TEXT NOT NULL DEFAULT 'code',
  permission_profile TEXT NOT NULL DEFAULT 'default',
  provider_id TEXT NOT NULL DEFAULT 'env',
  context_summary TEXT NOT NULL DEFAULT '',
  context_summary_updated_at INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  agent_profile_id TEXT DEFAULT NULL,
  parent_id TEXT REFERENCES chat_sessions(id),
  agent_type TEXT NOT NULL DEFAULT 'main',
  agent_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  name TEXT,
  tool_call_id TEXT,
  token_usage TEXT,
  msg_type TEXT NOT NULL DEFAULT 'text',
  thinking TEXT,
  tool_name TEXT,
  tool_input TEXT,
  parent_tool_call_id TEXT,
  viz_spec TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  seq_index INTEGER,
  duration_ms INTEGER,
  sub_agent_id TEXT,
  attachments TEXT,
  created_at INTEGER NOT NULL,
  display_content TEXT,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);
`;

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

const SESSION_ID = 'sess-1';
const MSG_ID = 'msg-1';

beforeEach(async () => {
  try {
    db = new Database(':memory:');
    db.exec(SCHEMA);
  } catch (err) {
    throw new Error(
      `better-sqlite3 unavailable in this Node: ${err instanceof Error ? err.message : String(err)}. ` +
        'Run `npm rebuild better-sqlite3` to enable these tests.',
    );
  }
  // Seed a session + a message so handleGetMessage has something to find.
  db.prepare(
    'INSERT INTO chat_sessions (id, created_at, updated_at) VALUES (?, ?, ?)',
  ).run(SESSION_ID, Date.now(), Date.now());
  const conn = await import('../../db/connection.js');
  setDb = conn.setDb;
  setDb(db);
  const queries = await import('../../db/queries/messages.js');
  addMessage = queries.addMessage;
  addMessage({
    id: MSG_ID,
    session_id: SESSION_ID,
    role: 'assistant',
    content: 'hello world',
    msg_type: 'text',
  });
  const handlers = await import('./messages.js');
  handleGetMessage = handlers.handleGetMessage;
});

afterEach(() => {
  try { setDb(null); } catch { /* setDb may be undefined if setup failed */ }
  try { db?.close(); } catch { /* db may be undefined if setup failed */ }
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
