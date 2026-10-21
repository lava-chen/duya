/**
 * The ask chain's decision mapping (plan 611 P0-2).
 *
 * The TUI's picker answers with `once | always | deny | null`; the executor's
 * `ChatOptions.requestPermission` contract wants `'allow' | 'deny' |
 * 'paused'`. The mapping IS the security boundary of the CLI ask chain: the
 * failure mode to pin is a silent answer (`null` — Esc, a deadline, a closed
 * queue) mapping to an allow.
 */

import { describe, it, expect } from 'vitest';
import { mapPermissionDecision } from '../tui-session.js';

describe('mapPermissionDecision', () => {
  it('maps both allow flavours to allow', () => {
    expect(mapPermissionDecision('once')).toBe('allow');
    expect(mapPermissionDecision('always')).toBe('allow');
  });

  it('maps an explicit deny to deny', () => {
    expect(mapPermissionDecision('deny')).toBe('deny');
  });

  it('maps silence to a refusal, never to an allow', () => {
    expect(mapPermissionDecision(null)).toBe('deny');
  });

  it('never produces the bot-surface paused verdict', () => {
    for (const decision of ['once', 'always', 'deny', null] as const) {
      expect(mapPermissionDecision(decision)).not.toBe('paused');
    }
  });
});
