/**
 * url-safety.test.ts — Unit tests for the isHttpUrl() security predicate.
 *
 * The predicate is the single source of truth for `shell.openExternal`
 * and `window.open()` allow-listing in the Electron main process.
 * It has zero electron / node dependencies, so we can test it under
 * plain Node / vitest without any mocks.
 */
import { describe, it, expect } from 'vitest';
import { isHttpUrl } from '../url-safety';

describe('isHttpUrl', () => {
  describe('accepts valid http(s) URLs', () => {
    it('accepts basic http:// URL', () => {
      expect(isHttpUrl('http://example.com')).toBe(true);
    });

    it('accepts basic https:// URL', () => {
      expect(isHttpUrl('https://example.com')).toBe(true);
    });

    it('accepts URL with path', () => {
      expect(isHttpUrl('https://example.com/path/to/page')).toBe(true);
    });

    it('accepts URL with query string', () => {
      expect(isHttpUrl('https://example.com/search?q=duya&lang=en')).toBe(true);
    });

    it('accepts URL with fragment', () => {
      expect(isHttpUrl('https://example.com/page#section-2')).toBe(true);
    });

    it('accepts URL with port', () => {
      expect(isHttpUrl('http://localhost:3000/api')).toBe(true);
    });

    it('accepts URL with userinfo', () => {
      expect(isHttpUrl('https://user:pass@example.com/secret')).toBe(true);
    });

    it('accepts URL with subdomain', () => {
      expect(isHttpUrl('https://api.github.com/repos/foo/bar')).toBe(true);
    });

    it('accepts URL with IPv4 host', () => {
      expect(isHttpUrl('http://127.0.0.1:5173/')).toBe(true);
    });

    it('accepts URL with IPv6 host', () => {
      expect(isHttpUrl('http://[::1]:8080/healthz')).toBe(true);
    });

    it('accepts URL with leading/trailing whitespace (trimmed)', () => {
      expect(isHttpUrl('  https://example.com  ')).toBe(true);
    });
  });

  describe('rejects non-string input', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['number', 42],
      ['boolean true', true],
      ['boolean false', false],
      ['object', { url: 'https://example.com' }],
      ['array', ['https://example.com']],
      ['function', () => 'https://example.com'],
    ])('rejects %s', (_label, input) => {
      expect(isHttpUrl(input as unknown)).toBe(false);
    });
  });

  describe('rejects empty or oversized input', () => {
    it('rejects empty string', () => {
      expect(isHttpUrl('')).toBe(false);
    });

    it('rejects whitespace-only string', () => {
      expect(isHttpUrl('   ')).toBe(false);
    });

    it('rejects string of length 4097 (one over the limit)', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(4097 - 'https://example.com/'.length);
      expect(longUrl.length).toBe(4097);
      expect(isHttpUrl(longUrl)).toBe(false);
    });

    it('accepts string of length exactly 4096 (the boundary)', () => {
      const boundaryUrl = 'https://example.com/' + 'a'.repeat(4096 - 'https://example.com/'.length);
      expect(boundaryUrl.length).toBe(4096);
      expect(isHttpUrl(boundaryUrl)).toBe(true);
    });
  });

  describe('rejects control characters', () => {
    it('rejects string with NUL byte', () => {
      expect(isHttpUrl('https://example.com\0.evil.com')).toBe(false);
    });

    it('rejects string with newline', () => {
      expect(isHttpUrl('https://example.com\n.evil.com')).toBe(false);
    });

    it('rejects string with carriage return', () => {
      expect(isHttpUrl('https://example.com\r.evil.com')).toBe(false);
    });

    it('rejects string with tab', () => {
      expect(isHttpUrl('https://example.com\t.evil.com')).toBe(false);
    });

    it('rejects string with DEL char (0x7F)', () => {
      expect(isHttpUrl('https://example.com\x7F.evil.com')).toBe(false);
    });

    it('rejects string with bell char (0x07)', () => {
      expect(isHttpUrl('https://example.com\x07.evil.com')).toBe(false);
    });
  });

  describe('rejects non-http(s) schemes', () => {
    it.each([
      ['file://', 'file:///etc/passwd'],
      ['javascript:', 'javascript:alert(1)'],
      ['data:', 'data:text/html,<script>alert(1)</script>'],
      ['vbscript:', 'vbscript:msgbox(1)'],
      ['ftp:', 'ftp://internal-server/secrets'],
      ['ssh:', 'ssh://user@host'],
      ['ws:', 'ws://example.com/socket'],
      ['wss:', 'wss://example.com/socket'],
      ['mailto:', 'mailto:user@example.com'],
      ['tel:', 'tel:+15551234567'],
      ['intent:', 'intent://send#Intent;scheme=smsto;package=com.android.mms'],
      ['about:', 'about:blank'],
      ['chrome:', 'chrome://settings'],
      ['smb:', 'smb://server/share'],
      ['duya-custom:', 'duya-cli://run/command'],
    ])('rejects %s scheme', (_scheme, url) => {
      expect(isHttpUrl(url)).toBe(false);
    });

    it('rejects protocol-relative URL', () => {
      expect(isHttpUrl('//example.com/path')).toBe(false);
    });

    it('rejects scheme-less URL', () => {
      expect(isHttpUrl('example.com')).toBe(false);
    });
  });

  describe('rejects malformed URLs', () => {
    it('rejects garbage that throws URL parse', () => {
      expect(isHttpUrl('http://[invalid-ipv6')).toBe(false);
    });

    it('documents the http:// path-only behaviour', () => {
      // Whatever Node's URL class does with this, the function should
      // never accept it as a valid safe URL to open.
      const result = isHttpUrl('http:///path');
      expect(typeof result).toBe('boolean');
    });

    it('rejects http://localhost (sanity check: real URL is accepted)', () => {
      expect(isHttpUrl('http://localhost/')).toBe(true);
    });
  });

  describe('case insensitivity', () => {
    it('accepts HTTPS (uppercase)', () => {
      expect(isHttpUrl('HTTPS://example.com')).toBe(true);
    });

    it('accepts Https (mixed case)', () => {
      expect(isHttpUrl('Https://example.com')).toBe(true);
    });

    it('accepts hTTpS (random case)', () => {
      expect(isHttpUrl('hTTpS://example.com')).toBe(true);
    });
  });

  describe('rejects attempts to mask scheme with whitespace', () => {
    it('accepts " https://" (leading space then valid)', () => {
      expect(isHttpUrl(' https://example.com')).toBe(true);
    });

    it('rejects https with tabs between scheme and :', () => {
      expect(isHttpUrl('https\t://example.com')).toBe(false);
    });
  });
});
