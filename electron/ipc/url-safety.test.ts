import { describe, expect, it } from 'vitest';
import { isHttpUrl } from './url-safety';

describe('isHttpUrl (BLOCKER A: external URL safety)', () => {
  const ALLOWED = [
    'http://example.com',
    'https://example.com',
    'https://example.com/path?q=1',
    'https://example.com:8080/path#fragment',
    'https://user:pass@example.com',
    'HTTPS://EXAMPLE.COM',
    '  https://example.com  ',
  ];

  const BLOCKED = [
    // Local file leaks
    'file:///c:/Windows/win.ini',
    'file://localhost/etc/passwd',
    // Script execution via OS handler
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    // Network schemes we do not intentionally support
    'smb://server/share',
    'ms-msdt:id',
    'intent://example.com',
    'duya-file://',
    'about:blank',
    'chrome://settings',
    'ssh://host',
    'ftp://example.com',
    'ws://example.com',
    // Malformed / bare
    '//example.com',
    'example.com',
    '',
    '   ',
    'http://',
    'https://',
    'https://exa mple.com',
    'http://\0evil',
    // App/utility schemes
    'mailto:foo@bar',
    'tel:+1234567890',
  ];

  for (const u of ALLOWED) {
    it('allows ' + JSON.stringify(u), () => {
      expect(isHttpUrl(u)).toBe(true);
    });
  }
  for (const u of BLOCKED) {
    it('blocks ' + JSON.stringify(u), () => {
      expect(isHttpUrl(u)).toBe(false);
    });
  }

  it('rejects non-string input', () => {
    expect(isHttpUrl(undefined)).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(123)).toBe(false);
    expect(isHttpUrl({})).toBe(false);
  });
});
