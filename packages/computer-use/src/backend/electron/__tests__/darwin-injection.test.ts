/**
 * darwin-injection.ts — unit tests (plan 572 D4).
 *
 * The ladder: AX action (handle present) → foreground (coordinate
 * fallback, fallbackUsed surfaced) → no-target. Keyboard/scroll gains
 * a pid-event rung (CGEventPostToPid) that clicks deliberately LACK —
 * Chromium filters pid-posted mouse events.
 */

import { describe, expect, it } from 'vitest';

import {
  applyDarwinDecisionToVerdict,
  decideDarwinClick,
  decideDarwinKeyDelivery,
  isChromiumProcess,
} from '../darwin-injection.js';

describe('decideDarwinClick', () => {
  it('prefers the AX-action rung when the fresh capture carried a handle', () => {
    expect(decideDarwinClick({ handle: 'h12', pid: 42, hasClickPoint: true })).toEqual({
      mode: 'ax-action',
      pid: 42,
      handle: 'h12',
    });
  });

  it('never proposes pid-event for clicks even on Chromium (no rung exists)', () => {
    const decision = decideDarwinClick({ handle: 'h1', pid: 100, hasClickPoint: true });
    expect(decision.mode).not.toBe('pid-event');
  });

  it('falls back to the foreground cursor path with fallbackUsed surfaced', () => {
    const decision = decideDarwinClick({ handle: null, pid: null, hasClickPoint: true });
    expect(decision).toMatchObject({ mode: 'foreground', fallbackUsed: true });
    if (decision.mode === 'foreground') {
      expect(decision.reason).toContain('foreground');
    }
  });

  it('reports no-target when neither handle nor coordinates exist', () => {
    const decision = decideDarwinClick({ handle: null, hasClickPoint: false });
    expect(decision).toMatchObject({
      mode: 'no-target',
      fallbackUsed: true,
      recommended: 're-capture',
    });
  });

  it('ignores a handle without a pid (cannot target the action)', () => {
    expect(decideDarwinClick({ handle: 'h1', pid: null, hasClickPoint: true }).mode).toBe('foreground');
  });
});

describe('decideDarwinKeyDelivery', () => {
  it('targets a background pid for keyboard/scroll (CGEventPostToPid)', () => {
    expect(decideDarwinKeyDelivery({ foregroundPid: 1, targetPid: 2 })).toEqual({
      mode: 'pid-event',
      pid: 2,
      fallbackUsed: false,
    });
  });

  it('keeps the focused app on the normal foreground path', () => {
    expect(decideDarwinKeyDelivery({ foregroundPid: 5, targetPid: 5 })).toEqual({ mode: 'foreground' });
  });

  it('degrades to foreground when either pid is unknown', () => {
    expect(decideDarwinKeyDelivery({ foregroundPid: null, targetPid: 2 }).mode).toBe('foreground');
    expect(decideDarwinKeyDelivery({ foregroundPid: 1, targetPid: null }).mode).toBe('foreground');
  });

  it('keeps non-ascii payloads on the foreground path (unicode-string typing)', () => {
    expect(
      decideDarwinKeyDelivery({ foregroundPid: 1, targetPid: 2, nonAscii: true }).mode,
    ).toBe('foreground');
  });
});

describe('isChromiumProcess', () => {
  it('detects the Chromium family by process name', () => {
    expect(isChromiumProcess('Google Chrome')).toBe(true);
    expect(isChromiumProcess('Electron')).toBe(true);
    expect(isChromiumProcess('Safari')).toBe(false);
    expect(isChromiumProcess(null)).toBe(false);
  });
});

describe('applyDarwinDecisionToVerdict', () => {
  it('marks the foreground fallback as a focus-moving degradation', () => {
    const verdict: { fallbackUsed?: boolean; escalation?: { recommended: string; reason: string } } = {};
    applyDarwinDecisionToVerdict(verdict, {
      mode: 'foreground',
      fallbackUsed: true,
      reason: 'no AX handle on the fresh capture',
    });
    expect(verdict.fallbackUsed).toBe(true);
    expect(verdict.escalation).toMatchObject({ recommended: 'background' });
  });

  it('does NOT flag the preferred AX-action rung as a fallback', () => {
    const verdict: { fallbackUsed?: boolean } = {};
    applyDarwinDecisionToVerdict(verdict, { mode: 'ax-action', pid: 1, handle: 'h1' });
    expect(verdict.fallbackUsed).toBeUndefined();
  });

  it('surfaces re-capture guidance for no-target', () => {
    const verdict: { fallbackUsed?: boolean; escalation?: { recommended: string } } = {};
    applyDarwinDecisionToVerdict(verdict, {
      mode: 'no-target',
      fallbackUsed: true,
      recommended: 're-capture',
      reason: 'no AX handle and no resolvable click point',
    });
    expect(verdict.escalation?.recommended).toBe('re-capture');
  });
});
