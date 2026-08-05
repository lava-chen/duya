import { describe, expect, it } from 'vitest';
import type {
  AgentMessage,
  CompactionEntry,
  MessageEntry,
  MessageTimelineEntry,
} from '../../src/message/message-framework.js';
import {
  SqliteMessageRepository,
  createConversationEntriesTable,
  deserializeEntry,
  serializeEntry,
  type ConversationEntryRow,
  type RepositoryDatabase,
  type RepositoryStatement,
} from '../../src/message/message-repository.js';

const FIXED_NOW = 1_700_000_000_000;

function user(id: string, content: string): AgentMessage {
  return {
    kind: 'user',
    id,
    createdAt: FIXED_NOW,
    persistence: 'durable',
    visibility: 'visible',
    content,
  };
}

function messageEntry(id: string, message: AgentMessage): MessageEntry {
  return { type: 'message', id, parentId: null, createdAt: FIXED_NOW, message };
}

function compactionEntry(id: string): CompactionEntry {
  return {
    type: 'compaction',
    id,
    parentId: null,
    createdAt: FIXED_NOW,
    summary: 'Earlier work is complete.',
    firstKeptMessageId: 'u2',
    compactedMessageIds: ['u1'],
    tokensBefore: 90_000,
    tokensAfter: 20_000,
    strategy: 'session_memory',
  };
}

// ─── Serialization ───────────────────────────────────────────────────────

describe('serializeEntry / deserializeEntry', () => {
  it('round-trips a message entry', () => {
    const entry = messageEntry('e1', user('u1', 'hello'));
    const row = serializeEntry(entry, 'sess-1', 0);
    expect(row.entry_type).toBe('message');
    expect(row.status).toBe('active');
    expect(deserializeEntry(row)).toEqual(entry);
  });

  it('round-trips a compaction entry', () => {
    const entry = compactionEntry('c1');
    const row = serializeEntry(entry, 'sess-1', 1);
    expect(row.entry_type).toBe('compaction');
    expect(deserializeEntry(row)).toEqual(entry);
  });

  it('round-trips a model_change entry', () => {
    const entry = {
      type: 'model_change' as const,
      id: 'mc-1',
      parentId: null,
      createdAt: FIXED_NOW,
      fromModel: 'claude-3-5-sonnet',
      toModel: 'claude-3-7-sonnet',
      fromProvider: 'anthropic',
      toProvider: 'anthropic',
      reason: 'user switched',
    };
    const row = serializeEntry(entry, 'sess-1', 2);
    expect(row.entry_type).toBe('model_change');
    expect(deserializeEntry(row)).toEqual(entry);
  });

  it('round-trips a mode_change entry', () => {
    const entry = {
      type: 'mode_change' as const,
      id: 'mode-1',
      parentId: null,
      createdAt: FIXED_NOW,
      fromMode: 'general',
      toMode: 'plan',
      reason: 'enter plan mode',
      source: 'user' as const,
    };
    const row = serializeEntry(entry, 'sess-1', 3);
    expect(row.entry_type).toBe('mode_change');
    expect(deserializeEntry(row)).toEqual(entry);
  });

  it('round-trips a branch entry', () => {
    const entry = {
      type: 'branch' as const,
      id: 'br-1',
      parentId: null,
      createdAt: FIXED_NOW,
      branchId: 'branch-1',
      fromEntryId: 'e1',
      label: 'investigate',
    };
    const row = serializeEntry(entry, 'sess-1', 4);
    expect(row.entry_type).toBe('branch');
    expect(deserializeEntry(row)).toEqual(entry);
  });

  it('round-trips a custom_state entry', () => {
    const entry = {
      type: 'custom_state' as const,
      id: 'cs-1',
      parentId: null,
      createdAt: FIXED_NOW,
      stateKind: 'checkpoint',
      payload: { completed: true },
    };
    const row = serializeEntry(entry, 'sess-1', 5);
    expect(row.entry_type).toBe('custom_state');
    expect(deserializeEntry(row)).toEqual(entry);
  });

  it('throws on an unknown entry type during deserialization', () => {
    const row: ConversationEntryRow = {
      id: 'x',
      session_id: 'sess-1',
      entry_type: 'unknown' as ConversationEntryRow['entry_type'],
      parent_id: null,
      created_at: FIXED_NOW,
      seq_index: 0,
      status: 'active',
      payload: '{}',
    };
    expect(() => deserializeEntry(row)).toThrow('Unknown entry type');
  });

  it('creates the table DDL with IF NOT EXISTS guards', () => {
    const ddl = createConversationEntriesTable();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS conversation_entries');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS');
  });
});

// ─── In-memory mock database ─────────────────────────────────────────────

/**
 * A minimal in-memory RepositoryDatabase that mirrors the subset of
 * better-sqlite3 behavior SqliteMessageRepository relies on. Rows are stored
 * in a plain array and filtered by the SQL shape each prepared statement
 * represents.
 */
class MemoryEntryDb implements RepositoryDatabase {
  rows: ConversationEntryRow[] = [];

  prepare(sql: string): RepositoryStatement {
    if (sql.includes('SELECT COALESCE(MAX(seq_index)')) {
      return {
        run: () => undefined,
        all: () => [],
        get: (sessionId: string) => {
          const max = this.rows
            .filter((row) => row.session_id === sessionId)
            .reduce((acc, row) => Math.max(acc, row.seq_index), -1);
          return { max_seq: max };
        },
      };
    }

    if (sql.includes('INSERT OR IGNORE INTO conversation_entries')) {
      return {
        run: (...params: unknown[]) => {
          const [
            id,
            session_id,
            entry_type,
            parent_id,
            created_at,
            seq_index,
            status,
            payload,
          ] = params as [
            string,
            string,
            ConversationEntryRow['entry_type'],
            string | null,
            number,
            number,
            string,
            string,
          ];
          if (this.rows.some((row) => row.id === id)) return;
          this.rows.push({
            id,
            session_id,
            entry_type,
            parent_id,
            created_at,
            seq_index,
            status,
            payload,
          });
        },
        all: () => [],
        get: () => undefined,
      };
    }

    if (sql.includes('WITH RECURSIVE branch')) {
      return {
        run: () => undefined,
        all: (leafId: string, sessionId: string) => {
          const byId = new Map(this.rows.map((row) => [row.id, row]));
          const result: ConversationEntryRow[] = [];
          let current = byId.get(leafId);
          while (current && current.session_id === sessionId && current.status === 'active') {
            result.push(current);
            current = current.parent_id ? byId.get(current.parent_id) : undefined;
          }
          return result.sort((a, b) => a.seq_index - b.seq_index);
        },
        get: () => undefined,
      };
    }

    if (sql.includes('SELECT * FROM conversation_entries') && sql.includes('ORDER BY seq_index')) {
      return {
        run: () => undefined,
        all: (sessionId: string) =>
          this.rows
            .filter((row) => row.session_id === sessionId && row.status === 'active')
            .sort((a, b) => a.seq_index - b.seq_index),
        get: () => undefined,
      };
    }

    if (sql.includes('UPDATE conversation_entries')) {
      return {
        run: (...ids: unknown[]) => {
          for (const id of ids) {
            const row = this.rows.find((r) => r.id === id && r.status === 'active');
            if (row) row.status = 'superseded';
          }
        },
        all: () => [],
        get: () => undefined,
      };
    }

    if (sql.includes('DELETE FROM conversation_entries')) {
      return {
        run: (sessionId: string) => {
          this.rows = this.rows.filter((row) => row.session_id !== sessionId);
        },
        all: () => [],
        get: () => undefined,
      };
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  }

  exec(sql: string): void {
    // No-op for the mock.
  }

  transaction<T>(fn: () => T): () => T {
    return fn;
  }
}

// ─── SqliteMessageRepository ─────────────────────────────────────────────

describe('SqliteMessageRepository', () => {
  it('appends entries with monotonic seq_index and loads them back in order', async () => {
    const db = new MemoryEntryDb();
    const repo = new SqliteMessageRepository(db);

    await repo.append('sess-1', [
      messageEntry('e1', user('u1', 'hello')),
      messageEntry('e2', user('u2', 'world')),
    ]);

    const loaded = await repo.loadSession('sess-1');
    expect(loaded.map((entry) => entry.id)).toEqual(['e1', 'e2']);
    expect(loaded.map((entry) => entry.type)).toEqual(['message', 'message']);
  });

  it('assigns seq_index continuing from the existing max', async () => {
    const db = new MemoryEntryDb();
    const repo = new SqliteMessageRepository(db);

    await repo.append('sess-1', [messageEntry('e1', user('u1', 'a'))]);
    await repo.append('sess-1', [messageEntry('e2', user('u2', 'b'))]);

    const rows = db.rows.filter((row) => row.session_id === 'sess-1');
    const seqs = rows.map((row) => row.seq_index);
    expect(seqs).toEqual([0, 1]);
  });

  it('ignores duplicate ids on re-append', async () => {
    const db = new MemoryEntryDb();
    const repo = new SqliteMessageRepository(db);

    await repo.append('sess-1', [messageEntry('e1', user('u1', 'a'))]);
    await repo.append('sess-1', [messageEntry('e1', user('u1-copy', 'a'))]);

    const loaded = await repo.loadSession('sess-1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('e1');
  });

  it('loads a branch by walking the parentId chain from the leaf', async () => {
    const db = new MemoryEntryDb();
    const repo = new SqliteMessageRepository(db);

    const root: MessageEntry = { type: 'message', id: 'e1', parentId: null, createdAt: FIXED_NOW, message: user('u1', 'root') };
    const child: MessageEntry = { type: 'message', id: 'e2', parentId: 'e1', createdAt: FIXED_NOW, message: user('u2', 'child') };
    const leaf: MessageEntry = { type: 'message', id: 'e3', parentId: 'e2', createdAt: FIXED_NOW, message: user('u3', 'leaf') };

    await repo.append('sess-1', [root, child, leaf]);

    const branch = await repo.loadBranch('sess-1', 'e3');
    expect(branch.map((entry) => entry.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('loads the full session when no leafId is provided', async () => {
    const db = new MemoryEntryDb();
    const repo = new SqliteMessageRepository(db);

    await repo.append('sess-1', [messageEntry('e1', user('u1', 'a')), messageEntry('e2', user('u2', 'b'))]);

    const branch = await repo.loadBranch('sess-1');
    expect(branch.map((entry) => entry.id)).toEqual(['e1', 'e2']);
  });

  it('marks entries as superseded so they are excluded from loads', async () => {
    const db = new MemoryEntryDb();
    const repo = new SqliteMessageRepository(db);

    await repo.append('sess-1', [messageEntry('e1', user('u1', 'a')), messageEntry('e2', user('u2', 'b'))]);
    await repo.markSuperseded(['e1']);

    const loaded = await repo.loadSession('sess-1');
    expect(loaded.map((entry) => entry.id)).toEqual(['e2']);
  });

  it('appends a compaction entry via appendCompaction', async () => {
    const db = new MemoryEntryDb();
    const repo = new SqliteMessageRepository(db);

    await repo.appendCompaction('sess-1', compactionEntry('c1'));

    const loaded = await repo.loadSession('sess-1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].type).toBe('compaction');
  });

  it('clears all entries for a session', async () => {
    const db = new MemoryEntryDb();
    const repo = new SqliteMessageRepository(db);

    await repo.append('sess-1', [messageEntry('e1', user('u1', 'a'))]);
    await repo.append('sess-2', [messageEntry('e2', user('u2', 'b'))]);
    await repo.clearSession('sess-1');

    expect(await repo.loadSession('sess-1')).toHaveLength(0);
    expect(await repo.loadSession('sess-2')).toHaveLength(1);
  });
});