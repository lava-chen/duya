/**
 * DomainBlocker - URL/domain blocking utility for browser tool
 *
 * Provides a secondary layer of domain blocking for:
 * - Playwright mode (when Extension is not available)
 * - Fallback mode (static HTML fetching)
 *
 * The primary blocking happens in the Extension's background.js
 *
 * SSRF protection is provided by urlSafety.ts which blocks:
 * - Private IP ranges (RFC 1918, RFC 3927, RFC 4193)
 * - Loopback addresses
 * - Link-local addresses
 * - DNS rebinding attacks via hostname resolution check
 */

import { isSafeUrlSync } from '../../utils/urlSafety.js';

export interface DomainBlockerConfig {
  blockedDomains: string[];
}

/**
 * Check if a URL is blocked based on the domain list and SSRF protection.
 * Also checks against private IP ranges to prevent SSRF attacks.
 *
 * The SSRF step only applies to http(s). `isSafeUrlSync` rejects every other
 * scheme as "Unsupported protocol", and this function is the general
 * "should this navigation be blocked" gate, so that check used to block
 * `file://` unconditionally — which made FallbackBrowser.navigateLocalFile
 * (working-directory confinement + HTML allowlist) unreachable and reported
 * the misleading "is in the domain blocklist" for URLs no domain list had
 * even been consulted about. Non-http(s) schemes are not remote-fetch
 * targets, so SSRF (private IPs, loopback, DNS rebinding) does not apply to
 * them; each is governed by its own per-scheme confinement instead.
 */
export function isUrlBlocked(url: string, blockedDomains: string[]): boolean {
  let protocol: string;
  try {
    protocol = new URL(url).protocol.toLowerCase();
  } catch {
    // Unparseable: leave it to the caller's own validation.
    return false;
  }

  if (protocol === 'http:' || protocol === 'https:') {
    // First check SSRF protection (private IPs, loopback, etc.)
    const safetyResult = isSafeUrlSync(url);
    if (!safetyResult.safe) {
      return true;
    }
  }

  if (!blockedDomains || blockedDomains.length === 0) {
    return false;
  }

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    for (const blocked of blockedDomains) {
      const blockedLower = blocked.toLowerCase();

      // Exact match
      if (hostname === blockedLower) {
        return true;
      }

      // Subdomain match (e.g., blocked: example.com, url: www.example.com)
      if (hostname.endsWith('.' + blockedLower)) {
        return true;
      }

      // Wildcard match (e.g., blocked: *.example.com)
      if (blockedLower.startsWith('*.')) {
        const domain = blockedLower.slice(2);
        if (hostname === domain || hostname.endsWith('.' + domain)) {
          return true;
        }
      }
    }

    return false;
  } catch {
    // Invalid URL
    return false;
  }
}

/**
 * Default blocked domains (security baseline)
 * These are always blocked regardless of user configuration
 */
export const DEFAULT_BLOCKED_DOMAINS: string[] = [
  // Internal/private networks (security)
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '[::]',
];

/**
 * Get effective blocked domains list
 * Combines default blocked domains with user-configured ones
 */
export function getEffectiveBlockedDomains(userConfig?: DomainBlockerConfig): string[] {
  const userDomains = userConfig?.blockedDomains ?? [];
  return [...DEFAULT_BLOCKED_DOMAINS, ...userDomains];
}

/**
 * Validate domain format
 */
export function isValidDomain(domain: string): boolean {
  // Allow simple domain patterns like "example.com" or "sub.example.com"
  // Also allow wildcard patterns like "*.example.com"
  const domainPattern = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

  // Allow URLs - extract domain from URL
  if (domain.startsWith('http://') || domain.startsWith('https://')) {
    try {
      const url = new URL(domain);
      return isValidDomain(url.hostname);
    } catch {
      return false;
    }
  }

  return domainPattern.test(domain);
}

/**
 * Normalize domain input (extract from URL, lowercase, etc.)
 */
export function normalizeDomain(input: string): string | null {
  let domain = input.trim().toLowerCase();

  // If it's a URL, extract the hostname
  if (domain.startsWith('http://') || domain.startsWith('https://')) {
    try {
      const url = new URL(domain);
      domain = url.hostname;
    } catch {
      return null;
    }
  }

  // Remove www. prefix for consistency (unless it's a wildcard)
  if (!domain.startsWith('*.')) {
    domain = domain.replace(/^www\./, '');
  }

  return domain;
}
