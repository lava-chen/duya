/**
 * resume-token.ts — signed resume tokens for suspended workflow runs
 * (plan 552 §6.3).
 *
 * A suspended run (human approval / low-confidence decision parked on
 * `ask`) resumes only through a token that (a) carries the run + node
 * identity, (b) is HMAC-signed with the host secret, and (c) is compared
 * timing-safely. A replayed/forbidden token verifies to null — the run
 * stays parked. The `AlreadyResuming` guard lives in the store (Phase 4);
 * this module is the pure crypto contract.
 */

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export interface ResumeTokenPayload {
  runId: string;
  nodeId: string;
  /** Issuance instant — lets the store reject tokens from earlier epochs. */
  issuedAt: number;
  /** Caller nonce binding one token to one resume attempt. */
  nonce: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function createResumeToken(secret: string, payload: Omit<ResumeTokenPayload, 'nonce'> & { nonce?: string }): string {
  const full: ResumeTokenPayload = {
    ...payload,
    nonce: payload.nonce ?? randomUUID(),
  };
  const body = b64url(JSON.stringify(full));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verify a resume token. Returns the payload on success, null on any
 * mismatch (signature, shape). Comparison is timing-safe.
 */
export function verifyResumeToken(secret: string, token: string): ResumeTokenPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ResumeTokenPayload;
    if (
      typeof payload.runId !== 'string' ||
      typeof payload.nodeId !== 'string' ||
      typeof payload.issuedAt !== 'number' ||
      typeof payload.nonce !== 'string'
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
