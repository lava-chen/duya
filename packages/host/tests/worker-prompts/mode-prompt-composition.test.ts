/**
 * Plan 619 Phase 1 — mode prompt composition.
 *
 * A mode prefix was joined to the base prompt with two different separators,
 * so the same run produced two different byte sequences and the system
 * prompt changed between the first turn and the next (plan 619 defect h).
 */

import { describe, expect, it } from 'vitest';

import { composeModePrompt } from '@duya/host/worker-modes/modifiers/apply-modes';
import type { ModeModifierContext } from '@duya/host/worker-modes/modifiers/types';

const ctx = { state: {} } as unknown as ModeModifierContext;

describe('plan 619 phase 1 — mode prompt composition', () => {
  it('joins a string prefix with a blank line', () => {
    expect(composeModePrompt('BASE', ['PREFIX'], [], ctx)).toBe('PREFIX\n\nBASE');
  });

  it('joins several string prefixes in registration order', () => {
    // Each prefix prepends, so the last one registered ends up first —
    // the order applyModes has always produced.
    expect(composeModePrompt('BASE', ['ONE', 'TWO'], [], ctx)).toBe('TWO\n\nONE\n\nBASE');
  });

  it('leaves a function prefix in charge of its own composition', () => {
    const prefix = (_c: ModeModifierContext, base: string): string => `HEAD${base}`;
    expect(composeModePrompt('BASE', [prefix], [], ctx)).toBe('HEADBASE');
  });

  it('appends suffixes after the prefixes', () => {
    expect(composeModePrompt('BASE', ['PREFIX'], ['SUFFIX'], ctx)).toBe(
      'PREFIX\n\nBASE\n\nSUFFIX',
    );
  });

  it('produces the same bytes for the same inputs', () => {
    const first = composeModePrompt('BASE', ['PREFIX'], [], ctx);
    const second = composeModePrompt('BASE', ['PREFIX'], [], ctx);
    expect(first).toBe(second);
  });
});
