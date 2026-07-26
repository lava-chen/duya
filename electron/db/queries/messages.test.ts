import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { setDb } from '../connection';
import {
  getMessagesBySession,
  truncateMessagesAfter,
  truncateMessagesFromInclusive,
} from './messages';

const SESSION_ID = 'session-1';

interface MessageRecord {
  id: string;
  session_id: string;
  status: string;
  created_at: number;
  rowid: number;
}

class FakeMessageDatabase {
  readonly statements: string[] = [];
  readonly rows: MessageRecord[] = [];
  private nextRowId = 1;

  insert(id: string, createdAt: number, status = 'done'): void {
    this.rows.push({
      id,
      session_id: SESSION_ID,
      status,
      created_at: createdAt,
      rowid: this.nextRowId++,
    });
  }

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.statements.push(normalized);
    return {
      get: (messageId: string, sessionId: string) => {
        const row = this.rows.find((candidate) =>
          candidate.id === messageId && candidate.session_id === sessionId,
        );
        if (!row) return undefined;
        return normalized.includes('rowid')
          ? { created_at: row.created_at, rowid: row.rowid }
          : { created_at: row.created_at };
      },
      all: (sessionId: string) => this.rows
        .filter((row) => row.session_id === sessionId && !['superseded', 'purged'].includes(row.status))
        .sort((a, b) => a.created_at - b.created_at || a.rowid - b.rowid),
      run: (...args: unknown[]) => {
        if (normalized.startsWith("UPDATE messages SET status = 'superseded'")) {
          const [sessionId, createdAt, , rowid] = args as [string, number, number, number];
          const inclusive = normalized.includes('rowid >= ?');
          let changes = 0;
          for (const row of this.rows) {
            const isAfterTarget = row.created_at > createdAt ||
              (row.created_at === createdAt && (inclusive ? row.rowid >= rowid : row.rowid > rowid));
            if (row.session_id === sessionId && isAfterTarget && row.status !== 'superseded') {
              row.status = 'superseded';
              changes++;
            }
          }
          return { changes };
        }
        if (normalized.startsWith('UPDATE chat_sessions SET updated_at')) return { changes: 1 };
        throw new Error(`Unexpected SQL: ${normalized}`);
      },
    };
  }
}

let database: FakeMessageDatabase;

beforeEach(() => {
  database = new FakeMessageDatabase();
  setDb(database as unknown as Database.Database);
});

afterEach(() => {
  setDb(null);
});

function insertMessage(id: string, createdAt: number, status = 'done'): void {
  database.insert(id, createdAt, status);
}

function allRows(): Array<{ id: string; status: string }> {
  return database.rows.map(({ id, status }) => ({ id, status }));
}

describe('message truncation', () => {
  it('soft-deletes only rows after the target and preserves timestamp ordering', () => {
    insertMessage('target', 100);
    insertMessage('same-timestamp-after-target', 100);
    insertMessage('later', 101);
    insertMessage('already-superseded', 102, 'superseded');

    expect(truncateMessagesAfter(SESSION_ID, 'target')).toBe(2);
    expect(allRows()).toEqual([
      { id: 'target', status: 'done' },
      { id: 'same-timestamp-after-target', status: 'superseded' },
      { id: 'later', status: 'superseded' },
      { id: 'already-superseded', status: 'superseded' },
    ]);
    expect(getMessagesBySession(SESSION_ID).map((row) => row.id)).toEqual(['target']);
    expect(database.statements.some((sql) => sql.includes('DELETE FROM messages'))).toBe(false);
  });

  it('soft-deletes the target and every following row for edit-and-resend', () => {
    insertMessage('before', 100);
    insertMessage('target', 101);
    insertMessage('same-timestamp-after-target', 101);
    insertMessage('later', 102);

    expect(truncateMessagesFromInclusive(SESSION_ID, 'target')).toBe(3);
    expect(allRows()).toEqual([
      { id: 'before', status: 'done' },
      { id: 'target', status: 'superseded' },
      { id: 'same-timestamp-after-target', status: 'superseded' },
      { id: 'later', status: 'superseded' },
    ]);
    expect(getMessagesBySession(SESSION_ID).map((row) => row.id)).toEqual(['before']);
    expect(database.statements.some((sql) => sql.includes('DELETE FROM messages'))).toBe(false);
  });
});
