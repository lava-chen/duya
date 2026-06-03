/**
 * Strict external-URL safety predicate.
 *
 * Returns true iff `url` is a syntactically valid http(s) URL with a
 * non-empty hostname. Rejects:
 *   - non-string, empty, oversized
 *   - NULs or control characters anywhere in the input
 *   - any scheme other than http: or https: (file://, javascript:, data:,
 *     vbscript:, smb:, ms-*, intent:, about:, chrome:, ssh:, ftp:, ws:,
 *     duya-*, tel:, mailto:, etc.)
 *   - protocol-relative or scheme-less inputs
 *
 * This is the single source of truth for `shell.openExternal` and
 * `setWindowOpenHandler` / `will-navigate` in the main process.
 *
 * Kept in its own module (no electron imports) so it can be unit-tested
 * under plain Node / vitest.
 */

export function isHttpUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  if (url.length === 0 || url.length > 4096) return false;
  // Reject NULs and any control characters BEFORE trimming — these should
  // never appear in a valid URL but are common in injection attempts.
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code <= 0x1F || code === 0x7F) return false;
  }
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (!u.hostname) return false;
    return true;
  } catch {
    return false;
  }
}
