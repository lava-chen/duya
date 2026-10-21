/**
 * verdict/builder.test.ts — plan 519 §7.1 / A3.
 *
 * Covers the three-state ladder of `buildClickVerdict` and the honest
 * `unverifiable` result of `buildUnverifiableVerdict`.
 */

import { describe, it, expect } from 'vitest';

import {
  buildClickVerdict,
  buildUnverifiableVerdict,
} from './builder.js';
import type { FocusedEntity } from '@duya/computer-use-demo';

function entity(name: string): FocusedEntity {
  return {
    kind: 'Button',
    name,
    role: 'primary',
    bbox: { x: 0, y: 0, w: 40, h: 20 },
    redaction: { redacted: false, reasons: [] },
  } as unknown as FocusedEntity;
}

describe('buildClickVerdict', () => {
  it('returns confirmed when the focused element changed', () => {
    const v = buildClickVerdict(entity('before'), entity('after'));
    expect(v.effect).toBe('confirmed');
    expect(v.verified.elementChanged).toBe(true);
    expect(v.verified.newFocusedEntity?.name).toBe('after');
    expect(v.escalation).toBeUndefined();
  });

  it('returns unverifiable when focus is unchanged but a visual diff is seen', () => {
    const same = entity('submit');
    const v = buildClickVerdict(same, { ...same }, { screenshotChanged: true });
    expect(v.effect).toBe('unverifiable');
    expect(v.verified.elementChanged).toBe(false);
    expect(v.escalation?.recommended).toBe('re-capture');
  });

  it('returns suspected_noop with re-capture escalation when nothing changed', () => {
    const same = entity('submit');
    const v = buildClickVerdict(same, { ...same });
    expect(v.effect).toBe('suspected_noop');
    expect(v.escalation).toEqual({
      recommended: 're-capture',
      reason: expect.any(String),
    });
  });

  it('treats null / undefined focus as equivalent (no elementChanged)', () => {
    const v = buildClickVerdict(null, undefined);
    // null before + null after means the read-back produced NO signal at
    // all — that is an observation gap, not evidence of a no-op.
    expect(v.effect).toBe('unverifiable');
    expect(v.verified.elementChanged).toBe(false);
    expect(v.verified.newFocusedEntity).toBeNull();
    expect(v.escalation?.recommended).toBe('re-capture');
  });

  it('propagates fallbackUsed and readbackMs', () => {
    const v = buildClickVerdict(entity('a'), entity('b'), {
      fallbackUsed: true,
      readbackMs: 7,
    });
    expect(v.fallbackUsed).toBe(true);
    expect(v.readbackMs).toBe(7);
    expect(v.effect).toBe('confirmed');
  });
});

describe('buildUnverifiableVerdict', () => {
  it('returns unverifiable with current focus as context', () => {
    const v = buildUnverifiableVerdict(entity('field'), { readbackMs: 5 });
    expect(v.effect).toBe('unverifiable');
    expect(v.verified.elementChanged).toBe(false);
    expect(v.verified.newFocusedEntity?.name).toBe('field');
    expect(v.escalation).toBeUndefined();
    expect(v.readbackMs).toBe(5);
  });

  it('handles null focus', () => {
    const v = buildUnverifiableVerdict(null);
    expect(v.effect).toBe('unverifiable');
    expect(v.verified.newFocusedEntity).toBeNull();
  });
});