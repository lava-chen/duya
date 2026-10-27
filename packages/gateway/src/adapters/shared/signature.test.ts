import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  hmacSha256,
  timingSafeEqualStr,
  verifyHubSignature,
  verifyMetaChallenge,
  verifySharedToken,
  verifyStandardWebhooks,
  verifyTimestampedSignature,
} from './signature.js';

const SECRET = 'shhh-not-a-real-secret';
const BODY = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');

describe('hmac helpers', () => {
  it('produces stable digests', () => {
    expect(hmacSha256('k', 'abc')).toBe(createHmac('sha256', 'k').update('abc').digest('hex'));
    expect(hmacSha256('k', 'abc', 'base64')).toBe(createHmac('sha256', 'k').update('abc').digest('base64'));
  });

  it('compares in constant time without throwing on length mismatch', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStr('', 'x')).toBe(false);
  });
});

describe('verifyHubSignature (Meta / GitHub style)', () => {
  const signature = `sha256=${hmacSha256(SECRET, BODY)}`;

  it('accepts a valid signature', () => {
    expect(verifyHubSignature(SECRET, BODY, signature)).toBe(true);
  });

  it('accepts a bare hex digest (legacy payloads)', () => {
    expect(verifyHubSignature(SECRET, BODY, hmacSha256(SECRET, BODY))).toBe(true);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(JSON.stringify({ hello: 'world!' }), 'utf8');
    expect(verifyHubSignature(SECRET, tampered, signature)).toBe(false);
  });

  it('rejects a wrong secret, a missing header and an empty secret', () => {
    expect(verifyHubSignature('other', BODY, signature)).toBe(false);
    expect(verifyHubSignature(SECRET, BODY, undefined)).toBe(false);
    expect(verifyHubSignature('', BODY, signature)).toBe(false);
  });
});

describe('verifyStandardWebhooks (Svix)', () => {
  const id = 'msg_123';
  const timestamp = String(Math.floor(Date.UTC(2026, 0, 1) / 1000));
  const now = () => Date.UTC(2026, 0, 1);
  const key = Buffer.from(SECRET, 'utf8');
  const signature = `v1,${createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), BODY]))
    .digest('base64')}`;

  it('accepts a valid v1 signature with a base64 secret', () => {
    const base64Secret = `whsec_${key.toString('base64')}`;
    expect(
      verifyStandardWebhooks(base64Secret, BODY, { id, timestamp, signature }, { now }),
    ).toBe(true);
  });

  it('accepts one valid entry among rotated signatures', () => {
    const headers = { id, timestamp, signature: `v1,AAAA ${signature}` };
    expect(verifyStandardWebhooks(`whsec_${key.toString('base64')}`, BODY, headers, { now })).toBe(true);
  });

  it('rejects a replay outside the tolerance window', () => {
    const stale = String(Number(timestamp) - 3600);
    const staleSignature = `v1,${createHmac('sha256', key)
      .update(Buffer.concat([Buffer.from(`${id}.${stale}.`), BODY]))
      .digest('base64')}`;
    expect(
      verifyStandardWebhooks(
        `whsec_${key.toString('base64')}`,
        BODY,
        { id, timestamp: stale, signature: staleSignature },
        { now },
      ),
    ).toBe(false);
  });

  it('rejects incomplete headers', () => {
    expect(verifyStandardWebhooks('whsec_x', BODY, { id })).toBe(false);
  });
});

describe('verifyTimestampedSignature', () => {
  const now = () => 1_000_000_000_000;
  const timestamp = String(now() / 1000);
  const signature = hmacSha256(SECRET, Buffer.concat([Buffer.from(`${timestamp}.`), BODY]));

  it('accepts a fresh signature', () => {
    expect(verifyTimestampedSignature(SECRET, BODY, signature, timestamp, { now })).toBe(true);
  });

  it('rejects a stale timestamp', () => {
    expect(verifyTimestampedSignature(SECRET, BODY, signature, String(now() / 1000 - 600), { now })).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    expect(verifyTimestampedSignature(SECRET, BODY, signature, 'soon', { now })).toBe(false);
  });
});

describe('verifySharedToken', () => {
  it('matches exactly', () => {
    expect(verifySharedToken('abc', 'abc')).toBe(true);
    expect(verifySharedToken('abc', 'abd')).toBe(false);
    expect(verifySharedToken('', '')).toBe(false);
  });
});

describe('verifyMetaChallenge', () => {
  const toQuery = (entries: Record<string, string>) => new URLSearchParams(entries);

  it('echoes the challenge for the configured token', () => {
    const query = toQuery({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '42' });
    expect(verifyMetaChallenge(query, 'vt')).toBe('42');
  });

  it('returns null for a wrong token, wrong mode or unconfigured token', () => {
    expect(
      verifyMetaChallenge(
        toQuery({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '42' }),
        'vt',
      ),
    ).toBeNull();
    expect(
      verifyMetaChallenge(toQuery({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'vt' }), 'vt'),
    ).toBeNull();
    expect(
      verifyMetaChallenge(toQuery({ 'hub.mode': 'subscribe', 'hub.verify_token': '' }), ''),
    ).toBeNull();
  });
});
