import { describe, it, expect, vi } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';

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

import { decryptCookieValue, deriveMacosCookieKey, mapChromeCookieToElectron, mapLiveBrowserCookies, isCookieExpired } from '../cookie-importer';

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

describe('mapLiveBrowserCookies', () => {
  it('maps extension cookies without persisting their raw export', () => {
    expect(mapLiveBrowserCookies([{
      name: 'session',
      value: 'live-value',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Date.now() / 1000 + 3600,
    }])).toEqual([expect.objectContaining({
      url: 'https://example.com',
      domain: '.example.com',
      sameSite: 'lax',
    })]);
  });

  it('drops malformed and expired extension cookies', () => {
    expect(mapLiveBrowserCookies([
      { name: 'missing-domain', value: 'x' },
      { name: 'expired', value: 'x', domain: 'example.com', path: '/', expirationDate: 1 },
    ])).toEqual([]);
  });
});

describe('decryptCookieValue', () => {
  it('decrypts Chromium v10 AES-GCM cookie values with the profile key', async () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update('signed-in'), cipher.final()]);
    const encrypted = Buffer.concat([
      Buffer.from('v10'),
      nonce,
      ciphertext,
      cipher.getAuthTag(),
    ]);

    await expect(decryptCookieValue(encrypted, key)).resolves.toBe('signed-in');
  });

  it('does not misreport app-bound v20 records as plaintext imports', async () => {
    await expect(decryptCookieValue(Buffer.from('v20not-importable'), null))
      .rejects.toThrow('APP_BOUND_ENCRYPTION');
  });
});

describe('decryptCookieValue (macOS AES-CBC)', () => {
  const MACOS_IV = Buffer.alloc(16, 0x20);

  function encryptMacos(plaintext: string, key: Buffer): Buffer {
    const cipher = createCipheriv('aes-128-cbc', key, MACOS_IV);
    return Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  }

  it('decrypts macOS v10 AES-CBC records with the derived Safe Storage key', async () => {
    const key = deriveMacosCookieKey('keychain-secret');
    const encrypted = Buffer.concat([Buffer.from('v10'), encryptMacos('mac-cookie-value', key)]);
    await expect(decryptCookieValue(encrypted, key, 'aes-128-cbc')).resolves.toBe('mac-cookie-value');
  });

  it('derives the key exactly like Chromium os_crypt_mac (known answer)', () => {
    // PBKDF2(secret='peanuts', salt='saltysalt', 1003 iterations, 16 bytes, sha1)
    expect(deriveMacosCookieKey('peanuts').toString('hex')).toBe('d9a09d499b4e1b7461f28e67972c6dbd');
  });

  it('rejects corrupted PKCS#7 padding instead of returning garbage', async () => {
    const key = deriveMacosCookieKey('peanuts');
    const body = encryptMacos('hello world', key);
    const tampered = Buffer.from(body);
    tampered[tampered.length - 1] ^= 0xff;
    const encrypted = Buffer.concat([Buffer.from('v10'), tampered]);
    await expect(decryptCookieValue(encrypted, key, 'aes-128-cbc'))
      .rejects.toThrow(/bad decrypt/);
  });

  it('rejects a key length other than 16 bytes in CBC mode', async () => {
    const encrypted = Buffer.concat([Buffer.from('v10'), encryptMacos('x', deriveMacosCookieKey('peanuts'))]);
    await expect(decryptCookieValue(encrypted, randomBytes(32), 'aes-128-cbc'))
      .rejects.toThrow('16 bytes');
  });

  it('still requires a key for v10 records in the macOS mode', async () => {
    await expect(decryptCookieValue(Buffer.from('v10xxxx'), null, 'aes-128-cbc'))
      .rejects.toThrow('Missing Chromium AES encryption key');
  });
});
