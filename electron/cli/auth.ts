/**
 * electron/cli/auth.ts
 *
 * CLI API server token generation + Bearer authentication helper.
 *
 * Token characteristics:
 * - 32 random bytes (256 bits) → 64 hex chars
 * - Generated at server startup, not persisted to settings.json
 * - Stored ONLY in userData/runtime/cli-api.json (ephemeral runtime file)
 * - Never logged in plaintext, never returned in error messages
 */

import { randomBytes, timingSafeEqual } from 'crypto';

const TOKEN_BYTES = 32;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Constant-time Bearer token comparison.
 * Returns false if header is missing, malformed, or token mismatch.
 * Never throws; never logs token contents.
 */
export function checkBearer(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader) return false;
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const presented = authHeader.slice(prefix.length).trim();
  if (!presented) return false;

  // Lengths must match for timingSafeEqual; if not, return false without revealing length.
  if (presented.length !== expected.length) return false;

  try {
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
