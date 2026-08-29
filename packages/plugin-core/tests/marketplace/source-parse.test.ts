import { describe, expect, it } from 'vitest';
import {
  MarketplaceSourceError,
  parseMarketplaceSource,
  safeMarketplaceDirName,
  validateGitUrl,
} from '../../src/marketplace/source-parse';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MarketplaceSourceError);
    return (err as MarketplaceSourceError).code;
  }
  throw new Error('expected MarketplaceSourceError');
}

describe('parseMarketplaceSource — github shorthand', () => {
  it('expands owner/repo to the https clone URL', () => {
    const r = parseMarketplaceSource('acme/plugins');
    expect(r).toEqual({ kind: 'git', url: 'https://github.com/acme/plugins.git', ref: undefined });
  });

  it('splits a #ref suffix (codex split_source_ref)', () => {
    const r = parseMarketplaceSource('acme/plugins#v2');
    expect(r.url).toBe('https://github.com/acme/plugins.git');
    expect(r.ref).toBe('v2');
  });

  it('explicit ref wins over the #ref suffix', () => {
    const r = parseMarketplaceSource('acme/plugins#main', 'v1');
    expect(r.ref).toBe('v1');
  });
});

describe('parseMarketplaceSource — local paths', () => {
  it('accepts posix absolute paths without #ref splitting', () => {
    expect(parseMarketplaceSource('/opt/market')).toEqual({
      kind: 'local', path: '/opt/market', ref: undefined,
    });
  });

  it('accepts windows drive paths', () => {
    expect(parseMarketplaceSource('E:\\repos\\market').kind).toBe('local');
    expect(parseMarketplaceSource('E:/repos/market').kind).toBe('local');
  });

  it('accepts relative and home-relative paths', () => {
    expect(parseMarketplaceSource('./market').kind).toBe('local');
    expect(parseMarketplaceSource('../market').kind).toBe('local');
    expect(parseMarketplaceSource('~/market').kind).toBe('local');
  });
});

describe('parseMarketplaceSource — git URLs and rejections', () => {
  it('accepts an https git URL', () => {
    const r = parseMarketplaceSource('https://gitlab.com/acme/market.git');
    expect(r).toEqual({ kind: 'git', url: 'https://gitlab.com/acme/market.git', ref: undefined });
  });

  it('rejects empty input', () => {
    expect(codeOf(() => parseMarketplaceSource('  '))).toBe('invalid_request');
  });

  it('rejects bare words', () => {
    expect(codeOf(() => parseMarketplaceSource('not-a-source'))).toBe('invalid_request');
  });

  it('rejects http with a targeted message', () => {
    expect(codeOf(() => parseMarketplaceSource('http://github.com/a/b'))).toBe('unsupported_scheme');
  });

  it('rejects ssh and git@ URLs', () => {
    expect(codeOf(() => parseMarketplaceSource('ssh://git@github.com/a/b'))).toBe('unsupported_scheme');
    expect(codeOf(() => parseMarketplaceSource('git@github.com:a/b.git'))).toBe('unsupported_scheme');
  });

  it('rejects file:// with a pointer to local-dir input', () => {
    expect(codeOf(() => parseMarketplaceSource('file:///tmp/market'))).toBe('unsupported_scheme');
  });

  it('rejects credentials embedded in the URL', () => {
    expect(codeOf(() => parseMarketplaceSource('https://user:pass@github.com/a/b'))).toBe('invalid_url');
  });
});

describe('validateGitUrl — SSRF host gate', () => {
  const blocked: Array<[string, string]> = [
    ['localhost', 'hostname'],
    ['sub.localhost', 'subdomain'],
    ['myhost.local', 'mdns'],
    ['svc.internal', 'internal'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.9', 'private'],
    ['172.31.255.1', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'cloud metadata'],
    ['100.64.0.1', 'cgnat'],
    ['224.0.0.1', 'multicast'],
    ['[::1]', 'v6 loopback'],
    ['[::]', 'v6 unspecified'],
    ['[fe80::1]', 'v6 link-local'],
    ['[fc00::1]', 'v6 unique-local'],
    ['[fd12::1]', 'v6 unique-local'],
    ['[ff02::1]', 'v6 multicast'],
    ['[::ffff:127.0.0.1]', 'v4-mapped loopback'],
    ['[::ffff:10.0.0.1]', 'v4-mapped private'],
  ];

  for (const [host, why] of blocked) {
    it(`blocks ${host} (${why})`, () => {
      expect(codeOf(() => validateGitUrl(`https://${host}/a/b.git`))).toBe('blocked_host');
    });
  }

  it('allows public hosts', () => {
    expect(() => validateGitUrl('https://github.com/a/b.git')).not.toThrow();
    expect(() => validateGitUrl('https://gitlab.com/a/b.git')).not.toThrow();
    expect(() => validateGitUrl('https://8.8.8.8/x.git')).not.toThrow();
  });

  it('still enforces https and rejects malformed URLs', () => {
    expect(codeOf(() => validateGitUrl('http://github.com/a/b.git'))).toBe('unsupported_scheme');
    expect(codeOf(() => validateGitUrl('not a url'))).toBe('invalid_url');
  });
});

describe('safeMarketplaceDirName', () => {
  it('slugifies names', () => {
    expect(safeMarketplaceDirName('Acme Plugins!')).toBe('acme-plugins');
    expect(safeMarketplaceDirName('official')).toBe('official');
  });

  it('rejects empty and reserved names', () => {
    expect(codeOf(() => safeMarketplaceDirName('!!!'))).toBe('invalid_request');
    expect(codeOf(() => safeMarketplaceDirName('.staging'))).toBe('invalid_request');
    expect(codeOf(() => safeMarketplaceDirName('..'))).toBe('invalid_request');
  });
});
