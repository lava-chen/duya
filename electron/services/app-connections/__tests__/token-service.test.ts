/**
 * token-service.test.ts — Plan 312 Phase 1.
 *
 * Covers the TokenService lifecycle:
 *   - returns cached token when not yet expiring
 *   - refreshes when within the 5-minute skew
 *   - single-flight: concurrent calls share one refresh promise
 *   - invalid_grant → status flipped to `revoked`, vault cleared
 *   - missing connection / revoked connection → structured error
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
    AppConnectionTokenService: 'AppConnectionTokenService',
  },
}));

import { ConnectionStore } from '../connection-store';
import { TokenService } from '../token-service';
import type { TokenSet } from '../types';

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

/** In-memory vault stub so we don't need the safeStorage mock dance. */
class FakeVault {
  private map = new Map<string, TokenSet>();
  set(id: string, t: TokenSet) { this.map.set(id, { ...t }); }
  get(id: string): TokenSet | undefined { const v = this.map.get(id); return v ? { ...v } : undefined; }
  remove(id: string) { this.map.delete(id); }
  clear() { this.map.clear(); }
}

/** Fake fetch returning a fixed refresh response, recording calls. */
function makeFakeFetch(opts: {
  refreshResponse?: Record<string, unknown>;
  refreshStatus?: number;
  refreshLatencyMs?: number;
}) {
  const calls: Array<{ url: string; body: string }> = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    calls.push({ url: urlStr, body: init?.body?.toString() ?? '' });
    if (opts.refreshLatencyMs) {
      await new Promise((r) => setTimeout(r, opts.refreshLatencyMs));
    }
    if (urlStr.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify(opts.refreshResponse ?? {
        access_token: 'ya29.refreshed',
        refresh_token: 'rt-rotated',
        expires_in: 3600,
        token_type: 'Bearer',
      }), {
        status: opts.refreshStatus ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  };
  return { fakeFetch, calls };
}

describe('TokenService', () => {
  let db: DatabaseType;
  let store: ConnectionStore;
  let vault: FakeVault;

  beforeEach(() => {
    db = makeDb();
    store = new ConnectionStore(db);
    vault = new FakeVault();
  });

  function seedConnection(opts: {
    id: string;
    provider?: 'google' | 'slack' | 'microsoft365';
    status?: 'connected' | 'expired' | 'revoked' | 'disconnected';
    expiresAt?: number | null;
    refreshToken?: string;
  }) {
    const id = opts.id;
    const provider = opts.provider ?? 'google';
    store.upsert({
      id,
      provider,
      accountLabel: 'alice@example.com',
      accountId: 'sub-1',
      scopes: ['openid'],
      status: opts.status ?? 'connected',
      expiresAt: opts.expiresAt ?? null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const tokens: TokenSet = {
      accessToken: 'ya29.original',
      refreshToken: opts.refreshToken ?? 'rt-original',
      expiresAt: opts.expiresAt ?? null,
      tokenType: 'Bearer',
      scopes: ['openid'],
    };
    vault.set(id, tokens);
  }

  it('returns cached token when far from expiry (no refresh)', async () => {
    seedConnection({
      id: 'c-fresh',
      expiresAt: Date.now() + 60 * 60 * 1000, // 1h
    });
    const { fakeFetch, calls } = makeFakeFetch({});
    const svc = new TokenService({ store, vault: vault as never, fetchImpl: fakeFetch as unknown as typeof fetch });

    const result = await svc.getValidToken('c-fresh');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accessToken).toBe('ya29.original');
      expect(result.data.refreshed).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it('refreshes when within 5-minute skew', async () => {
    seedConnection({
      id: 'c-soon',
      expiresAt: Date.now() + 60 * 1000, // 1 min
    });
    const { fakeFetch, calls } = makeFakeFetch({});
    const svc = new TokenService({ store, vault: vault as never, fetchImpl: fakeFetch as unknown as typeof fetch });

    const result = await svc.getValidToken('c-soon');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accessToken).toBe('ya29.refreshed');
      expect(result.data.refreshed).toBe(true);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain('grant_type=refresh_token');

    // Vault updated with rotated token; status stays connected
    expect(vault.get('c-soon')?.accessToken).toBe('ya29.refreshed');
    expect(vault.get('c-soon')?.refreshToken).toBe('rt-rotated');
    expect(store.get('c-soon')?.status).toBe('connected');
  });

  it('single-flight: concurrent refresh calls share one promise', async () => {
    seedConnection({
      id: 'c-concurrent',
      expiresAt: Date.now() + 60 * 1000,
    });
    const { fakeFetch, calls } = makeFakeFetch({ refreshLatencyMs: 30 });
    const svc = new TokenService({ store, vault: vault as never, fetchImpl: fakeFetch as unknown as typeof fetch });

    const [r1, r2] = await Promise.all([
      svc.getValidToken('c-concurrent'),
      svc.getValidToken('c-concurrent'),
    ]);

    expect(r1.success && r2.success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('invalid_grant → status revoked, vault cleared, connection_revoked returned', async () => {
    seedConnection({
      id: 'c-revoked',
      expiresAt: Date.now() + 60 * 1000,
    });
    const { fakeFetch } = makeFakeFetch({
      refreshStatus: 400,
      refreshResponse: { error: 'invalid_grant', error_description: 'refresh token expired' },
    });
    const svc = new TokenService({ store, vault: vault as never, fetchImpl: fakeFetch as unknown as typeof fetch });

    const result = await svc.getValidToken('c-revoked');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('connection_revoked');
      expect(result.error.retriable).toBe(false);
    }
    expect(vault.get('c-revoked')).toBeUndefined();
    expect(store.get('c-revoked')?.status).toBe('revoked');
    expect(store.get('c-revoked')?.lastError).toBe('invalid_grant');
  });

  it('non-invalid_grant refresh error → provider_error (retriable), status NOT revoked', async () => {
    seedConnection({
      id: 'c-5xx',
      expiresAt: Date.now() + 60 * 1000,
    });
    const { fakeFetch } = makeFakeFetch({
      refreshStatus: 503,
      refreshResponse: { error: 'server_error' },
    });
    const svc = new TokenService({ store, vault: vault as never, fetchImpl: fakeFetch as unknown as typeof fetch });

    const result = await svc.getValidToken('c-5xx');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('provider_error');
      expect(result.error.retriable).toBe(true);
    }
    // Vault entry preserved — caller can retry later
    expect(vault.get('c-5xx')?.accessToken).toBe('ya29.original');
    expect(store.get('c-5xx')?.status).toBe('connected');
  });

  it('missing connection → connection_not_found', async () => {
    const { fakeFetch } = makeFakeFetch({});
    const svc = new TokenService({ store, vault: vault as never, fetchImpl: fakeFetch as unknown as typeof fetch });

    const result = await svc.getValidToken('does-not-exist');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('connection_not_found');
    }
  });

  it('revoked connection → connection_not_available', async () => {
    seedConnection({ id: 'c-r', status: 'revoked' });
    const { fakeFetch, calls } = makeFakeFetch({});
    const svc = new TokenService({ store, vault: vault as never, fetchImpl: fakeFetch as unknown as typeof fetch });

    const result = await svc.getValidToken('c-r');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('connection_not_available');
    }
    expect(calls).toHaveLength(0); // sanity: no network call
  });

  it('no expiry → returns token immediately (no refresh attempt)', async () => {
    seedConnection({ id: 'c-no-expiry', expiresAt: null });
    const { fakeFetch, calls } = makeFakeFetch({});
    const svc = new TokenService({ store, vault: vault as never, fetchImpl: fakeFetch as unknown as typeof fetch });

    const result = await svc.getValidToken('c-no-expiry');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accessToken).toBe('ya29.original');
    }
    expect(calls).toHaveLength(0);
  });

  it('vault entry missing (state drift) → connection_revoked + status flip', async () => {
    seedConnection({ id: 'c-drift' });
    vault.remove('c-drift');
    const { fakeFetch } = makeFakeFetch({});
    const svc = new TokenService({ store, vault: vault as never, fetchImpl: fakeFetch as unknown as typeof fetch });

    const result = await svc.getValidToken('c-drift');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('connection_revoked');
    }
    expect(store.get('c-drift')?.status).toBe('revoked');
  });
});
