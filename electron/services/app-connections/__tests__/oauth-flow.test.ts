/**
 * oauth-flow.test.ts — Plan 312 Phase 1.
 *
 * Covers the flow orchestrator's state machine:
 *   - happy path: PKCE → loopback redirect → token exchange →
 *     userinfo → vault + store written → status DTO returned
 *   - token endpoint error → FlowError('token_exchange_failed')
 *   - invalid_grant → FlowError('invalid_grant')
 *   - vault unavailable → FlowError('vault_unavailable')
 *   - redirect failure → FlowError('redirect_failed')
 *
 * The loopback server and external browser are bypassed by injecting
 * a fake fetch + openExternal and by stubbing the loopback module
 * via a hoisted state object. Real loopback behavior (state nonce
 * validation, port binding, timeout) is covered by the loopback-server
 * unit test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Hoisted state shared with the (hoisted) vi.mock factories. ---
const state = vi.hoisted(() => ({
  tempDir: '',
  encryptionAvailable: true,
  openExternalCalls: [] as string[],
  /**
   * Controls the stubbed loopback server's waitForCode behavior.
   *   'resolve' → resolves with the captured code
   *   'reject'  → rejects with LoopbackServerError
   * The captured code/state are written to `state.capturedCode`
   * and `state.capturedState` when waitForCode is called.
   */
  loopbackMode: 'resolve' as 'resolve' | 'reject',
  capturedCode: 'auth-code-xyz',
  waitForCodeCalls: 0,
}));

vi.mock('electron', () => ({
  app: { getPath: () => state.tempDir },
  safeStorage: {
    isEncryptionAvailable: () => state.encryptionAvailable,
    encryptString: (data: string) => Buffer.from(`encrypted:${data}`, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8').replace(/^encrypted:/, ''),
  },
  shell: {
    openExternal: (url: string) => {
      state.openExternalCalls.push(url);
      return Promise.resolve();
    },
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  LogComponent: {
    AppConnectionFlow: 'AppConnectionFlow',
    AppConnectionVault: 'AppConnectionVault',
    AppConnectionService: 'AppConnectionService',
  },
}));

vi.mock('../oauth/loopback-server', () => ({
  startLoopbackServer: async () => ({
    port: 54321,
    redirectUri: 'http://127.0.0.1:54321/callback/google',
    waitForCode: () => {
      state.waitForCodeCalls++;
      if (state.loopbackMode === 'reject') {
        const err = new Error('loopback timed out');
        err.name = 'LoopbackServerError';
        return Promise.reject(err);
      }
      return Promise.resolve({ code: state.capturedCode, state: 'stub-state' });
    },
    close: () => { /* noop */ },
  }),
  LoopbackServerError: class extends Error {
    constructor(m: string) { super(m); this.name = 'LoopbackServerError'; }
  },
}));

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { ConnectionStore } from '../connection-store';
import { TokenVault } from '../token-vault';

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

/** Fake fetch that responds to the token + userinfo endpoints. */
function makeFakeFetch(opts: {
  tokenResponse?: Record<string, unknown>;
  tokenStatus?: number;
  userinfoResponse?: Record<string, unknown>;
  userinfoStatus?: number;
}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    calls.push({ url: urlStr, method: init?.method ?? 'GET', body: init?.body?.toString() });

    if (urlStr.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify(opts.tokenResponse ?? {
        access_token: 'ya29.fake-token',
        refresh_token: 'rt-fake',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid email',
      }), {
        status: opts.tokenStatus ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (urlStr.includes('googleapis.com/oauth2/v3/userinfo')) {
      return new Response(JSON.stringify(opts.userinfoResponse ?? {
        sub: 'sub-123',
        email: 'alice@example.com',
      }), {
        status: opts.userinfoStatus ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  };
  return { fakeFetch, calls };
}

describe('startAuthorization (oauth flow)', () => {
  let db: DatabaseType;
  let store: ConnectionStore;
  let vault: TokenVault;

  beforeEach(() => {
    state.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-flow-'));
    state.encryptionAvailable = true;
    state.openExternalCalls = [];
    state.loopbackMode = 'resolve';
    state.capturedCode = 'auth-code-xyz';
    state.waitForCodeCalls = 0;
    vi.resetModules();
    db = makeDb();
    store = new ConnectionStore(db);
    vault = new TokenVault();
  });

  afterEach(() => {
    if (state.tempDir && fs.existsSync(state.tempDir)) {
      fs.rmSync(state.tempDir, { recursive: true, force: true });
    }
  });

  it('happy path: exchanges code, fetches userinfo, persists vault + store, returns DTO', async () => {
    const { startAuthorization } = await import('../oauth/flow');
    const { fakeFetch, calls } = makeFakeFetch({});

    const dto = await startAuthorization('google', {
      upsertConnection: (c) => store.upsert(c),
      storeTokens: (id, t) => vault.set(id, t),
    }, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      connectionId: 'conn-happy',
    });

    expect(dto.status).toBe('connected');
    expect(dto.id).toBe('conn-happy');
    expect(dto.provider).toBe('google');
    expect(dto.accountLabel).toBe('alice@example.com');
    expect(dto.accountId).toBe('sub-123');
    expect(dto.expiresAt).toBeGreaterThan(Date.now());

    const tokens = vault.get('conn-happy');
    expect(tokens?.accessToken).toBe('ya29.fake-token');
    expect(tokens?.refreshToken).toBe('rt-fake');

    const conn = store.get('conn-happy');
    expect(conn?.status).toBe('connected');

    expect(state.openExternalCalls).toHaveLength(1);
    expect(state.openExternalCalls[0]).toContain('accounts.google.com');
    expect(state.openExternalCalls[0]).toContain('code_challenge_method=S256');
    expect(state.openExternalCalls[0]).toContain('response_type=code');
    expect(calls.some((c) => c.url.includes('oauth2.googleapis.com/token'))).toBe(true);
    expect(state.waitForCodeCalls).toBe(1);
  });

  it('token endpoint error → FlowError(token_exchange_failed)', async () => {
    const { startAuthorization } = await import('../oauth/flow');
    const { fakeFetch } = makeFakeFetch({
      tokenStatus: 400,
      tokenResponse: { error: 'bad_verification_code', error_description: 'stale code' },
    });

    await expect(
      startAuthorization('google', {
        upsertConnection: (c) => store.upsert(c),
        storeTokens: (id, t) => vault.set(id, t),
      }, {
        fetchImpl: fakeFetch as unknown as typeof fetch,
        connectionId: 'conn-err',
      }),
    ).rejects.toMatchObject({ code: 'token_exchange_failed' });

    expect(vault.get('conn-err')).toBeUndefined();
  });

  it('invalid_grant → FlowError(invalid_grant)', async () => {
    const { startAuthorization } = await import('../oauth/flow');
    const { fakeFetch } = makeFakeFetch({
      tokenStatus: 400,
      tokenResponse: { error: 'invalid_grant', error_description: 'bad code' },
    });

    await expect(
      startAuthorization('google', {
        upsertConnection: (c) => store.upsert(c),
        storeTokens: (id, t) => vault.set(id, t),
      }, {
        fetchImpl: fakeFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('vault unavailable → FlowError(vault_unavailable)', async () => {
    state.encryptionAvailable = false;
    const { startAuthorization } = await import('../oauth/flow');
    const { VaultUnavailableError } = await import('../token-vault');
    const { fakeFetch } = makeFakeFetch({});

    await expect(
      startAuthorization('google', {
        upsertConnection: (c) => store.upsert(c),
        storeTokens: () => { throw new VaultUnavailableError(); },
      }, {
        fetchImpl: fakeFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'vault_unavailable' });
  });

  it('redirect failure → FlowError(redirect_failed)', async () => {
    state.loopbackMode = 'reject';
    const { startAuthorization } = await import('../oauth/flow');
    const { fakeFetch } = makeFakeFetch({});

    await expect(
      startAuthorization('google', {
        upsertConnection: (c) => store.upsert(c),
        storeTokens: (id, t) => vault.set(id, t),
      }, {
        fetchImpl: fakeFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'redirect_failed' });
  });
});
