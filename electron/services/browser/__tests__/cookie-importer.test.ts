import { describe, it, expect, vi } from 'vitest';

// cookie-importer calls getLogger() at module load time, which touches
// app.isPackaged. Mock the logger so the module loads in a pure test env.
vi.mock('../../../logging/logger', () => ({
  initLogger: vi.fn(),
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

import { mapChromeCookieToElectron, isCookieExpired } from '../cookie-importer';

describe('mapChromeCookieToElectron', () => {
  it('maps a secure cookie with https url', () => {
    const chromeRow = {
      host_key: '.example.com',
      name: 'session',
      value: '',
      encrypted_value: Buffer.from('v10mock'),
      path: '/',
      expires_utc: 13222310400000000, // 2020-01-01 in Chrome microseconds
      is_secure: 1,
      is_httponly: 1,
      samesite: 1, // 1 = Lax
    };
    const result = mapChromeCookieToElectron(chromeRow as never, 'decrypted_value');
    expect(result.url).toBe('https://.example.com');
    expect(result.name).toBe('session');
    expect(result.value).toBe('decrypted_value');
    expect(result.domain).toBe('.example.com');
    expect(result.path).toBe('/');
    expect(result.secure).toBe(true);
    expect(result.httpOnly).toBe(true);
    expect(result.expirationDate).toBe(1577836800); // Unix seconds
  });

  it('maps a non-secure cookie with http url', () => {
    const chromeRow = {
      host_key: 'api.test.com',
      name: 'token',
      encrypted_value: Buffer.from('v10mock'),
      path: '/api',
      expires_utc: 0,
      is_secure: 0,
      is_httponly: 0,
      samesite: 0,
    };
    const result = mapChromeCookieToElectron(chromeRow as never, 'val');
    expect(result.url).toBe('http://api.test.com');
    expect(result.secure).toBe(false);
    expect(result.httpOnly).toBe(false);
    expect(result.expirationDate).toBeUndefined();
  });
});

describe('isCookieExpired', () => {
  it('returns false for expires_utc = 0 (session cookie)', () => {
    expect(isCookieExpired(0)).toBe(false);
  });

  it('returns true for past expiration', () => {
    const pastUtc = (Date.now() - 86400000) * 1000 + 11644473600000000; // yesterday in Chrome microseconds
    expect(isCookieExpired(pastUtc)).toBe(true);
  });

  it('returns false for future expiration', () => {
    const futureUtc = (Date.now() + 86400000) * 1000 + 11644473600000000; // tomorrow
    expect(isCookieExpired(futureUtc)).toBe(false);
  });
});
