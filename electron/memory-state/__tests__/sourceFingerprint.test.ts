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
 * Source fingerprint tests — Plan 301 §Phase C, updated for Plan 328
 * decision 10 (fingerprint input changed from legacy `messages` rows
 * to core `message_index` rows).
 *
 * The fingerprint is a SHA-256 over compact JSON with alphabetic key
 * order. Determinism is the load-bearing guarantee: the same session
 * content must always produce the same hash, and any semantic change
 * (new message, reordered, seq changed) must produce a different hash.
 */
function makeMessage(overrides: Partial<MessageForHash> = {}): MessageForHash {
  return {
    id: 'msg-1',
    seq: 1,
    created_at: 1000,
    ...overrides,
  };
}

/**
 * Create a minimal core DB with just the `message_index` table.
 * Mirrors the core schema from `electron/db/core/message-log.ts`.
 */
function createCoreDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE message_index (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      turn_id     TEXT,
      kind        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      file_offset INTEGER NOT NULL,
      byte_len    INTEGER NOT NULL,
      UNIQUE (session_id, seq)
    );
    CREATE INDEX idx_index_session ON message_index(session_id, seq);
  `);
  return db;
}

interface InsertIndexOpts {
  id: string;
  session_id?: string;
  seq: number;
  kind?: string;
  created_at?: number;
}

function insertIndex(db: Database.Database, opts: InsertIndexOpts): void {
  db.prepare(
    `INSERT INTO message_index (id, session_id, seq, kind, created_at, file_offset, byte_len)
     VALUES (@id, @session_id, @seq, @kind, @created_at, 0, 0)`,
  ).run({
    id: opts.id,
    session_id: opts.session_id ?? 'sess-1',
    seq: opts.seq,
    kind: opts.kind ?? 'user',
    created_at: opts.created_at ?? Date.now(),
  });
}

// Pure-function tests for computeSourceFingerprint. These do NOT touch
// the DB and can run without a working better-sqlite3 binding.
describe('computeSourceFingerprint (pure function)', () => {
  it('1. same messages, same order → same fingerprint', () => {
    const messages = [
      makeMessage({ id: 'a', seq: 1, created_at: 1 }),
      makeMessage({ id: 'b', seq: 2, created_at: 2 }),
    ];
    const fp1 = computeSourceFingerprint(messages);
    const fp2 = computeSourceFingerprint([...messages]);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('2. add one message → different fingerprint', () => {
    const one = [makeMessage({ id: 'a', seq: 1, created_at: 1 })];
    const two = [
      makeMessage({ id: 'a', seq: 1, created_at: 1 }),
      makeMessage({ id: 'b', seq: 2, created_at: 2 }),
    ];
    expect(computeSourceFingerprint(one)).not.toBe(computeSourceFingerprint(two));
  });

  it('3. change created_at only → different fingerprint', () => {
    const a = makeMessage({ id: 'a', seq: 1, created_at: 100 });
    const b = makeMessage({ id: 'a', seq: 1, created_at: 200 });
    expect(computeSourceFingerprint([a])).not.toBe(computeSourceFingerprint([b]));
  });

  it('4. reorder messages (different seq) → different fingerprint', () => {
    const a = makeMessage({ id: 'a', seq: 1, created_at: 1 });
    const b = makeMessage({ id: 'b', seq: 2, created_at: 2 });
    const fp1 = computeSourceFingerprint([a, b]);
    const fp2 = computeSourceFingerprint([b, a]);
    expect(fp1).not.toBe(fp2);
  });

  it('5. change seq only → different fingerprint', () => {
    const a = makeMessage({ id: 'a', seq: 1, created_at: 100 });
    const b = makeMessage({ id: 'a', seq: 5, created_at: 100 });
    expect(computeSourceFingerprint([a])).not.toBe(computeSourceFingerprint([b]));
  });

  it('6. empty messages → sha256 of empty canonical JSON ("[]")', () => {
    const fp = computeSourceFingerprint([]);
    const expected = createHash('sha256').update('[]', 'utf8').digest('hex');
    expect(fp).toBe(expected);
  });

  it('7. stable key order — alphabetic (created_at, id, seq)', () => {
    const msg: MessageForHash = {
      id: 'x',
      seq: 42,
      created_at: 999,
    };
    const fp = computeSourceFingerprint([msg]);
    const manual = `[{` +
      `"created_at":${JSON.stringify(msg.created_at)},` +
      `"id":${JSON.stringify(msg.id)},` +
      `"seq":${JSON.stringify(msg.seq)}` +
      `}]`;
    const expectedFp = createHash('sha256').update(manual, 'utf8').digest('hex');
    expect(fp).toBe(expectedFp);
  });
});

// DB-dependent tests for readMessagesForFingerprint. These require a
// working better-sqlite3 binding.
describe('readMessagesForFingerprint (DB-dependent)', () => {
  let temp: TempDbDir;
  let coreDb: Database.Database;

  beforeEach(() => {
    temp = createTempDbDir();
    coreDb = createCoreDb(`${temp.dir}/core.db`);
  });

  afterEach(() => {
    try {
      coreDb?.close();
    } catch {
      // DB may not have been opened if better-sqlite3 failed to load.
    }
    temp.cleanup();
  });

  it('reads id, seq, created_at from message_index', () => {
    insertIndex(coreDb, { id: 'm1', session_id: 's1', seq: 1, created_at: 100 });
    insertIndex(coreDb, { id: 'm2', session_id: 's1', seq: 2, created_at: 200 });

    const messages = readMessagesForFingerprint(coreDb, 's1');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ id: 'm1', seq: 1, created_at: 100 });
    expect(messages[1]).toEqual({ id: 'm2', seq: 2, created_at: 200 });
  });

  it('orders by seq ASC', () => {
    // Insert out of order — seq 3, 1, 2
    insertIndex(coreDb, { id: 'm3', session_id: 's1', seq: 3, created_at: 300 });
    insertIndex(coreDb, { id: 'm1', session_id: 's1', seq: 1, created_at: 100 });
    insertIndex(coreDb, { id: 'm2', session_id: 's1', seq: 2, created_at: 200 });

    const messages = readMessagesForFingerprint(coreDb, 's1');
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('returns empty array for unknown session', () => {
    insertIndex(coreDb, { id: 'm1', session_id: 's1', seq: 1, created_at: 100 });
    const messages = readMessagesForFingerprint(coreDb, 'unknown');
    expect(messages).toEqual([]);
  });

  it('fingerprint changes when a new message is appended', () => {
    insertIndex(coreDb, { id: 'm1', session_id: 's1', seq: 1, created_at: 100 });
    const fp1 = computeSourceFingerprint(readMessagesForFingerprint(coreDb, 's1'));

    insertIndex(coreDb, { id: 'm2', session_id: 's1', seq: 2, created_at: 200 });
    const fp2 = computeSourceFingerprint(readMessagesForFingerprint(coreDb, 's1'));

    expect(fp1).not.toBe(fp2);
  });
});
