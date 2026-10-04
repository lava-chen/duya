/**
 * connection-store.test.ts — Plan 312 Phase 0.
 *
 * Uses an in-memory better-sqlite3 database and the shared schema
 * initializer to verify the connection state machine:
 *   disconnected → pending → connected → expired → revoked → disconnected.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { asAppConnectorId } from '@duya/plugin-core/connectors/app-connector-id';
const GOOGLE = asAppConnectorId('google');
const SLACK = asAppConnectorId('slack');
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

import { ConnectionStore } from '../connection-store';
import { makeAppConnectionsDb } from './app-connections-db';

function makeDb(): DatabaseType {
  return makeAppConnectionsDb();
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
      provider: GOOGLE,
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
      provider: SLACK,
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
      provider: GOOGLE,
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
      provider: SLACK,
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
    expect(store.listByProvider(GOOGLE).length).toBe(1);
    expect(store.listByProvider(SLACK)[0].id).toBe('b');
  });

  it('remove', () => {
    const store = new ConnectionStore(db);
    store.upsert({
      id: 'c3',
      provider: GOOGLE,
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

  // --- Plan 580 D7: stable connection slugs ---

  it('D7: first connection holds the bare slug, later ones derive 4-hex slugs', () => {
    const store = new ConnectionStore(db);
    const first = store.upsert({
      id: 'conn-first', provider: GOOGLE, accountLabel: 'a', accountId: '1',
      scopes: [], status: 'connected', expiresAt: null, lastError: null,
      createdAt: 1, updatedAt: 1,
    });
    const second = store.upsert({
      id: 'conn-second', provider: GOOGLE, accountLabel: 'b', accountId: '2',
      scopes: [], status: 'connected', expiresAt: null, lastError: null,
      createdAt: 2, updatedAt: 2,
    });
    expect(first.connectionSlug).toBe('');
    expect(second.connectionSlug).toMatch(/^[0-9a-f]{4,8}$/);
    expect(second.connectionSlug).not.toBe('');
  });

  it('D7: reconnecting (upsert same id) keeps the assigned slug for life', () => {
    const store = new ConnectionStore(db);
    store.upsert({
      id: 'conn-x', provider: GOOGLE, accountLabel: 'a', accountId: '1',
      scopes: [], status: 'connected', expiresAt: null, lastError: null,
      createdAt: 1, updatedAt: 1,
    });
    const original = store.get('conn-x')?.connectionSlug;
    store.upsert({
      id: 'conn-x', provider: GOOGLE, accountLabel: 'a2', accountId: '1',
      scopes: [], status: 'disconnected', expiresAt: null, lastError: null,
      createdAt: 1, updatedAt: 2,
    });
    expect(store.get('conn-x')?.connectionSlug).toBe(original);
  });

  it('D7: slugs are unique within a provider even when ids hash-collide', () => {
    const store = new ConnectionStore(db);
    const seen = new Set<string>();
    // Derive many slugs; the allocator must never repeat one within the
    // provider. (The first connection legitimately holds '' — it starts
    // in `seen` via the loop itself.)
    for (let i = 0; i < 12; i++) {
      const conn = store.upsert({
        id: `conn-hash-${i}`, provider: GOOGLE, accountLabel: `a${i}`, accountId: String(i),
        scopes: [], status: 'connected', expiresAt: null, lastError: null,
        createdAt: i + 1, updatedAt: i + 1,
      });
      const slug = conn.connectionSlug ?? '';
      expect(seen.has(slug)).toBe(false);
      seen.add(slug);
    }
  });

  it('D7: a new connection after the bare holder was removed derives a fresh slug (existing connections unaffected)', () => {
    const store = new ConnectionStore(db);
    store.upsert({
      id: 'conn-1', provider: GOOGLE, accountLabel: 'a', accountId: '1',
      scopes: [], status: 'connected', expiresAt: null, lastError: null,
      createdAt: 1, updatedAt: 1,
    });
    const second = store.upsert({
      id: 'conn-2', provider: GOOGLE, accountLabel: 'b', accountId: '2',
      scopes: [], status: 'connected', expiresAt: null, lastError: null,
      createdAt: 2, updatedAt: 2,
    });
    const secondSlug = second.connectionSlug ?? '';
    expect(secondSlug).not.toBe('');
    // The bare holder is deleted.
    store.remove('conn-1');
    // Existing derived connection is never promoted (slug immutable).
    expect(store.get('conn-2')?.connectionSlug).toBe(secondSlug);
    // A new connection while conn-2 still exists derives a fresh slug —
    // conn-2's namespace is untouched.
    const third = store.upsert({
      id: 'conn-3', provider: GOOGLE, accountLabel: 'c', accountId: '3',
      scopes: [], status: 'connected', expiresAt: null, lastError: null,
      createdAt: 3, updatedAt: 3,
    });
    expect(third.connectionSlug).not.toBe('');
    expect(third.connectionSlug).not.toBe(secondSlug);
    // Once the provider has NO connections left, the next one re-claims
    // the bare namespace.
    store.remove('conn-2');
    store.remove('conn-3');
    const fourth = store.upsert({
      id: 'conn-4', provider: GOOGLE, accountLabel: 'd', accountId: '4',
      scopes: [], status: 'connected', expiresAt: null, lastError: null,
      createdAt: 4, updatedAt: 4,
    });
    expect(fourth.connectionSlug).toBe('');
  });

  it('D7: tool-alias bytes — single connection unchanged, two connections coexist', async () => {
    const { allocateConnectionToolAlias, connectionNamespace } = await import(
      '@duya/plugin-core/mcp/core/alias'
    );
    // Single connection (slug ''): byte-identical to the pre-580
    // `remote_<provider>_<tool>` form.
    const single = allocateConnectionToolAlias(connectionNamespace('notion', ''), 'search', new Set());
    expect(single).toBe('remote_notion_search');
    // Two connections: the bare namespace and the slug namespace never
    // collide — both aliases coexist.
    const second = allocateConnectionToolAlias(
      connectionNamespace('notion', 'a31f'), 'search', new Set([single]),
    );
    expect(second).toBe('remote_notion_a31f_search');
    expect(second).not.toBe(single);
  });
});
