/**
 * Quitting while runs are in flight asks first.
 *
 * Two things are worth pinning here: the summary must be silent when there is
 * nothing running (otherwise every quit shows a pointless dialog), and only an
 * explicit affirmative may discard work.
 */
import { describe, expect, it } from 'vitest';
import { describeBusyWork, resolveBusyQuitChoice } from './quit-guard';

describe('describeBusyWork', () => {
  it('says nothing when nothing is streaming', () => {
    expect(describeBusyWork(0)).toBeNull();
    expect(describeBusyWork(-3)).toBeNull();
  });

  it('treats an unreadable count as nothing to report', () => {
    // The caller already decided what a failed read means; the formatter must
    // not invent a number to warn about.
    expect(describeBusyWork(Number.NaN)).toBeNull();
    expect(describeBusyWork(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('counts one run in the singular', () => {
    expect(describeBusyWork(1)).toBe('1 agent run is still streaming.');
  });

  it('counts several runs in the plural', () => {
    expect(describeBusyWork(4)).toBe('4 agent runs are still streaming.');
  });
});

describe('resolveBusyQuitChoice', () => {
  it('quits only on the explicit button', () => {
    expect(resolveBusyQuitChoice(0)).toBe(true);
  });

  it('keeps the app alive on cancel and on dismissal', () => {
    expect(resolveBusyQuitChoice(1)).toBe(false);
    expect(resolveBusyQuitChoice(-1)).toBe(false);
    expect(resolveBusyQuitChoice(7)).toBe(false);
  });
});
