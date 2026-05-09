/**
 * DomainBlocker - URL/domain blocking utility for browser tool
 *
 * Provides a secondary layer of domain blocking for:
 * - Playwright mode (when Extension is not available)
 * - Fallback mode (static HTML fetching)
 *
 * The primary blocking happens in the Extension's background.js
 */

export interface DomainBlockerConfig {
  blockedDomains: string[];
}

/**
 * Check if a URL is blocked based on the domain list
 */
export function isUrlBlocked(url: string, blockedDomains: string[]): boolean {
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
