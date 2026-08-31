/**
 * src/lib/errors/__tests__/extractErrorMessage.test.ts
 *
 * Plan 203 Phase 1.2 deliverable: ~150 LoC / ~20 tests.
 */

import { describe, it, expect } from 'vitest';
import { extractErrorMessage, redactSecrets, type NormalizedError } from '../extractErrorMessage';

const FALLBACK: NormalizedError = { code: 'unknown', message: 'Unknown error' };

describe('redactSecrets', () => {
  it('returns empty string for empty / null / undefined', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets(null)).toBe('');
    expect(redactSecrets(undefined)).toBe('');
  });

  it('passes through safe strings unchanged', () => {
    expect(redactSecrets('network timeout')).toBe('network timeout');
    expect(redactSecrets('invalid model id')).toBe('invalid model id');
  });

  it('redacts OpenAI / Anthropic style keys', () => {
    expect(redactSecrets('Invalid API key: sk-abcdef1234567890abcdef'))
      .toContain('sk-***');
    // Vendor-specific prefix is preserved (sk-ant-*** not sk-***).
    expect(redactSecrets('Bad key sk-ant-api03-abcdefghijklmnopqrstuvwxyz'))
      .toContain('sk-ant-***');
    expect(redactSecrets('Bad key sk-ant-api03-abcdefghijklmnopqrstuvwxyz'))
      .not.toContain('api03-abcdefghijklmnopqrstuvwxyz');
    expect(redactSecrets('sk-or-v1-abcdefghij1234567890'))
      .toContain('sk-or-***');
  });

  it('redacts GitHub PATs', () => {
    expect(redactSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz1234567890'))
      .toContain('ghp_***');
    expect(redactSecrets('Authorization: gho_abcdefghijklmnopqrstuvwxyz'))
      .toContain('gho_***');
  });

  it('redacts Bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature'))
      .toContain('Bearer ***');
  });

  it('redacts generic "apiKey: ..." values', () => {
    expect(redactSecrets('apiKey: abcdef1234567890'))
      .toContain('apiKey: ***');
    // JSON form: the key body is redacted; the label stays.
    expect(redactSecrets('"api_key":"sk-test-1234567890"'))
      .toContain('api_key":"');
    expect(redactSecrets('"api_key":"sk-test-1234567890"'))
      .not.toContain('sk-test-1234567890');
  });

  it('is idempotent', () => {
    const once = redactSecrets('sk-abcdef1234567890');
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });
});

describe('extractErrorMessage — IPC envelope', () => {
  it('handles `{ code, message, hint }` shape', () => {
    const e = { code: 'auth', message: 'Invalid API key', hint: 'Check your provider settings' };
    expect(extractErrorMessage(e)).toEqual({
      code: 'auth',
      message: 'Invalid API key',
      hint: 'Check your provider settings',
    });
  });

  it('redacts secrets in IPC message field', () => {
    const e = { code: 'auth', message: 'Bad key sk-abcdef1234567890' };
    const out = extractErrorMessage(e);
    expect(out.message).not.toContain('abcdef1234567890');
    expect(out.message).toContain('sk-***');
  });

  it('redacts secrets in IPC hint field', () => {
    const e = { code: 'auth', message: 'Bad', hint: 'Try sk-test-1234567890' };
    const out = extractErrorMessage(e);
    expect(out.hint).not.toContain('sk-test-1234567890');
  });

  it('omits hint when not present', () => {
    const e = { code: 'auth', message: 'Bad' };
    const out = extractErrorMessage(e);
    expect(out.hint).toBeUndefined();
  });
});

describe('extractErrorMessage — Error instance', () => {
  it('handles a thrown Error', () => {
    const e = new Error('something broke');
    expect(extractErrorMessage(e)).toEqual({ code: 'thrown', message: 'something broke' });
  });

  it('redacts secrets in Error.message', () => {
    const e = new Error('Bad key sk-abcdef1234567890xyz');
    const out = extractErrorMessage(e);
    expect(out.message).not.toContain('abcdef1234567890');
  });

  it('handles TypeError', () => {
    const e = new TypeError('Failed to fetch');
    expect(extractErrorMessage(e).code).toBe('thrown');
    expect(extractErrorMessage(e).message).toBe('Failed to fetch');
  });
});

describe('extractErrorMessage — legacy `{error: {code, message}}` shape', () => {
  it('handles the old test-provider result shape', () => {
    const e = { error: { code: 'invalid_model', message: 'model not found', suggestion: 'try a different one' } };
    expect(extractErrorMessage(e)).toEqual({
      code: 'invalid_model',
      message: 'model not found',
      hint: 'try a different one',
    });
  });

  it('falls through when inner code/message are not strings', () => {
    const e = { error: { code: 42, message: 'no' } };
    expect(extractErrorMessage(e, FALLBACK)).toBe(FALLBACK);
  });
});

describe('extractErrorMessage — network rejection', () => {
  it('handles `{ message: "Failed to fetch" }`', () => {
    const e = { message: 'Failed to fetch' };
    expect(extractErrorMessage(e)).toEqual({
      code: 'network',
      message: 'Failed to fetch',
    });
  });
});

describe('extractErrorMessage — input edge cases', () => {
  it('returns fallback for null', () => {
    expect(extractErrorMessage(null)).toEqual(FALLBACK);
  });

  it('returns fallback for undefined', () => {
    expect(extractErrorMessage(undefined)).toEqual(FALLBACK);
  });

  it('returns fallback for 0', () => {
    expect(extractErrorMessage(0)).toEqual(FALLBACK);
  });

  it('returns fallback for empty object', () => {
    expect(extractErrorMessage({})).toEqual(FALLBACK);
  });

  it('handles a raw string', () => {
    expect(extractErrorMessage('boom')).toEqual({ code: 'raw', message: 'boom' });
  });

  it('honors a custom fallback', () => {
    const fb: NormalizedError = { code: 'custom', message: 'oops' };
    expect(extractErrorMessage(null, fb)).toBe(fb);
  });
});
