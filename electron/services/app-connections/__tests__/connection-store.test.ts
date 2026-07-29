/**
 * connection-store.test.ts — Plan 312 Phase 0.
 *
 * Uses an in-memory better-sqlite3 database and the shared schema
 * initializer to verify the connection state machine:
 *   disconnected → pending → connected → expired → revoked → disconnected.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  LogComponent: {
    AppConnectionStore: 'AppConnectionStore',
    DB: 'DB',
    DBMigration: 'DBMigration',
  },
}));

function makeDb(): DatabaseType {
  const db = new Database(':memory:') as unknown as DatabaseType;
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      account_label TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL DEFAULT '',
      scopes TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'disconnected',
      expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

describe('ConnectionStore', () => {
  let db: DatabaseType;
  let ConnectionStore: typeof import('../connection-store').ConnectionStore;

  beforeEach(async () => {
    db = makeDb();
    vi.resetModules();
    ({ ConnectionStore } = await import('../connection-store'));
  });

  it('upsert + get roundtrip', () => {
    const store = new ConnectionStore(db);
    const conn = store.upsert({
      id: 'c1',
      provider: 'google',
      accountLabel: 'alice@example.com',
      accountId: 'sub-123',
      scopes: ['drive.read', 'gmail.send'],
      status: 'connected',
      expiresAt: 9999,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(conn.id).toBe('c1');
    const fetched = store.get('c1');
    expect(fetched?.accountLabel).toBe('alice@example.com');
    expect(fetched?.scopes).toEqual(['drive.read', 'gmail.send']);
  });

  it('state machine transitions: pending → connected → expired → revoked → disconnected', () => {
    const store = new ConnectionStore(db);
    store.upsert({
      id: 'c2',
      provider: 'slack',
      accountLabel: 'bob',
      accountId: 'U123',
      scopes: [],
      status: 'pending',
      expiresAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(store.get('c2')?.status).toBe('pending');

    store.updateStatus('c2', 'connected', { expiresAt: 12345 });
    expect(store.get('c2')?.status).toBe('connected');
    expect(store.get('c2')?.expiresAt).toBe(12345);

    store.updateStatus('c2', 'expired');
    expect(store.get('c2')?.status).toBe('expired');

    store.updateStatus('c2', 'revoked', { lastError: 'invalid_grant' });
    expect(store.get('c2')?.status).toBe('revoked');
    expect(store.get('c2')?.lastError).toBe('invalid_grant');

    store.updateStatus('c2', 'disconnected', { lastError: null, expiresAt: null });
    expect(store.get('c2')?.status).toBe('disconnected');
    expect(store.get('c2')?.lastError).toBeNull();
  });

  it('list + listByProvider', () => {
    const store = new ConnectionStore(db);
    store.upsert({
      id: 'a',
      provider: 'google',
      accountLabel: 'a',
      accountId: '1',
      scopes: [],
      status: 'connected',
      expiresAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });
    store.upsert({
      id: 'b',
      provider: 'slack',
      accountLabel: 'b',
      accountId: '2',
      scopes: [],
      status: 'disconnected',
      expiresAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(store.list().length).toBe(2);
    expect(store.listByProvider('google').length).toBe(1);
    expect(store.listByProvider('slack')[0].id).toBe('b');
  });

  it('remove', () => {
    const store = new ConnectionStore(db);
    store.upsert({
      id: 'c3',
      provider: 'google',
      accountLabel: '',
      accountId: '',
      scopes: [],
      status: 'disconnected',
      expiresAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(store.remove('c3')).toBe(true);
    expect(store.get('c3')).toBeUndefined();
    expect(store.remove('does-not-exist')).toBe(false);
  });

  it('malformed scopes JSON falls back to empty array', () => {
    const store = new ConnectionStore(db);
    db.prepare(
      `INSERT INTO app_connections (id, provider, account_label, account_id, scopes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('bad', 'google', '', '', 'not-json', 'connected', 1, 1);
    expect(store.get('bad')?.scopes).toEqual([]);
  });

  it('updateStatus returns undefined for unknown id', () => {
    const store = new ConnectionStore(db);
    expect(store.updateStatus('nope', 'connected')).toBeUndefined();
  });
});
