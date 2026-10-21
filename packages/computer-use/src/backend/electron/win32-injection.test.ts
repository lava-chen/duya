/**
 * win32-injection.test.ts — background-priority click injection decision
 * ladder (plan 519 §3.7 / C1).
 *
 * Exercises the pure decision function + verdict-patching across the four
 * HWND-compare cases:
 *   - same window        → normal path, no fallback
 *   - different window   → direct inject, no fallback
 *   - foreground unknown → raise fallback (fallbackUsed)
 *   - no target          → re-capture fallback (fallbackUsed)
 */

import { describe, it, expect } from 'vitest';

import {
  decideClickInjection,
  applyInjectionToVerdict,
  type ClickInjectionDecision,
} from './win32-injection.js';

describe('decideClickInjection — HWND compare ladder', () => {
  it('same-window: target === foreground → no fallback', () => {
    const decision = decideClickInjection({
      foreground: 0x10,
      target: 0x10,
    });
    expect(decision.mode).toBe('same-window');
  });

  it('different known window → background-direct, no fallback', () => {
    const decision = decideClickInjection({
      foreground: 0x10,
      target: 0x20,
    });
    expect(decision.mode).toBe('background-direct');
    expect(decision).toMatchObject({ targetHwnd: 0x20 });
    if (decision.mode !== 'background-direct') throw new Error('unreachable');
    expect(decision.fallbackUsed).toBeUndefined();
  });

  it('foreground unknown (headless / late probe) → raise fallback', () => {
    const decision = decideClickInjection({
      foreground: null,
      target: 0x30,
    });
    expect(decision.mode).toBe('background-raise');
    if (decision.mode !== 'background-raise') throw new Error('unreachable');
    expect(decision.fallbackUsed).toBe(true);
    expect(decision.recommended).toBe('raise');
  });

  it('no resolved target → no-target + re-capture fallback', () => {
    const decision = decideClickInjection({
      foreground: 0x10,
      target: null,
    });
    expect(decision.mode).toBe('no-target');
    if (decision.mode !== 'no-target') throw new Error('unreachable');
    expect(decision.fallbackUsed).toBe(true);
    expect(decision.recommended).toBe('re-capture');
  });
});

describe('applyInjectionToVerdict — surfaces fallbackUsed + escalation', () => {
  it('leave verdict untouched for same-window / direct inject', () => {
    for (const d of [
      { mode: 'same-window' } as ClickInjectionDecision,
      { mode: 'background-direct', targetHwnd: 1 } as ClickInjectionDecision,
    ]) {
      const verdict: { fallbackUsed?: boolean; escalation?: { recommended: string; reason: string } } = {};
      applyInjectionToVerdict(verdict, d);
      expect(verdict.fallbackUsed).toBeUndefined();
      expect(verdict.escalation).toBeUndefined();
    }
  });

  it('raise fallback sets fallbackUsed=true and adds raise escalation when absent', () => {
    const verdict: { fallbackUsed?: boolean; escalation?: { recommended: string; reason: string } } = {};
    applyInjectionToVerdict(verdict, {
      mode: 'background-raise',
      targetHwnd: 7,
      fallbackUsed: true,
      recommended: 'raise',
      reason: 'foreground unknown',
    });
    expect(verdict.fallbackUsed).toBe(true);
    expect(verdict.escalation?.recommended).toBe('raise');
  });

  it('no-target sets fallbackUsed and keeps existing escalation intact', () => {
    const verdict: { fallbackUsed?: boolean; escalation?: { recommended: string; reason: string } } = {
      escalation: { recommended: 're-capture', reason: 'already set' },
    };
    applyInjectionToVerdict(verdict, {
      mode: 'no-target',
      fallbackUsed: true,
      recommended: 're-capture',
      reason: 'no window under point',
    });
    expect(verdict.fallbackUsed).toBe(true);
    // Pre-existing escalation wins — we never clobber a higher-priority one.
    expect(verdict.escalation?.recommended).toBe('re-capture');
  });
});