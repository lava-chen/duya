/**
 * Inbound webhook signature verification.
 *
 * Webhook-based channels (WhatsApp Cloud, Microsoft Graph, the generic webhook
 * channel, BlueBubbles) all verify a caller, but each vendor invented its own
 * scheme. The adapters share one implementation so the "difficult" part —
 * constant-time comparison over a raw body, ordering between body read and
 * verification, replay windows — exists exactly once.
 *
 * Rule enforced everywhere: the signature is computed over the **raw** body
 * bytes. Parsing JSON before verifying means an attacker controls what is
 * verified.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type HmacEncoding = 'hex' | 'base64';

/** HMAC-SHA256 digest of `body` keyed with `secret`. */
export function hmacSha256(
  secret: string,
  body: string | Buffer,
  encoding: HmacEncoding = 'hex',
): string {
  return createHmac('sha256', secret).update(body).digest(encoding);
}

/** Constant-time string comparison that never throws on length mismatch. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/**
 * `X-Hub-Signature-256: sha256=<hex>` — used by Meta (WhatsApp/Instagram) and
 * GitHub. Meta omits the prefix on some legacy payloads, so both are accepted.
 */
export function verifyHubSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (!secret || !header) return false;
  const provided = stripPrefix(header.trim(), 'sha256=');
  const expected = hmacSha256(secret, rawBody, 'hex');
  return timingSafeEqualStr(expected, provided);
}

export interface StandardWebhooksHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

/**
 * Standard Webhooks (Svix) — `v1,<base64>` over `${id}.${timestamp}.${body}`.
 * Secrets may carry the `whsec_` prefix and are base64-encoded.
 */
export function verifyStandardWebhooks(
  secret: string,
  rawBody: Buffer,
  headers: StandardWebhooksHeaders,
  options: { toleranceSeconds?: number; now?: () => number } = {},
): boolean {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;

  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? Date.now;
  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  if (Math.abs(now() / 1000 - tsSeconds) > tolerance) return false;

  const key = Buffer.from(stripPrefix(secret, 'whsec_'), 'base64');
  const signedContent = Buffer.concat([
    Buffer.from(`${id}.${timestamp}.`, 'utf8'),
    rawBody,
  ]);
  const expected = createHmac('sha256', key).update(signedContent).digest('base64');

  // A single header may carry several space-separated signatures (key rotation).
  for (const candidate of signature.split(' ')) {
    const value = stripPrefix(candidate.trim(), 'v1,');
    if (value && timingSafeEqualStr(expected, value)) return true;
  }
  return false;
}

/**
 * Generic scheme: `HMAC(secret, "${timestamp}.${body}")` compared against
 * `signatureHeader`, with a replay window on `timestampHeader`.
 *
 * This is what the generic webhook channel documents for non-vendor callers.
 */
export function verifyTimestampedSignature(
  secret: string,
  rawBody: Buffer,
  signature: string | undefined,
  timestamp: string | undefined,
  options: { toleranceSeconds?: number; now?: () => number } = {},
): boolean {
  if (!secret || !signature || !timestamp) return false;

  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? Date.now;
  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  if (Math.abs(now() / 1000 - tsSeconds) > tolerance) return false;

  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
  const provided = stripPrefix(signature.trim(), 'sha256=');
  return timingSafeEqualStr(hmacSha256(secret, signed, 'hex'), provided);
}

/** Static shared-secret comparison (e.g. `X-Gitlab-Token`). */
export function verifySharedToken(expected: string, provided: string | undefined): boolean {
  if (!expected || !provided) return false;
  return timingSafeEqualStr(expected, provided);
}

/** Meta webhook GET handshake: returns the challenge to echo, or `null`. */
export function verifyMetaChallenge(
  query: URLSearchParams,
  expectedToken: string,
): string | null {
  if (!expectedToken) return null;
  if (query.get('hub.mode') !== 'subscribe') return null;
  const token = query.get('hub.verify_token');
  if (!token || !timingSafeEqualStr(expectedToken, token)) return null;
  return query.get('hub.challenge');
}
