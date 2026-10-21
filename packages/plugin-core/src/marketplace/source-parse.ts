// source-parse.ts — pure marketplace source parsing + SSRF host validation
// (Plan 455). Node builtins only for IP-literal classification; no fs.
// Codex parity: `core-plugins/src/marketplace_add/source.rs` — `owner/repo`
// shorthand, `<src>#<ref>` split, strict https-only git URLs, and local dirs.

import net from 'node:net';

export type MarketplaceSourceKind = 'git' | 'local';

export interface ParsedMarketplaceSource {
  kind: MarketplaceSourceKind;
  /** https clone URL (git sources only). */
  url?: string;
  /** Local directory path (local sources only, as given by the user). */
  path?: string;
  /** Optional branch/tag to track, from `<src>#<ref>` or explicit arg. */
  ref?: string;
}

export type MarketplaceSourceErrorCode =
  | 'invalid_request'
  | 'unsupported_scheme'
  | 'blocked_host'
  | 'invalid_url';

export class MarketplaceSourceError extends Error {
  readonly code: MarketplaceSourceErrorCode;

  constructor(code: MarketplaceSourceErrorCode, message: string) {
    super(message);
    this.name = 'MarketplaceSourceError';
    this.code = code;
  }
}

/** `owner/repo` shorthand → the repo's https clone URL. */
const GITHUB_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Local path shapes: posix absolute, windows drive, ./, ../, ~/ */
const LOCAL_PATH_PREFIX = /^([A-Za-z]:[\\/]|[/\\]|\.\.?[\\/]|~)/;

/**
 * Parse a user-supplied marketplace source string.
 *
 * Order mirrors codex `parse_marketplace_source`: empty → invalid; local
 * path shapes → `local`; https git URLs → `git` (host-validated); github
 * `owner/repo` shorthand → `git` with expanded URL; everything else →
 * invalid. `explicitRef` wins over a `#ref` suffix (codex parity).
 */
export function parseMarketplaceSource(
  input: string,
  explicitRef?: string,
): ParsedMarketplaceSource {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new MarketplaceSourceError('invalid_request', 'marketplace source is empty');
  }

  // Local paths never get the `#ref` split — '#' is a legal filename char.
  if (LOCAL_PATH_PREFIX.test(trimmed)) {
    return { kind: 'local', path: trimmed, ref: explicitRef };
  }

  const { base, ref: suffixRef } = splitSourceRef(trimmed);
  const ref = explicitRef ?? suffixRef;

  if (GITHUB_SHORTHAND.test(base)) {
    const url = `https://github.com/${base}.git`;
    validateGitUrl(url);
    return { kind: 'git', url, ref };
  }

  // scp-like syntax (git@host:path) and ssh:// never reach the URL branch
  // above — give them the targeted ssh message instead of a generic one.
  if (/^[^/@]+@[^/:]+:/.test(base)) {
    throw new MarketplaceSourceError(
      'unsupported_scheme',
      'ssh git URLs are not supported yet — use the https:// URL',
    );
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(base)) {
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      throw new MarketplaceSourceError('invalid_url', `malformed URL: ${base}`);
    }
    if (parsed.protocol === 'https:') {
      validateGitUrl(base);
      return { kind: 'git', url: base, ref };
    }
    // Common near-misses get a targeted message instead of a generic one.
    if (parsed.protocol === 'http:') {
      throw new MarketplaceSourceError(
        'unsupported_scheme',
        'insecure http:// is not allowed — use https://',
      );
    }
    if (parsed.protocol === 'ssh:' || base.startsWith('git@')) {
      throw new MarketplaceSourceError(
        'unsupported_scheme',
        'ssh git URLs are not supported yet — use the https:// URL',
      );
    }
    if (parsed.protocol === 'file:') {
      throw new MarketplaceSourceError(
        'unsupported_scheme',
        'file:// is not allowed — pass a local directory path instead',
      );
    }
    throw new MarketplaceSourceError(
      'unsupported_scheme',
      `unsupported scheme ${parsed.protocol} — use https:// or a local path`,
    );
  }

  throw new MarketplaceSourceError(
    'invalid_request',
    `cannot interpret marketplace source: ${base}`,
  );
}

/** codex `split_source_ref`: `<src>#<ref>` — only the last '#' splits. */
function splitSourceRef(input: string): { base: string; ref?: string } {
  const at = input.lastIndexOf('#');
  if (at <= 0 || at === input.length - 1) return { base: input };
  return { base: input.slice(0, at), ref: input.slice(at + 1) };
}

/**
 * SSRF hard gate for clone URLs (Plan 455 D2). Only https, no userinfo,
 * and the host must not be textually an IP literal in localhost / loopback /
 * private / link-local / reserved ranges. DNS-level re-resolution is out
 * of scope: git is a subprocess, not an in-process fetch, so the classic
 * DNS-rebinding SSRF vector does not apply to a URL we hand to `git clone`.
 */
export function validateGitUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new MarketplaceSourceError('invalid_url', `malformed URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new MarketplaceSourceError('unsupported_scheme', 'only https:// URLs are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new MarketplaceSourceError('invalid_url', 'credentials in URL are not allowed');
  }

  // WHATWG URL serializes IPv6 hosts lowercased and compressed, without
  // needing manual expansion for the prefix checks below.
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || isBlockedHost(host)) {
    throw new MarketplaceSourceError(
      'blocked_host',
      `host is not allowed: ${host || '(empty)'}`,
    );
  }
}

function isBlockedHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  if (host.endsWith('.internal')) {
    return true;
  }
  if (net.isIPv4(host)) return isBlockedIPv4(host);
  if (net.isIPv6(host)) return isBlockedIPv6(host);
  return false;
}

function isBlockedIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && (b === 168 || b === 0)) return true; // private + benchmark/doc
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a === 203 && b === 0) return true; // documentation
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  if (ip === '::' || ip === '::1') return true; // unspecified + loopback
  // IPv4-mapped — the WHATWG serializer renders ::ffff:a.b.c.d in hex form
  // (::ffff:7f00:1), so decode the trailing two 16-bit groups back to
  // dotted-quad and re-check as IPv4.
  const mapped = ip.match(/^(?:::)?(?:0{1,4}:){0,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (/^f[cd]/.test(ip)) return true; // unique-local fc00::/7
  if (/^fe[89ab]/.test(ip)) return true; // link-local fe80::/10
  if (/^ff/.test(ip)) return true; // multicast
  return false;
}

/**
 * Filesystem-safe directory name for a marketplace (codex keeps a similar
 * slug under `installed_marketplaces/`). Rejects reserved/dotted names.
 */
export function safeMarketplaceDirName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith('.')) {
    throw new MarketplaceSourceError('invalid_request', `reserved marketplace name: ${name}`);
  }
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new MarketplaceSourceError('invalid_request', `marketplace name is invalid: ${name}`);
  }
  return slug;
}
