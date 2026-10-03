/**
 * The redaction policy, on its own.
 *
 * ## Why this file exists
 *
 * `eval-legacy-loop.test.ts` asserts that a captured artifact contains no
 * secret. That assertion is NECESSARY and INSUFFICIENT on its own: an artifact
 * that never captured the secret passes it just as well as one that captured
 * and redacted it. A mutation that disabled redaction entirely therefore
 * passed the loop test — caught here instead, by asserting the direction of
 * the change: a value that DOES contain a known secret must COME BACK
 * different.
 *
 * That is the property the loop test cannot state and this one can, so the two
 * together say what is actually true: secrets that reach an artifact are
 * redacted, and no secret survives one.
 */

import { describe, expect, it } from 'vitest';
import { containsSecret, redactSecrets, redactValue } from './eval-redaction';

describe('E4.1 — the redaction policy', () => {
  it('changes a value that contains a real secret', () => {
    // The direction assertion. If this ever passes without the value
    // changing, redaction is inert and every artifact-level "no secret here"
    // assertion downstream is measuring nothing.
    const raw = 'connecting with sk-eval-offline-REDACT-ME now';
    expect(redactSecrets(raw)).not.toBe(raw);
    expect(redactSecrets(raw)).toBe('connecting with sk-[REDACTED] now');
    expect(containsSecret(raw)).toBe(true);
  });

  it('blanks a secret-bearing KEY whatever the value looks like', () => {
    // The structural pass. A value that matches no text pattern must still be
    // blanked, or redaction depends on every secret happening to have a
    // recognisable shape.
    const shaped = { apiKey: 'zzz-not-a-recognisable-key-shape' };
    expect(redactValue(shaped)).toEqual({ apiKey: '[REDACTED]' });

    for (const key of ['authorization', 'auth_token', 'accessToken', 'password', 'secret']) {
      expect(redactValue({ [key]: 'anything at all' })).toEqual({ [key]: '[REDACTED]' });
    }
  });

  it('redacts secrets embedded in headers, JSON and URLs', () => {
    // The prefix is PRESERVED and only the credential is replaced, so a
    // redacted line is still readable as the kind of line it was. That is the
    // same rule the normaliser follows: replace the noise, keep the structure.
    const cases: ReadonlyArray<[string, string]> = [
      ['authorization: Bearer abcdef0123456789', 'authorization: Bearer [REDACTED]'],
      ['x-api-key: abcdef0123456789', 'x-api-key: [REDACTED]'],
      ['{"apiKey":"abcdef0123456789"}', '{"apiKey":"[REDACTED]"}'],
      ['https://example.test/v1?key=abcdef0123456789&x=1', 'https://example.test/v1?key=[REDACTED]&x=1'],
    ];
    for (const [raw, expected] of cases) {
      expect(redactSecrets(raw)).toBe(expected);
    }
  });

  it('leaves a value with no secret untouched', () => {
    // The other direction, so a rule cannot be "redact everything" and pass.
    const clean = 'EVAL_LOOP_OK read notes.txt from the workspace';
    expect(redactSecrets(clean)).toBe(clean);
    expect(containsSecret(clean)).toBe(false);
  });

  it('walks nested structures without losing the shape', () => {
    const nested = {
      run: { id: 'r1', env: { apiKey: 'sk-abc123456789', ref: 'env:x' } },
      frames: [{ header: 'x-api-key: deadbeef012345' }],
    };
    const redacted = redactValue(nested) as Record<string, never>;
    expect(JSON.stringify(redacted)).not.toContain('sk-abc123456789');
    expect(JSON.stringify(redacted)).not.toContain('deadbeef012345');
    // The non-sensitive neighbours are untouched, so a redaction is visible as
    // a redaction rather than as data loss.
    expect(redacted['run']).toMatchObject({ id: 'r1', env: { ref: 'env:x' } });
  });
});
