/**
 * URL Safety Utilities - SSRF Protection
 *
 * Provides comprehensive protection against Server-Side Request Forgery (SSRF)
 * attacks by validating URLs against private/internal IP ranges.
 *
 * Features:
 * - Blocks private IP ranges (RFC 1918, RFC 3927, RFC 4193)
 * - Blocks loopback addresses
 * - Blocks link-local addresses
 * - Validates hostnames don't resolve to private IPs
 * - Handles IPv4 and IPv6
 */

import { lookup } from 'dns/promises';

// =============================================================================
// Private IP Range Detection
// =============================================================================

interface IPRange {
  start: bigint;
  end: bigint;
  label: string;
}

// Convert IPv4 string to bigint
function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split('.').map(Number);
  return (BigInt(parts[0]) << 24n) |
         (BigInt(parts[1]) << 16n) |
         (BigInt(parts[2]) << 8n) |
         BigInt(parts[3]);
}

// RFC 1918 and other private/reserved IPv4 ranges
const PRIVATE_IPV4_RANGES: IPRange[] = [
  // Loopback
  { start: ipv4ToBigInt('127.0.0.0'), end: ipv4ToBigInt('127.255.255.255'), label: 'loopback' },
  // Private A class
  { start: ipv4ToBigInt('10.0.0.0'), end: ipv4ToBigInt('10.255.255.255'), label: 'private-10' },
  // Private B class
  { start: ipv4ToBigInt('172.16.0.0'), end: ipv4ToBigInt('172.31.255.255'), label: 'private-172' },
  // Private C class
  { start: ipv4ToBigInt('192.168.0.0'), end: ipv4ToBigInt('192.168.255.255'), label: 'private-192.168' },
  // Link-local (APIPA)
  { start: ipv4ToBigInt('169.254.0.0'), end: ipv4ToBigInt('169.254.255.255'), label: 'link-local' },
  // Carrier-grade NAT
  { start: ipv4ToBigInt('100.64.0.0'), end: ipv4ToBigInt('100.127.255.255'), label: 'carrier-grade-nat' },
  // Documentation/Examples
  { start: ipv4ToBigInt('192.0.2.0'), end: ipv4ToBigInt('192.0.2.255'), label: 'documentation-192.0.2' },
  { start: ipv4ToBigInt('198.51.100.0'), end: ipv4ToBigInt('198.51.100.255'), label: 'documentation-198.51.100' },
  { start: ipv4ToBigInt('203.0.113.0'), end: ipv4ToBigInt('203.0.113.255'), label: 'documentation-203.0.113' },
  // Multicast
  { start: ipv4ToBigInt('224.0.0.0'), end: ipv4ToBigInt('239.255.255.255'), label: 'multicast' },
  // Reserved
  { start: ipv4ToBigInt('240.0.0.0'), end: ipv4ToBigInt('255.255.255.255'), label: 'reserved' },
  // This network
  { start: ipv4ToBigInt('0.0.0.0'), end: ipv4ToBigInt('0.255.255.255'), label: 'this-network' },
];

// Check if an IPv4 address is in a private range
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;

  // Validate each part is a number 0-255
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255 || part !== String(num)) {
      return false;
    }
  }

  const ipBigInt = ipv4ToBigInt(ip);
  for (const range of PRIVATE_IPV4_RANGES) {
    if (ipBigInt >= range.start && ipBigInt <= range.end) {
      return true;
    }
  }
  return false;
}

// Check if an IPv6 address is private/link-local/loopback
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // Loopback
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;

  // Link-local (fe80::/10)
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true;

  // Unique local (fc00::/7)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;

  // Multicast (ff00::/8)
  if (lower.startsWith('ff')) return true;

  // IPv4-mapped IPv6 (::ffff:0:0/96)
  if (lower.startsWith('::ffff:') || lower.startsWith('0:0:0:0:0:ffff:')) {
    // Extract IPv4 part
    const ipv4Match = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (ipv4Match) {
      return isPrivateIPv4(ipv4Match[1]);
    }
  }

  // IPv4-compatible IPv6 (::/96)
  if (lower.startsWith('::') && !lower.startsWith('::ffff:')) {
    const ipv4Match = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
    if (ipv4Match) {
      return isPrivateIPv4(ipv4Match[1]);
    }
  }

  return false;
}

// =============================================================================
// Hostname Validation
// =============================================================================

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(lower)) return true;

  // Check if it's an IP address
  if (isPrivateIPv4(lower)) return true;
  if (isPrivateIPv6(lower)) return true;

  return false;
}

// =============================================================================
// DNS Resolution with SSRF Protection
// =============================================================================

/**
 * Resolve a hostname and check if any resolved IP is private.
 * Returns the first public IP found, or null if all are private.
 */
export async function resolvePublicIP(hostname: string): Promise<string | null> {
  // If it's already an IP, check it directly
  if (isPrivateIPv4(hostname) || isPrivateIPv6(hostname)) {
    return null;
  }

  try {
    const addresses = await lookup(hostname, { all: true });

    for (const addr of addresses) {
      const ip = addr.address;
      if (!isPrivateIPv4(ip) && !isPrivateIPv6(ip)) {
        return ip;
      }
    }

    // All resolved IPs are private
    return null;
  } catch {
    // DNS resolution failed - safer to block
    return null;
  }
}

// =============================================================================
// Main URL Safety Check
// =============================================================================

export interface URLSafetyResult {
  safe: boolean;
  reason?: string;
}

/**
 * Check if a URL is safe to fetch (SSRF protection).
 *
 * This function validates:
 * 1. URL format is valid
 * 2. Protocol is http or https
 * 3. Hostname is not in blocked list
 * 4. IP address is not in private ranges
 * 5. DNS resolution doesn't return private IPs
 *
 * @param url The URL to check
 * @param options.skipDNSCheck Skip DNS resolution check (faster but less secure)
 * @returns URLSafetyResult with safe status and optional reason
 */
export async function isSafeUrl(
  url: string,
  options: { skipDNSCheck?: boolean } = {}
): Promise<URLSafetyResult> {
  // Basic URL validation
  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }

  // Protocol check
  const protocol = urlObj.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { safe: false, reason: `Unsupported protocol: ${protocol}` };
  }

  const hostname = urlObj.hostname.toLowerCase();

  // Check for blocked hostnames
  if (isBlockedHostname(hostname)) {
    return { safe: false, reason: `Blocked hostname: ${hostname}` };
  }

  // Check if hostname looks like an IP address
  const ipv4Pattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (ipv4Pattern.test(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return { safe: false, reason: `Private IP address: ${hostname}` };
    }
    // Public IPv4 is OK
    return { safe: true };
  }

  // IPv6 check
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const ipv6 = hostname.slice(1, -1);
    if (isPrivateIPv6(ipv6)) {
      return { safe: false, reason: `Private IPv6 address: ${hostname}` };
    }
    // Public IPv6 is OK
    return { safe: true };
  }

  // DNS resolution check (unless skipped)
  if (!options.skipDNSCheck) {
    const publicIP = await resolvePublicIP(hostname);
    if (publicIP === null) {
      return { safe: false, reason: `Hostname resolves to private/internal IP: ${hostname}` };
    }
  }

  return { safe: true };
}

/**
 * Synchronous version of isSafeUrl for simple cases.
 * Does NOT perform DNS resolution - only checks hostname format.
 */
export function isSafeUrlSync(url: string): URLSafetyResult {
  // Basic URL validation
  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }

  // Protocol check
  const protocol = urlObj.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { safe: false, reason: `Unsupported protocol: ${protocol}` };
  }

  const hostname = urlObj.hostname.toLowerCase();

  // Check for blocked hostnames
  if (isBlockedHostname(hostname)) {
    return { safe: false, reason: `Blocked hostname: ${hostname}` };
  }

  // Check if hostname looks like an IP address
  const ipv4Pattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (ipv4Pattern.test(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return { safe: false, reason: `Private IP address: ${hostname}` };
    }
    return { safe: true };
  }

  // IPv6 check
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const ipv6 = hostname.slice(1, -1);
    if (isPrivateIPv6(ipv6)) {
      return { safe: false, reason: `Private IPv6 address: ${hostname}` };
    }
    return { safe: true };
  }

  // Hostname looks OK (but DNS check not performed)
  return { safe: true };
}

// =============================================================================
// CDN Image URL Detection
// =============================================================================

/**
 * CDN domains that should not be used as inline images.
 * These are typically MiniMax/Alibaba cloud CDN URLs that cannot be fetched
 * by the model for vision analysis.
 */
const CDN_IMAGE_PATTERNS = [
  /https?:\/\/[^\s]*\.oss-cn-[a-z0-9-]+\.aliyuncs\.com[^\s]*/i,
  /https?:\/\/[^\s]*\.minimax\.io[^\s]*/i,
  /https?:\/\/[^\s]*\.minimaxi\.com[^\s]*/i,
  /https?:\/\/[^\s]*\.alicdn\.com[^\s]*/i,
  /https?:\/\/[^\s]*\.aliyuncs\.com[^\s]*/i,
];

/**
 * Check if a URL is a CDN-hosted image that should not be used as inline image.
 * These URLs cannot be fetched by the model for vision analysis.
 */
export function isCDNImageUrl(url: string): boolean {
  return CDN_IMAGE_PATTERNS.some(pattern => pattern.test(url));
}

// =============================================================================
// Redirect Guard
// =============================================================================

/**
 * Validates a redirect target URL during HTTP requests.
 * This should be called for each redirect to prevent redirect-based SSRF.
 */
export async function validateRedirectUrl(
  redirectUrl: string,
  originalUrl: string
): Promise<URLSafetyResult> {
  // Validate the redirect target
  const result = await isSafeUrl(redirectUrl);

  if (!result.safe) {
    return {
      safe: false,
      reason: `Redirect to unsafe URL blocked: ${result.reason}`,
    };
  }

  return { safe: true };
}