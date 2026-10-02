/**
 * app-connection-service.test.ts — Plan: remote-mcp-silent-reconnect.
 *
 * Verifies the silent-reconnect branch of AppConnectionService.connect:
 * when a remote MCP connection is in error state AND the vault still
 * holds a refresh token, connect() must call RemoteMcpConnector.ensureSession
 * with the EXISTING connectionId so the MCP SDK can silently refresh
 * the access token instead of opening the browser.
 *
 * Pre-fix, every restart forced a full OAuth round-trip because
 * startRemoteMcpAuthorization minted a fresh connectionId per call,
 * orphaning the stored refresh token.
 *
 * Also covers the boot-time `rehydrateRemoteMcpConnections` path that
 * restores sessions during app startup without user interaction.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { asAppConnectorId } from '@duya/plugin-core/connectors/app-connector-id';
const NOTION = asAppConnectorId('notion');
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
    AppConnection: 'AppConnection',
    AppConnectionStore: 'AppConnectionStore',
    AppConnectionVault: 'AppConnectionVault',
  },
}));

const oauthMocks = vi.hoisted(() => ({
  startRemoteMcpAuthorization: vi.fn(),
}));

vi.mock('../oauth/remote-mcp-flow', () => ({
  startRemoteMcpAuthorization: oauthMocks.startRemoteMcpAuthorization,
}));

import { ConnectionStore } from '../connection-store';
import { TokenService } from '../token-service';
import { AppConnectionService } from '../app-connection-service';
import type { AppConnection, TokenSet } from '../types';
import type { RemoteMcpConnector } from '../connectors/remote-mcp';

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
      updated_at INTEGER NOT NULL,
      connection_slug TEXT NOT NULL DEFAULT ''
    )
  `);
  return db;
}

class FakeVault {
  private tokens = new Map<string, TokenSet>();
  private mcpOAuth = new Map<string, Record<string, unknown>>();
  set(id: string, t: TokenSet): void { this.tokens.set(id, { ...t }); }
  get(id: string): TokenSet | undefined {
    const v = this.tokens.get(id);
    return v ? { ...v } : undefined;
  }
  remove(id: string): void { this.tokens.delete(id); }
  setMcpOAuth(id: string, state: Record<string, unknown>): void {
    this.mcpOAuth.set(id, { ...state });
  }
  getMcpOAuth(id: string): Record<string, unknown> | undefined {
    return this.mcpOAuth.get(id);
  }
  removeMcpOAuth(id: string): void { this.mcpOAuth.delete(id); }
  getOAuthClient(): undefined { return undefined; }
}

class FakeRemoteMcpConnector {
  ensureSession = vi.fn();
  disconnect = vi.fn();
  onTransportDead: ((id: string, reason: string) => void) | null = null;
}

function seedConnection(
  store: ConnectionStore,
  overrides: Partial<AppConnection>,
): AppConnection {
  const now = Date.now();
  return store.upsert({
    id: 'c-seed',
    provider: NOTION,
    accountLabel: '',
    accountId: '',
    scopes: [],
    status: 'connected',
    expiresAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function fakeToken(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: Date.now() + 3600_000,
    tokenType: 'Bearer',
    scopes: [],
    ...overrides,
  };
}

describe('AppConnectionService — silent reconnect (remote-mcp-silent-reconnect)', () => {
  let db: DatabaseType;
  let store: ConnectionStore;
  let vault: FakeVault;
  let remoteMcp: FakeRemoteMcpConnector;
  let service: AppConnectionService;

  beforeEach(() => {
    db = makeDb();
    store = new ConnectionStore(db);
    vault = new FakeVault();
    remoteMcp = new FakeRemoteMcpConnector();
    service = new AppConnectionService({
      store,
      vault: vault as never,
      tokenService: new TokenService({ store, vault: vault as never }),
    });
    service.setRemoteMcpConnector(remoteMcp as unknown as RemoteMcpConnector);

    remoteMcp.ensureSession.mockReset();
    remoteMcp.ensureSession.mockResolvedValue({
      connectionId: 'placeholder',
      test: [],
    } as never);

    oauthMocks.startRemoteMcpAuthorization.mockReset();
    oauthMocks.startRemoteMcpAuthorization.mockImplementation(
      async (provider, deps: { store: ConnectionStore }) => {
        const now = Date.now();
        deps.store.upsert({
          id: 'new-conn',
          provider,
          accountLabel: '',
          accountId: '',
          scopes: [],
          status: 'connected',
          expiresAt: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        });
        return {
          id: 'new-conn',
          provider,
          accountLabel: '',
          accountId: '',
          scopes: [],
          status: 'connected',
          expiresAt: null,
          lastError: null,
          connectionSlug: '',
          createdAt: now,
          updatedAt: now,
        };
      },
    );
  });

  it('silent reconnect reuses existing connectionId + stored refresh token', async () => {
    seedConnection(store, {
      id: 'notion-existing',
      status: 'error',
      lastError: 'Remote MCP stream died: transport closed',
    });
    vault.set('notion-existing', fakeToken());

    const dto = await service.connect(NOTION);

    expect(remoteMcp.ensureSession).toHaveBeenCalledTimes(1);
    const [connectionIdArg, configArg, scopesArg] = remoteMcp.ensureSession.mock.calls[0];
    expect(connectionIdArg).toBe('notion-existing');
    expect(configArg).toMatchObject({ remoteMcpUrl: 'https://mcp.notion.com/mcp' });
    expect(scopesArg).toBeUndefined();
    expect(oauthMocks.startRemoteMcpAuthorization).not.toHaveBeenCalled();
    expect(dto.id).toBe('notion-existing');
    expect(store.get('notion-existing')?.status).toBe('connected');
    expect(store.get('notion-existing')?.lastError).toBeNull();
  });

  it('silent reconnect prefers error-status row over disconnected row with stored tokens', async () => {
    seedConnection(store, {
      id: 'older-disc',
      status: 'disconnected',
      createdAt: 1000,
      updatedAt: 1000,
    });
    seedConnection(store, {
      id: 'recent-error',
      status: 'error',
      lastError: 'transport closed',
      createdAt: 2000,
      updatedAt: 2000,
    });
    vault.set('older-disc', fakeToken());
    vault.set('recent-error', fakeToken());

    await service.connect(NOTION);

    expect(remoteMcp.ensureSession).toHaveBeenCalledTimes(1);
    expect(remoteMcp.ensureSession.mock.calls[0][0]).toBe('recent-error');
    expect(oauthMocks.startRemoteMcpAuthorization).not.toHaveBeenCalled();
  });

  it('falls back to OAuth when ensureSession throws', async () => {
    seedConnection(store, { id: 'notion-existing', status: 'error' });
    vault.set('notion-existing', fakeToken({ refreshToken: 'rt-revoked' }));
    remoteMcp.ensureSession.mockRejectedValueOnce(new Error('refresh token rejected'));

    const dto = await service.connect(NOTION);

    expect(remoteMcp.ensureSession).toHaveBeenCalledTimes(1);
    expect(oauthMocks.startRemoteMcpAuthorization).toHaveBeenCalledTimes(1);
    expect(dto.id).toBe('new-conn');
  });

  it('skips silent reconnect when vault has no refresh token', async () => {
    seedConnection(store, { id: 'notion-existing', status: 'error' });
    // vault is empty

    await service.connect(NOTION);

    expect(remoteMcp.ensureSession).not.toHaveBeenCalled();
    expect(oauthMocks.startRemoteMcpAuthorization).toHaveBeenCalledTimes(1);
  });

  it('skips silent reconnect when no existing connection row exists', async () => {
    vault.set('phantom', fakeToken());

    await service.connect(NOTION);

    expect(remoteMcp.ensureSession).not.toHaveBeenCalled();
    expect(oauthMocks.startRemoteMcpAuthorization).toHaveBeenCalledTimes(1);
  });

  it('after OAuth, scrubs stale error rows for the same provider', async () => {
    seedConnection(store, { id: 'stale-1', provider: NOTION, status: 'error' });
    seedConnection(store, { id: 'stale-2', provider: NOTION, status: 'error' });
    vault.setMcpOAuth('stale-1', { clientInformation: { id: 'x' } });
    vault.setMcpOAuth('stale-2', { clientInformation: { id: 'y' } });

    await service.connect(NOTION);

    expect(oauthMocks.startRemoteMcpAuthorization).toHaveBeenCalledTimes(1);
    expect(store.get('stale-1')).toBeUndefined();
    expect(store.get('stale-2')).toBeUndefined();
    expect(vault.getMcpOAuth('stale-1')).toBeUndefined();
    expect(vault.getMcpOAuth('stale-2')).toBeUndefined();
  });

  it('after silent reconnect, stale error rows are preserved (cleanup is OAuth-only)', async () => {
    seedConnection(store, { id: 'notion-existing', status: 'error' });
    seedConnection(store, { id: 'stale', provider: NOTION, status: 'error' });
    vault.set('notion-existing', fakeToken());

    await service.connect(NOTION);

    expect(oauthMocks.startRemoteMcpAuthorization).not.toHaveBeenCalled();
    expect(store.get('notion-existing')?.status).toBe('connected');
    expect(store.get('stale')?.status).toBe('error');
  });

  it('silent reconnect is a no-op when RemoteMcpConnector was never installed', async () => {
    const bareService = new AppConnectionService({
      store,
      vault: vault as never,
      tokenService: new TokenService({ store, vault: vault as never }),
    });
    // NOTE: setRemoteMcpConnector intentionally not called.
    seedConnection(store, { id: 'notion-existing', status: 'error' });
    vault.set('notion-existing', fakeToken());

    await bareService.connect(NOTION);

    expect(oauthMocks.startRemoteMcpAuthorization).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------
  // boot rehydrate — Plan: remote-mcp-silent-reconnect
  // Walks every remote MCP provider + every existing row at boot,
  // brings dead ones back to `connected` using the stored refresh
  // token, and never throws (so a single broken connection cannot
  // abort startup).
  // ---------------------------------------------------------------

  it('rehydrate brings error-status rows back to connected', async () => {
    seedConnection(store, {
      id: 'r-stale',
      provider: NOTION,
      status: 'error',
      lastError: 'Remote MCP stream died: transport closed',
    });
    vault.set('r-stale', fakeToken());

    await service.rehydrateRemoteMcpConnections();

    expect(remoteMcp.ensureSession).toHaveBeenCalledTimes(1);
    expect(remoteMcp.ensureSession.mock.calls[0][0]).toBe('r-stale');
    expect(oauthMocks.startRemoteMcpAuthorization).not.toHaveBeenCalled();
    expect(store.get('r-stale')?.status).toBe('connected');
    expect(store.get('r-stale')?.lastError).toBeNull();
  });

  it('rehydrate also reconnects connected-status rows whose transport died before onTransportDead fired', async () => {
    seedConnection(store, { id: 'r-live', provider: NOTION, status: 'connected' });
    vault.set('r-live', fakeToken());

    await service.rehydrateRemoteMcpConnections();

    expect(remoteMcp.ensureSession).toHaveBeenCalledTimes(1);
    expect(remoteMcp.ensureSession.mock.calls[0][0]).toBe('r-live');
    expect(store.get('r-live')?.status).toBe('connected');
  });

  it('rehydrate skips rows with no stored refresh token', async () => {
    seedConnection(store, { id: 'r-no-tokens', provider: NOTION, status: 'error' });
    // vault is empty for this id.

    await service.rehydrateRemoteMcpConnections();

    expect(remoteMcp.ensureSession).not.toHaveBeenCalled();
    // Status left as-is so the UI keeps showing it and the user can
    // force a re-authorization via the toggle.
    expect(store.get('r-no-tokens')?.status).toBe('error');
  });

  it('rehydrate swallows ensureSession failures (non-fatal)', async () => {
    seedConnection(store, { id: 'r-revoked', provider: NOTION, status: 'error' });
    vault.set('r-revoked', fakeToken({ refreshToken: 'rt-revoked' }));
    remoteMcp.ensureSession.mockRejectedValue(new Error('refresh token rejected'));

    // Must NOT throw — a single broken connection cannot abort boot.
    await expect(service.rehydrateRemoteMcpConnections()).resolves.toBeUndefined();

    expect(remoteMcp.ensureSession).toHaveBeenCalledTimes(1);
    // Row stays in `error` so the UI can still surface the failure.
    expect(store.get('r-revoked')?.status).toBe('error');
  });

  it('rehydrate is a no-op when RemoteMcpConnector was never installed', async () => {
    const bareService = new AppConnectionService({
      store,
      vault: vault as never,
      tokenService: new TokenService({ store, vault: vault as never }),
    });
    // setRemoteMcpConnector intentionally not called.
    seedConnection(store, { id: 'r-stale', provider: NOTION, status: 'error' });
    vault.set('r-stale', fakeToken());

    await expect(
      bareService.rehydrateRemoteMcpConnections(),
    ).resolves.toBeUndefined();

    expect(remoteMcp.ensureSession).not.toHaveBeenCalled();
  });

  it('rehydrate continues past per-row failures (one bad row does not abort the rest)', async () => {
    seedConnection(store, { id: 'r-good', provider: NOTION, status: 'error' });
    seedConnection(store, { id: 'r-bad', provider: NOTION, status: 'error' });
    vault.set('r-good', fakeToken());
    vault.set('r-bad', fakeToken());

    remoteMcp.ensureSession
      .mockResolvedValueOnce({ connectionId: 'r-good', test: [] } as never)
      .mockRejectedValueOnce(new Error('transient'));

    await service.rehydrateRemoteMcpConnections();

    expect(remoteMcp.ensureSession).toHaveBeenCalledTimes(2);
    expect(store.get('r-good')?.status).toBe('connected');
    expect(store.get('r-bad')?.status).toBe('error');
  });
});