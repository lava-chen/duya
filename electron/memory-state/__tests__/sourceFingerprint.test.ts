import { createHash } from 'crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  computeSourceFingerprint,
  readMessagesForFingerprint,
  type MessageForHash,
} from '../sourceFingerprint';
import { createTempDbDir, type TempDbDir } from './fixture';

/**
 * Source fingerprint tests — Plan 301 §Phase C.
 *
 * The fingerprint is a SHA-256 over compact JSON with alphabetic key
 * order. Determinism is the load-bearing guarantee: the same session
 * content must always produce the same hash, and any semantic change
 * (new message, reordered, thinking added) must produce a different
 * hash. UI-only fields (display_content, token_usage, viz_spec,
 * sub_agent_id) are excluded.
 */
function makeMessage(overrides: Partial<MessageForHash> = {}): MessageForHash {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'hello',
    msg_type: 'text',
    tool_call_id: null,
    tool_name: null,
    tool_input: null,
    thinking: null,
    parent_tool_call_id: null,
    name: null,
    seq_index: 0,
    created_at: 1000,
    ...overrides,
  };
}

/**
 * Create a minimal main-DB schema with just the `messages` table.
 * sourceFingerprint does not need chat_sessions; we omit the FK so
 * SQLite doesn't require a chat_sessions table to exist for inserts.
 */
function createMainDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      display_content TEXT,
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
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

/**
 * Insert helper accepts the full DB column set (not just MessageForHash),
 * since the fingerprint test specifically needs to vary excluded columns
 * like display_content, token_usage, viz_spec, sub_agent_id, status.
 */
interface InsertMessageDbOpts {
  id: string;
  session_id?: string;
  role?: string;
  content?: string;
  display_content?: string | null;
  name?: string | null;
  tool_call_id?: string | null;
  token_usage?: string | null;
  msg_type?: string;
  thinking?: string | null;
  tool_name?: string | null;
  tool_input?: string | null;
  parent_tool_call_id?: string | null;
  viz_spec?: string | null;
  status?: string;
  seq_index?: number | null;
  duration_ms?: number | null;
  sub_agent_id?: string | null;
  created_at?: number;
}

function insertMessage(db: Database.Database, msg: InsertMessageDbOpts): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, display_content, name,
                            tool_call_id, token_usage, msg_type, thinking, tool_name,
                            tool_input, parent_tool_call_id, viz_spec, status,
                            seq_index, duration_ms, sub_agent_id, created_at)
     VALUES (@id, @session_id, @role, @content, @display_content, @name,
             @tool_call_id, @token_usage, @msg_type, @thinking, @tool_name,
             @tool_input, @parent_tool_call_id, @viz_spec, @status,
             @seq_index, @duration_ms, @sub_agent_id, @created_at)`
  ).run({
    id: msg.id,
    session_id: msg.session_id ?? 'sess-1',
    role: msg.role ?? 'user',
    content: msg.content ?? '',
    display_content: msg.display_content ?? null,
    name: msg.name ?? null,
    tool_call_id: msg.tool_call_id ?? null,
    token_usage: msg.token_usage ?? null,
    msg_type: msg.msg_type ?? 'text',
    thinking: msg.thinking ?? null,
    tool_name: msg.tool_name ?? null,
    tool_input: msg.tool_input ?? null,
    parent_tool_call_id: msg.parent_tool_call_id ?? null,
    viz_spec: msg.viz_spec ?? null,
    status: msg.status ?? 'done',
    seq_index: msg.seq_index ?? null,
    duration_ms: msg.duration_ms ?? null,
    sub_agent_id: msg.sub_agent_id ?? null,
    created_at: msg.created_at ?? Date.now(),
  });
}

// Pure-function tests for computeSourceFingerprint. These do NOT touch
// the DB and can run without a working better-sqlite3 binding.
describe('computeSourceFingerprint (pure function)', () => {
  it('1. same messages, same order → same fingerprint', () => {
    const messages = [makeMessage({ id: 'a', created_at: 1 }), makeMessage({ id: 'b', created_at: 2 })];
    const fp1 = computeSourceFingerprint(messages);
    const fp2 = computeSourceFingerprint([...messages]);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('2. add one message → different fingerprint', () => {
    const one = [makeMessage({ id: 'a', created_at: 1 })];
    const two = [makeMessage({ id: 'a', created_at: 1 }), makeMessage({ id: 'b', created_at: 2 })];
    expect(computeSourceFingerprint(one)).not.toBe(computeSourceFingerprint(two));
  });

  it('3. change display_content only → same fingerprint (excluded field)', () => {
    // display_content is NOT in MessageForHash, so the fingerprint
    // cannot depend on it. Two messages with the same MessageForHash
    // fields produce identical fingerprints.
    const a = makeMessage({ id: 'a', content: 'hi' });
    const b = makeMessage({ id: 'a', content: 'hi' });
    expect(computeSourceFingerprint([a])).toBe(computeSourceFingerprint([b]));
  });

  it('4. reorder messages → different fingerprint (order matters)', () => {
    const a = makeMessage({ id: 'a', content: 'first', created_at: 1 });
    const b = makeMessage({ id: 'b', content: 'second', created_at: 2 });
    const fp1 = computeSourceFingerprint([a, b]);
    const fp2 = computeSourceFingerprint([b, a]);
    expect(fp1).not.toBe(fp2);
  });

  it('5. include vs. exclude thinking → different fingerprints', () => {
    const withoutThinking = makeMessage({ id: 'a', thinking: null });
    const withThinking = makeMessage({ id: 'a', thinking: 'I should reason carefully' });
    expect(computeSourceFingerprint([withoutThinking])).not.toBe(
      computeSourceFingerprint([withThinking])
    );
  });

  it('6. empty messages → sha256 of empty canonical JSON ("[]")', () => {
    const fp = computeSourceFingerprint([]);
    const expected = createHash('sha256').update('[]', 'utf8').digest('hex');
    expect(fp).toBe(expected);
  });

  it('7. stable key order — JSON.stringify would produce different order', () => {
    // Verify the fingerprint uses alphabetic key order, not the object's
    // insertion order. Construct a message where insertion order differs
    // from alphabetic order.
    const msg: MessageForHash = {
      id: 'x',
      role: 'user',
      content: 'c',
      msg_type: 'text',
      tool_call_id: null,
      tool_name: null,
      tool_input: null,
      thinking: null,
      parent_tool_call_id: null,
      name: null,
      seq_index: 0,
      created_at: 1,
    };
    const fp = computeSourceFingerprint([msg]);
    // Recompute with keys in alphabetic order manually.
    const manual = `[{` +
      `"content":${JSON.stringify(msg.content)},` +
      `"created_at":${JSON.stringify(msg.created_at)},` +
      `"id":${JSON.stringify(msg.id)},` +
      `"msg_type":${JSON.stringify(msg.msg_type)},` +
      `"name":${JSON.stringify(msg.name)},` +
      `"parent_tool_call_id":${JSON.stringify(msg.parent_tool_call_id)},` +
      `"role":${JSON.stringify(msg.role)},` +
      `"seq_index":${JSON.stringify(msg.seq_index)},` +
      `"thinking":${JSON.stringify(msg.thinking)},` +
      `"tool_call_id":${JSON.stringify(msg.tool_call_id)},` +
      `"tool_input":${JSON.stringify(msg.tool_input)},` +
      `"tool_name":${JSON.stringify(msg.tool_name)}` +
      `}]`;
    const expectedFp = createHash('sha256').update(manual, 'utf8').digest('hex');
    expect(fp).toBe(expectedFp);
  });
});

// DB-dependent tests for readMessagesForFingerprint. These require a
// working better-sqlite3 binding. If the native module is missing or
// compiled for a different Node version, these tests will fail with
// NODE_MODULE_VERSION errors — that is an environment issue, not a
// code issue.
describe('readMessagesForFingerprint (DB-dependent)', () => {
  let temp: TempDbDir;
  let mainDb: Database.Database;

  beforeEach(() => {
    temp = createTempDbDir();
    mainDb = createMainDb(`${temp.dir}/main.db`);
  });

  afterEach(() => {
    try {
      mainDb?.close();
    } catch {
      // DB may not have been opened if better-sqlite3 failed to load.
    }
    temp.cleanup();
  });

  it('3b. change display_content only → same fingerprint (DB read path excludes it)', () => {
    insertMessage(mainDb, {
      id: 'm1',
      session_id: 's1',
      role: 'user',
      content: 'hello',
      display_content: 'display-A',
      created_at: 100,
    });
    const fp1 = computeSourceFingerprint(readMessagesForFingerprint(mainDb, 's1'));

    mainDb.prepare('DELETE FROM messages').run();
    insertMessage(mainDb, {
      id: 'm1',
      session_id: 's1',
      role: 'user',
      content: 'hello',
      display_content: 'display-B-different',
      created_at: 100,
    });
    const fp2 = computeSourceFingerprint(readMessagesForFingerprint(mainDb, 's1'));
    expect(fp1).toBe(fp2);
  });

  it('readMessagesForFingerprint excludes token_usage, viz_spec, sub_agent_id, display_content columns', () => {
    // Insert a message with one set of excluded-column values, compute
    // the fingerprint, then DELETE + re-insert with DIFFERENT values for
    // every excluded column. The fingerprint must not change.
    // (We cannot use two rows with the same `id` — `id` is the PK and
    // is also part of MessageForHash. The delete-and-reinsert pattern
    // mirrors test 3b above.)
    insertMessage(mainDb, {
      id: 'm1',
      session_id: 's1',
      role: 'user',
      content: 'hello',
      display_content: 'disp-A',
      token_usage: '{"tokens":100}',
      viz_spec: '{"chart":"bar"}',
      sub_agent_id: 'sub-1',
      created_at: 100,
    });
    const fp1 = computeSourceFingerprint(readMessagesForFingerprint(mainDb, 's1'));

    mainDb.prepare('DELETE FROM messages').run();
    insertMessage(mainDb, {
      id: 'm1',
      session_id: 's1',
      role: 'user',
      content: 'hello',
      display_content: 'disp-B-different',
      token_usage: '{"tokens":999}',
      viz_spec: '{"chart":"line"}',
      sub_agent_id: 'sub-2-different',
      created_at: 100,
    });
    const fp2 = computeSourceFingerprint(readMessagesForFingerprint(mainDb, 's1'));
    expect(fp1).toBe(fp2);
  });

  it('readMessagesForFingerprint filters status NOT IN (superseded, purged)', () => {
    insertMessage(mainDb, {
      id: 'm-active',
      session_id: 's1',
      role: 'user',
      content: 'visible',
      status: 'done',
      created_at: 100,
    });
    insertMessage(mainDb, {
      id: 'm-superseded',
      session_id: 's1',
      role: 'user',
      content: 'hidden-superseded',
      status: 'superseded',
      created_at: 200,
    });
    insertMessage(mainDb, {
      id: 'm-purged',
      session_id: 's1',
      role: 'user',
      content: 'hidden-purged',
      status: 'purged',
      created_at: 300,
    });

    const messages = readMessagesForFingerprint(mainDb, 's1');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m-active');
  });

  it('readMessagesForFingerprint orders by created_at ASC, rowid ASC', () => {
    insertMessage(mainDb, { id: 'm3', session_id: 's1', content: 'c', created_at: 300 });
    insertMessage(mainDb, { id: 'm1', session_id: 's1', content: 'a', created_at: 100 });
    insertMessage(mainDb, { id: 'm2', session_id: 's1', content: 'b', created_at: 200 });

    const messages = readMessagesForFingerprint(mainDb, 's1');
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });
});
