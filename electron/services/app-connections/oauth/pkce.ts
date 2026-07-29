/**
 * PKCE (RFC 7636) + state nonce helpers for the OAuth authorization-code
 * flow. Plan 312 Phase 1.
 *
 * - `code_verifier`: 43-128 char random string from url-safe alphabet
 * - `code_challenge`: base64url(SHA256(code_verifier))  (method S256)
 * - `state`: random nonce to bind the redirect back to this attempt
 *
 * These helpers are pure: callers persist the verifier/state until the
 * redirect lands and use them to complete the code exchange.
 */

import { randomBytes, createHash } from 'crypto';

/** RFC 7636 §4.1: 43-128 chars of [A-Z][a-z][0-9]-._~ */
export function generateCodeVerifier(length = 64): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

/** RFC 7636 §4.2: S256 = base64url(SHA256(verifier)). */
export function computeCodeChallenge(verifier: string): string {
  const hash = createHash('sha256').update(verifier, 'utf-8').digest();
  return hash.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** CSRF nonce: opaque random string. */
export function generateState(length = 32): string {
  return randomBytes(length).toString('hex');
}

export interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  state: string;
}

/** Convenience: build the full PKCE + state bundle in one call. */
export function buildPkceChallenge(): PkceChallenge {
  const verifier = generateCodeVerifier();
  return {
    codeVerifier: verifier,
    codeChallenge: computeCodeChallenge(verifier),
    codeChallengeMethod: 'S256',
    state: generateState(),
  };
}
