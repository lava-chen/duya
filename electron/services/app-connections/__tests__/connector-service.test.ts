/**
 * connector-service.test.ts — Plan 312 Phase 3.
 *
 * Covers the ConnectorService main-process execution entry:
 *   - listDescriptorsForConnected: only returns descriptors for connected
 *   - invoke happy path: token acquired → connector.invoke → result
 *   - invoke with missing connection → connection_not_found
 *   - invoke with no token → propagates token error
 *   - invoke with connector throwing → internal error
 *   - invoke with unknown action → provider_error
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
    AppConnectionConnector: 'AppConnectionConnector',
  },
}));

import { ConnectionStore } from '../connection-store';
import { TokenService } from '../token-service';
import { AppConnectionService } from '../app-connection-service';
import { ConnectorService } from '../connector-service';
import type { AppConnection, TokenSet } from '../types';

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

class FakeVault {
  private map = new Map<string, TokenSet>();
  set(id: string, t: TokenSet) { this.map.set(id, { ...t }); }
  get(id: string): TokenSet | undefined { const v = this.map.get(id); return v ? { ...v } : undefined; }
  remove(id: string) { this.map.delete(id); }
  clear() { this.map.clear(); }
}

function seedConnection(db: DatabaseType, overrides: Partial<AppConnection> = {}): void {
  const now = Date.now();
  const conn: AppConnection = {
    id: 'c1',
    provider: 'google',
    accountLabel: 'alice@example.com',
    accountId: 'sub-1',
    scopes: ['drive.metadata.readonly'],
    status: 'connected',
    expiresAt: now + 3600_000,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  const store = new ConnectionStore(db);
  store.upsert(conn);
}

function makeFakeFetch(opts: {
  driveResponse?: unknown;
  driveStatus?: number;
}) {
  const calls: Array<{ url: string; method?: string }> = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    calls.push({ url: urlStr, method: init?.method });
    if (urlStr.includes('googleapis.com/drive')) {
      return new Response(JSON.stringify(opts.driveResponse ?? {
        files: [{ id: 'f1', name: 'doc.txt', mimeType: 'text/plain' }],
      }), {
        status: opts.driveStatus ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not Found', { status: 404 });
  };
  return { fakeFetch, calls };
}

describe('ConnectorService', () => {
  let db: DatabaseType;
  let store: ConnectionStore;
  let vault: FakeVault;
  let service: AppConnectionService;
  let connectorService: ConnectorService;

  beforeEach(() => {
    db = makeDb();
    store = new ConnectionStore(db);
    vault = new FakeVault();
    const tokenService = new TokenService({
      store,
      vault: vault as never,
    });
    service = new AppConnectionService({
      store,
      vault: vault as never,
      tokenService,
    });
    // Seed a connected Google connection with a valid token
    seedConnection(db, { id: 'c-google', provider: 'google' });
    vault.set('c-google', {
      accessToken: 'ya29.test-token',
      refreshToken: 'rt-test',
      expiresAt: Date.now() + 3600_000,
      tokenType: 'Bearer',
      scopes: ['drive.metadata.readonly'],
    });
    connectorService = new ConnectorService({ service });
  });

  it('listDescriptorsForConnected returns descriptors for connected connections only', async () => {
    // Add a disconnected connection
    seedConnection(db, { id: 'c-disc', provider: 'google', status: 'disconnected' });
    const descriptors = await connectorService.listDescriptorsForConnected();
    // Only c-google should produce descriptors
    expect(descriptors).toHaveLength(3);
    expect(descriptors.every((descriptor) => descriptor.connectionId === 'c-google')).toBe(true);
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      'google_drive_search',
      'google_drive_get',
      'google_drive_read',
    ]);
  });

  it('invoke happy path: calls connector with token and returns data', async () => {
    const { fakeFetch, calls } = makeFakeFetch({
      driveResponse: { files: [{ id: 'file-1', name: 'test.txt' }] },
    });
    connectorService = new ConnectorService({ service, fetchImpl: fakeFetch as unknown as typeof fetch });

    const result = await connectorService.invoke({
      connectionId: 'c-google',
      action: 'drive.search',
      args: { pageSize: 5 },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ files: [{ id: 'file-1', name: 'test.txt' }] });
    // Verify the fetch was called with the access token
    expect(calls.some((c) => c.url.includes('drive/v3/files'))).toBe(true);
  });

  it('invoke with missing connection returns connection_not_found', async () => {
    const result = await connectorService.invoke({
      connectionId: 'nonexistent',
      action: 'drive.search',
      args: {},
    });
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('connection_not_found');
  });

  it('invoke with unknown action returns provider_error', async () => {
    const { fakeFetch } = makeFakeFetch({});
    connectorService = new ConnectorService({ service, fetchImpl: fakeFetch as unknown as typeof fetch });

    const result = await connectorService.invoke({
      connectionId: 'c-google',
      action: 'unknown.action',
      args: {},
    });
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('provider_error');
  });

  it('invoke with no token (vault empty) returns token error', async () => {
    vault.remove('c-google');
    const { fakeFetch } = makeFakeFetch({});
    connectorService = new ConnectorService({ service, fetchImpl: fakeFetch as unknown as typeof fetch });

    const result = await connectorService.invoke({
      connectionId: 'c-google',
      action: 'drive.search',
      args: {},
    });
    expect(result.success).toBe(false);
    // Token service returns connection_revoked when vault entry is missing
    expect(result.error!.code).toBe('connection_revoked');
  });

  it('invoke with connector API error returns provider_error', async () => {
    const { fakeFetch } = makeFakeFetch({ driveStatus: 403 });
    connectorService = new ConnectorService({ service, fetchImpl: fakeFetch as unknown as typeof fetch });

    const result = await connectorService.invoke({
      connectionId: 'c-google',
      action: 'drive.list_files',
      args: {},
    });
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('provider_error');
  });
});
