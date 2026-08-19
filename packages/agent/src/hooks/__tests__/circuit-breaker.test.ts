/**
 * circuit-breaker.test.ts — unit tests for the per-(session, event,
 * command) hook circuit breaker (bug report 2026-08-19 #8).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HookCircuitBreaker, hookBreakerKey } from '../circuit-breaker.js';

describe('hookBreakerKey', () => {
  it('scopes by session + event + command line', () => {
    const a = hookBreakerKey('s1', 'UserPromptSubmit', 'node x.mjs');
    const b = hookBreakerKey('s2', 'UserPromptSubmit', 'node x.mjs');
    const c = hookBreakerKey('s1', 'PostTurn', 'node x.mjs');
    const d = hookBreakerKey('s1', 'UserPromptSubmit', 'node y.mjs');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe('HookCircuitBreaker', () => {
  // Tiny windows so tests can exercise half-open behavior without waiting.
  let breaker: HookCircuitBreaker;

  beforeEach(() => {
    breaker = new HookCircuitBreaker(3, 10 * 60 * 1000, 5 * 60 * 1000);
  });

  it('lets hooks run until maxFailures consecutive infra failures', () => {
    const key = 'k';
    expect(breaker.check(key)).toBe(true);
    breaker.recordFailure(key);
    breaker.recordFailure(key);
    expect(breaker.check(key)).toBe(true);
    breaker.recordFailure(key);
    expect(breaker.check(key)).toBe(false);
    expect(breaker.describe(key)).toContain('3/3');
  });

  it('does not trip on verifier-style non-zero exits (process ran)', () => {
    const key = 'k';
    breaker.recordFailure(key, /* verifier */ true);
    breaker.recordFailure(key, true);
    breaker.recordFailure(key, true);
    expect(breaker.check(key)).toBe(true);
    expect(breaker.describe(key)).toBeNull();
  });

  it('resets on success', () => {
    const key = 'k';
    breaker.recordFailure(key);
    breaker.recordFailure(key);
    breaker.recordSuccess(key);
    breaker.recordFailure(key);
    breaker.recordFailure(key);
    expect(breaker.check(key)).toBe(true);
  });

  it('re-opens immediately on the probe run after cooldown expires', () => {
    const key = 'k';
    // Fast cooldown (50ms) so the probe path is testable.
    const fast = new HookCircuitBreaker(2, 10 * 60 * 1000, 50);
    fast.recordFailure(key);
    fast.recordFailure(key);
    expect(fast.check(key)).toBe(false);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Cooldown expired — one probe run is allowed (half-open).
        expect(fast.check(key)).toBe(true);
        // The probe fails again → re-opened immediately.
        fast.recordFailure(key);
        expect(fast.check(key)).toBe(false);
        resolve();
      }, 120);
    });
  });

  it('decays the failure window after the window elapses', () => {
    const key = 'k';
    // windowMs of 100ms: a failure after the window resets the count.
    const decay = new HookCircuitBreaker(3, 100, 5 * 60 * 1000);
    decay.recordFailure(key);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        decay.recordFailure(key);
        decay.recordFailure(key);
        // Only 2 failures within the new window — still closed.
        expect(decay.check(key)).toBe(true);
        resolve();
      }, 150);
    });
  });

  it('scopes breaker state per key', () => {
    breaker.recordFailure('a');
    breaker.recordFailure('a');
    breaker.recordFailure('a');
    expect(breaker.check('a')).toBe(false);
    expect(breaker.check('b')).toBe(true);
  });
});
