/**
 * src/lib/providers/__tests__/validation.test.ts
 *
 * Tests for ProviderValidation.
 */

import { describe, it, expect } from 'vitest';
import {
  redactSecrets,
  redactSecret,
  validateAuth,
  validateEndpoint,
  validateProvider,
} from '../domain/ProviderValidation';
import type { LlmProvider } from '../types';

function makeProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 'p1',
    name: 'P1',
    category: 'official',
    apiFormat: 'anthropic',
    auth: { type: 'api-key', apiKey: 'sk-ant-1234567890' },
    endpoints: { baseUrl: 'https://api.anthropic.com' },
    ui: {},
    meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 },
    ...overrides,
  };
}

describe('validateProvider', () => {
  it('accepts a well-formed provider', () => {
    expect(validateProvider(makeProvider()).ok).toBe(true);
  });
  it('rejects missing id', () => {
    const p = makeProvider({ id: '' });
    const r = validateProvider(p);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('provider.missingId');
  });
  it('rejects missing name', () => {
    const r = validateProvider(makeProvider({ name: '' }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('provider.missingName');
  });
  it('rejects unsupported apiFormat', () => {
    // Cast to bypass TS — exercising the runtime guard
    const r = validateProvider(makeProvider({ apiFormat: 'made-up' as unknown as 'anthropic' }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('provider.invalidApiFormat');
  });
  it('rejects unsupported category', () => {
    const r = validateProvider(
      makeProvider({ category: 'made-up' as unknown as 'official' }),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('provider.invalidCategory');
  });
});

describe('validateAuth', () => {
  it('requires apiKey for api-key auth', () => {
    const r = validateAuth({ type: 'api-key' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('auth.missingApiKey');
  });
  it('requires apiKey for bearer auth', () => {
    const r = validateAuth({ type: 'bearer' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('auth.missingApiKey');
  });
  it('requires accessToken or oauthAccountId for oauth', () => {
    const r = validateAuth({ type: 'oauth' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('auth.missingOAuth');
  });
  it('accepts oauth with accessToken', () => {
    expect(validateAuth({ type: 'oauth', accessToken: 'x' }).ok).toBe(true);
  });
  it('accepts auth=none with no key', () => {
    expect(validateAuth({ type: 'none' }).ok).toBe(true);
  });
  it('rejects unknown auth type', () => {
    const r = validateAuth({ type: 'magic' as unknown as 'api-key' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('auth.invalidType');
  });
});

describe('validateEndpoint', () => {
  it('requires baseUrl', () => {
    const r = validateEndpoint({ baseUrl: '' }, 'anthropic');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('endpoint.missingBaseUrl');
  });
  it('requires valid http(s) URL', () => {
    const r = validateEndpoint({ baseUrl: 'not-a-url' }, 'anthropic');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('endpoint.invalidUrl');
  });
  it('rejects non-http schemes', () => {
    const r = validateEndpoint({ baseUrl: 'ftp://example.com' }, 'anthropic');
    expect(r.ok).toBe(false);
  });
  it('accepts https URLs', () => {
    expect(validateEndpoint({ baseUrl: 'https://api.x.com' }, 'anthropic').ok).toBe(true);
  });
  it('accepts http URLs (for local ollama)', () => {
    expect(validateEndpoint({ baseUrl: 'http://localhost:11434' }, 'ollama').ok).toBe(true);
  });
});

describe('redactSecrets', () => {
  it('redacts Bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer sk-1234567890abcdef')).toContain('[REDACTED]');
    expect(redactSecrets('Authorization: Bearer sk-1234567890abcdef')).not.toContain(
      'sk-1234567890abcdef',
    );
  });
  it('redacts x-api-key', () => {
    expect(redactSecrets('x-api-key: sk-ant-1234567890')).toContain('[REDACTED]');
  });
  it('redacts api_key=', () => {
    expect(redactSecrets('api_key=sk-1234567890xyz')).toContain('[REDACTED]');
  });
  it('leaves short tokens alone', () => {
    expect(redactSecrets('foo bar')).toBe('foo bar');
  });
  it('handles empty / null', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets(null)).toBe('');
    expect(redactSecrets(undefined)).toBe('');
  });
});

describe('redactSecret (object)', () => {
  it('masks a string', () => {
    expect(redactSecret('sk-1234567890abcdef')).toBe('sk-1***cdef');
  });
  it('masks short strings fully', () => {
    expect(redactSecret('short')).toBe('***');
  });
  it('masks secret-shaped object keys', () => {
    const out = redactSecret({ apiKey: 'sk-1234567890abc', name: 'x' });
    // The apiKey is masked to a stable 4***4 form; the original value must not appear.
    expect(out).not.toContain('sk-1234567890abc');
    expect(out).toContain('"name":"x"');
  });
});
