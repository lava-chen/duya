/**
 * Drift test #6 — the error taxonomy cannot contradict itself.
 *
 * Design source: 07-agent-protocol-spec.md §15 (#6), §11.
 *
 * The partition assertion is the important one: every code is exactly one of
 * RETRYABLE or TERMINAL, never both and never neither. A code that is in
 * neither would leave a host guessing, which is the whole failure mode this
 * taxonomy replaces (`SSEEvent.error.metadata.isRetryable` and
 * `Session.errorRetryable` are both writer-computed booleans and therefore
 * untrustworthy under version skew).
 */

import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  RETRYABLE_ERROR_CODES,
  TERMINAL_ERROR_CODES,
  UNCLASSIFIED_ERROR_CODES,
  isKnownCode,
  isRetryable,
  isTerminal,
} from '../src/index.js';

describe('drift #6: error codes', () => {
  it('the list has no duplicates', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('RETRYABLE and TERMINAL are disjoint', () => {
    const overlap = [...RETRYABLE_ERROR_CODES].filter((c) => TERMINAL_ERROR_CODES.has(c));
    expect(overlap, `codes cannot be both retryable and terminal: ${overlap.join(', ')}`).toEqual([]);
  });

  it('every code is classified exactly once, or explicitly unclassified', () => {
    const classified = new Set([...RETRYABLE_ERROR_CODES, ...TERMINAL_ERROR_CODES]);
    const unclassified = ERROR_CODES.filter((c) => !classified.has(c));
    // runtime_crash and transport_backpressure_timeout are deliberately
    // unclassified: an escalated hard kill and an adapter drain timeout are
    // decided by transport policy, not by the run.
    expect([...unclassified].sort()).toEqual([...UNCLASSIFIED_ERROR_CODES].sort());
    expect(unclassified.length).toBeLessThanOrEqual(4);
  });

  it('isRetryable fails CLOSED on an unknown code', () => {
    // Retrying forever against a code nobody has seen is worse than not
    // retrying at all.
    expect(isRetryable('never_seen_code')).toBe(false);
    expect(isRetryable('')).toBe(false);
    expect(isKnownCode('never_seen_code')).toBe(false);
    expect(isKnownCode('internal')).toBe(true);
  });

  it('isRetryable and isTerminal agree with the sets', () => {
    for (const code of ERROR_CODES) {
      expect(isRetryable(code)).toBe(RETRYABLE_ERROR_CODES.has(code));
      if (!RETRYABLE_ERROR_CODES.has(code) && !UNCLASSIFIED_ERROR_CODES.has(code)) {
        expect(isTerminal(code)).toBe(TERMINAL_ERROR_CODES.has(code));
      } else {
        expect(isTerminal(code)).toBe(false);
      }
    }
  });

  it('retryable codes are the transient provider and transport ones', () => {
    for (const code of RETRYABLE_ERROR_CODES) {
      expect(
        /^(provider_(rate_limited|overloaded|timeout|unavailable)|transport_closed|runtime_unavailable|deadline_exceeded)$/.test(code),
        `${code} is retryable but is not a transient condition`,
      ).toBe(true);
    }
  });

  it('credential and policy failures are never retryable', () => {
    for (const code of ['provider_auth', 'provider_quota', 'permission_denied_by_policy', 'capability_unsupported']) {
      expect(isRetryable(code), `${code} must not be retryable`).toBe(false);
      expect(isTerminal(code)).toBe(true);
    }
  });
});
