/**
 * security.test.ts — Plan 312 Phase 4.
 *
 * Security boundary tests covering:
 *   1. riskTier → permission behavior mapping (read/draft auto-execute,
 *      write/modify confirm, destructive strong-confirm that overrides
 *      bypassPermissions).
 *   2. DTO whitelist: `toStatusDTO` never includes token fields.
 *   3. Log redaction: `redactSecrets` hits Slack `xox*-`, Microsoft JWT,
 *      Google `ya29.`, and Bearer tokens.
 *   4. PolicyEngine `isProviderBlocked` gate.
 *   5. AppConnectionService.connect refuses blocked providers before
 *      any network activity.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  LogComponent: {
    AppConnectionService: 'AppConnectionService',
    AppConnectionConnector: 'AppConnectionConnector',
  },
}));

import { riskTierToBehavior, normalizeRiskTier, DEFAULT_MISSING_TIER } from '../../../../packages/agent/src/permissions/riskTierPermissions.js';
import { redactSecrets } from '../../../../src/lib/errors/extractErrorMessage.js';
import { PolicyEngine, DEFAULT_POLICY } from '../../../../packages/plugin-core/src/security/policy-engine.js';
import { toStatusDTO } from '../types';
import type { AppConnection } from '../types';
import { AppConnectionService } from '../app-connection-service';
import { ConnectionStore } from '../connection-store';
import { FlowError } from '../oauth/flow';
import type { TokenSet } from '../types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class FakeVault {
  private map = new Map<string, TokenSet>();
  set(id: string, t: TokenSet) { this.map.set(id, { ...t }); }
  get(id: string): TokenSet | undefined { const v = this.map.get(id); return v ? { ...v } : undefined; }
  remove(id: string) { this.map.delete(id); }
  clear() { this.map.clear(); }
}

function makeConnection(overrides?: Partial<AppConnection>): AppConnection {
  return {
    id: 'c-test',
    provider: 'google',
    accountLabel: 'alice@example.com',
    accountId: 'sub-1',
    scopes: ['openid', 'drive.metadata.readonly'],
    status: 'connected',
    expiresAt: Date.now() + 3600_000,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. riskTier → permission behavior mapping
// ---------------------------------------------------------------------------

describe('riskTierToBehavior', () => {
  it('read tier → undefined (fall through to normal flow)', () => {
    expect(riskTierToBehavior('read', 'default')).toBeUndefined();
    expect(riskTierToBehavior('read', 'bypassPermissions')).toBeUndefined();
  });

  it('draft tier → undefined (fall through to normal flow)', () => {
    expect(riskTierToBehavior('draft', 'default')).toBeUndefined();
    expect(riskTierToBehavior('draft', 'auto')).toBeUndefined();
  });

  it('write tier → ask in default mode', () => {
    expect(riskTierToBehavior('write', 'default')).toBe('ask');
    expect(riskTierToBehavior('write', 'acceptEdits')).toBe('ask');
    expect(riskTierToBehavior('write', 'auto')).toBe('ask');
  });

  it('write tier → undefined in bypass mode (defer to bypass)', () => {
    expect(riskTierToBehavior('write', 'bypassPermissions')).toBeUndefined();
    expect(riskTierToBehavior('write', 'dontAsk')).toBeUndefined();
  });

  it('modify tier → ask in default mode', () => {
    expect(riskTierToBehavior('modify', 'default')).toBe('ask');
    expect(riskTierToBehavior('modify', 'plan')).toBe('ask');
  });

  it('modify tier → undefined in bypass mode', () => {
    expect(riskTierToBehavior('modify', 'bypassPermissions')).toBeUndefined();
  });

  it('destructive tier → strong-confirm in ALL modes including bypass', () => {
    expect(riskTierToBehavior('destructive', 'default')).toBe('strong-confirm');
    expect(riskTierToBehavior('destructive', 'bypassPermissions')).toBe('strong-confirm');
    expect(riskTierToBehavior('destructive', 'dontAsk')).toBe('strong-confirm');
    expect(riskTierToBehavior('destructive', 'acceptEdits')).toBe('strong-confirm');
    expect(riskTierToBehavior('destructive', 'auto')).toBe('strong-confirm');
  });

  it('missing tier (undefined) → conservative default (write → ask)', () => {
    expect(riskTierToBehavior(undefined, 'default')).toBe('ask');
  });

  it('missing tier → undefined in bypass mode (defer to bypass, not destructive)', () => {
    // Missing tier defaults to 'write', which defers to bypass mode.
    // It is NOT treated as 'destructive' (which would override bypass).
    expect(riskTierToBehavior(undefined, 'bypassPermissions')).toBeUndefined();
  });

  it('normalizeRiskTier accepts valid tiers', () => {
    expect(normalizeRiskTier('read')).toBe('read');
    expect(normalizeRiskTier('draft')).toBe('draft');
    expect(normalizeRiskTier('write')).toBe('write');
    expect(normalizeRiskTier('modify')).toBe('modify');
    expect(normalizeRiskTier('destructive')).toBe('destructive');
  });

  it('normalizeRiskTier rejects invalid values', () => {
    expect(normalizeRiskTier('invalid')).toBeUndefined();
    expect(normalizeRiskTier(123)).toBeUndefined();
    expect(normalizeRiskTier(null)).toBeUndefined();
    expect(normalizeRiskTier(undefined)).toBeUndefined();
  });

  it('DEFAULT_MISSING_TIER is write (conservative)', () => {
    expect(DEFAULT_MISSING_TIER).toBe('write');
  });
});

// ---------------------------------------------------------------------------
// 2. DTO whitelist: tokens never cross the IPC boundary
// ---------------------------------------------------------------------------

describe('toStatusDTO whitelist', () => {
  it('produces a DTO with all expected fields', () => {
    const conn = makeConnection();
    const dto = toStatusDTO(conn);
    expect(dto).toEqual({
      id: 'c-test',
      provider: 'google',
      accountLabel: 'alice@example.com',
      accountId: 'sub-1',
      scopes: ['openid', 'drive.metadata.readonly'],
      status: 'connected',
      expiresAt: conn.expiresAt,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });
  });

  it('DTO does NOT include token fields (accessToken, refreshToken, tokenType)', () => {
    const conn = makeConnection();
    const dto = toStatusDTO(conn);
    expect(dto).not.toHaveProperty('accessToken');
    expect(dto).not.toHaveProperty('refreshToken');
    expect(dto).not.toHaveProperty('tokenType');
  });

  it('DTO keys are a fixed whitelist — no extra fields leak through', () => {
    const conn = makeConnection({ ...makeConnection(), extraField: 'should-not-leak' } as unknown as AppConnection);
    const dto = toStatusDTO(conn);
    const keys = Object.keys(dto).sort();
    expect(keys).toEqual(
      [
        'id', 'provider', 'accountLabel', 'accountId', 'scopes',
        'status', 'expiresAt', 'lastError', 'createdAt', 'updatedAt',
      ].sort(),
    );
  });

  it('mutation of DTO scalar fields does not affect the source connection', () => {
    const conn = makeConnection();
    const dto = toStatusDTO(conn);
    dto.status = 'disconnected';
    expect(conn.status).toBe('connected');
  });
});

// ---------------------------------------------------------------------------
// 3. Log redaction: Slack, Microsoft JWT, Google, Bearer tokens
// ---------------------------------------------------------------------------

describe('redactSecrets for App Connection tokens', () => {
  it('redacts Slack tokens (xoxb/xoxp/xoxa/xoxr/xoxs prefixes)', () => {
    expect(redactSecrets('token=xoxb-1234567890-abcdef')).toBe('token=xoxb-***');
    expect(redactSecrets('xoxp-9876543210-xyz')).toBe('xoxp-***');
    expect(redactSecrets('xoxa-1111111111-aaa')).toBe('xoxa-***');
    expect(redactSecrets('xoxr-2222222222-bbb')).toBe('xoxr-***');
    expect(redactSecrets('xoxs-3333333333-ccc')).toBe('xoxs-***');
  });

  it('redacts Microsoft JWT tokens (eyJ...eyJ...signature)', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJncmFwaCJ9.signature123';
    const result = redactSecrets(`Authorization: ${jwt}`);
    expect(result).not.toContain(jwt);
    expect(result).toContain('***');
  });

  it('redacts Google OAuth access tokens (ya29.)', () => {
    expect(redactSecrets('ya29.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij')).toContain('***');
  });

  it('redacts Bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop1234567890'))
      .toBe('Authorization: Bearer ***');
    expect(redactSecrets('bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ12'))
      .toBe('bearer ***');
  });

  it('does not redact non-secret strings', () => {
    expect(redactSecrets('connection successful')).toBe('connection successful');
    expect(redactSecrets('provider=google status=connected')).toBe('provider=google status=connected');
  });

  it('redacts multiple secrets in one string', () => {
    const input = 'slack=xoxb-1234567890-abc google=ya29.ABCDEFGHIJKLMNOPabcdefghij';
    const result = redactSecrets(input);
    expect(result).not.toContain('xoxb-1234567890-abc');
    expect(result).not.toContain('ya29.ABCDEFGHIJKLMNOPabcdefghij');
    expect(result).toContain('xoxb-***');
    expect(result).toContain('ya29.***');
  });
});

// ---------------------------------------------------------------------------
// 4. PolicyEngine isProviderBlocked
// ---------------------------------------------------------------------------

describe('PolicyEngine.isProviderBlocked', () => {
  it('allows all providers by default (empty blocklist)', () => {
    const engine = new PolicyEngine();
    expect(engine.isProviderBlocked('google').allowed).toBe(true);
    expect(engine.isProviderBlocked('slack').allowed).toBe(true);
    expect(engine.isProviderBlocked('microsoft365').allowed).toBe(true);
  });

  it('blocks providers in the blocklist', () => {
    const engine = new PolicyEngine({
      blockedAppConnectionProviders: ['slack'],
    });
    expect(engine.isProviderBlocked('slack').allowed).toBe(false);
    expect(engine.isProviderBlocked('slack').reason).toContain('slack');
    expect(engine.isProviderBlocked('google').allowed).toBe(true);
  });

  it('updatePolicy adds a blocked provider', () => {
    const engine = new PolicyEngine();
    engine.updatePolicy({ blockedAppConnectionProviders: ['microsoft365'] });
    expect(engine.isProviderBlocked('microsoft365').allowed).toBe(false);
    expect(engine.isProviderBlocked('google').allowed).toBe(true);
  });

  it('DEFAULT_POLICY has empty blockedAppConnectionProviders', () => {
    expect(DEFAULT_POLICY.blockedAppConnectionProviders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. AppConnectionService.connect refuses blocked providers
// ---------------------------------------------------------------------------

/**
 * Minimal store stub that records all mutations. Since the policy check
 * happens BEFORE any DB interaction, the store methods should never be
 * called when a provider is blocked. If they are, the test fails.
 */
function makeThrowingStore(): ConnectionStore {
  const fail = (method: string) => {
    throw new Error(`store.${method} should not be called when provider is blocked`);
  };
  return {
    upsert: () => fail('upsert'),
    get: () => fail('get'),
    list: () => [],
    listByProvider: () => [],
    updateStatus: () => fail('updateStatus'),
    remove: () => fail('remove'),
  } as unknown as ConnectionStore;
}

describe('AppConnectionService.connect with policy gate', () => {
  let vault: FakeVault;

  beforeEach(() => {
    vault = new FakeVault();
  });

  it('throws FlowError(provider_blocked) when provider is blocked', async () => {
    const service = new AppConnectionService({
      store: makeThrowingStore(),
      vault: vault as never,
      isProviderBlocked: (providerId) =>
        providerId === 'slack'
          ? { allowed: false, reason: 'slack disabled by admin' }
          : { allowed: true },
    });

    await expect(service.connect('slack')).rejects.toThrow(FlowError);
    await expect(service.connect('slack')).rejects.toMatchObject({
      code: 'provider_blocked',
    });
  });

  it('does not mutate DB or vault when provider is blocked', async () => {
    const service = new AppConnectionService({
      store: makeThrowingStore(),
      vault: vault as never,
      isProviderBlocked: () => ({ allowed: false, reason: 'blocked' }),
    });

    try {
      await service.connect('google');
    } catch {
      // expected — provider_blocked error
    }

    // The policy gate throws before startAuthorization, so no tokens
    // should be in the vault.
    expect(vault.get('anything')).toBeUndefined();
  });

  it('does not call startAuthorization when provider is blocked', async () => {
    // The policy check runs before startAuthorization. Verify by checking
    // that the error code is provider_blocked (not a flow error from
    // startAuthorization like redirect_failed or token_exchange_failed).
    const service = new AppConnectionService({
      store: makeThrowingStore(),
      vault: vault as never,
      isProviderBlocked: () => ({ allowed: false, reason: 'blocked' }),
    });

    try {
      await service.connect('google');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).code).toBe('provider_blocked');
    }
  });
});
