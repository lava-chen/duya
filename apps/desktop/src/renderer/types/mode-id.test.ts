/**
 * mode-id.test.ts — plan 413e made plan-task a session-level mode. These
 * tests pin the mode-kind table and the mutual-exclusion helpers so the
 * frontend and agent stay aligned (mirrors ModeModifier.kind/exclusiveWith).
 */
import { describe, expect, it } from 'vitest';
import {
  MODE_KIND,
  toggleModeInSet,
  isModeExcludedByActive,
} from '@/types/mode-id';

describe('MODE_KIND (plan 413e)', () => {
  it('marks plan-task as session-level so it survives message sends', () => {
    expect(MODE_KIND['plan-task']).toBe('session');
    // Plan 423: research is a session-level deep-research state machine.
    expect(MODE_KIND['research']).toBe('session');
    expect(MODE_KIND['conductor']).toBe('session');
  });

  it('marks goal as session-level (plan 411)', () => {
    expect(MODE_KIND['goal']).toBe('session');
  });

  it('marks computer-use as session-level (plan 454)', () => {
    expect(MODE_KIND['computer-use']).toBe('session');
  });
});

describe('toggleModeInSet with session-level plan-task', () => {
  it('strips research when enabling plan-task', () => {
    const next = toggleModeInSet(new Set(['research']), 'plan-task');
    expect(next.has('plan-task')).toBe(true);
    expect(next.has('research')).toBe(false);
  });

  it('enabling research drops plan-task but keeps conductor', () => {
    const next = toggleModeInSet(new Set(['plan-task', 'conductor']), 'research');
    expect(next.has('research')).toBe(true);
    expect(next.has('plan-task')).toBe(false); // research excludes plan-task
    expect(next.has('conductor')).toBe(true); // research does not exclude conductor
  });

  it('toggling plan-task off removes it', () => {
    const next = toggleModeInSet(new Set(['plan-task']), 'plan-task');
    expect(next.has('plan-task')).toBe(false);
  });
});

describe('isModeExcludedByActive with plan-task', () => {
  it('blocks conductor while plan-task is active', () => {
    expect(isModeExcludedByActive(new Set(['plan-task']), 'conductor')).toBe(true);
  });

  it('blocks research while plan-task is active', () => {
    expect(isModeExcludedByActive(new Set(['plan-task']), 'research')).toBe(true);
  });
});

describe('goal mode exclusivity (plan 411)', () => {
  it('goal excludes nothing — parallel tracker with plan-task', () => {
    expect(isModeExcludedByActive(new Set(['goal']), 'plan-task')).toBe(false);
    expect(isModeExcludedByActive(new Set(['plan-task']), 'goal')).toBe(false);
    expect(isModeExcludedByActive(new Set(['goal']), 'research')).toBe(false);
    expect(isModeExcludedByActive(new Set(['goal']), 'conductor')).toBe(false);
  });

  it('goal toggles on independently and co-exists with plan-task', () => {
    const next = toggleModeInSet(new Set(['plan-task']), 'goal');
    expect(next.has('goal')).toBe(true);
    expect(next.has('plan-task')).toBe(true);
  });
});

describe('computer-use mode exclusivity (plan 454)', () => {
  it('computer-use blocks every other session-level mode', () => {
    const active = new Set<import('@/types/mode-id').ModeModifierId>(['computer-use']);
    expect(isModeExcludedByActive(active, 'plan-task')).toBe(true);
    expect(isModeExcludedByActive(active, 'research')).toBe(true);
    expect(isModeExcludedByActive(active, 'conductor')).toBe(true);
    expect(isModeExcludedByActive(active, 'goal')).toBe(true);
  });

  it('toggling computer-use on drops all other session-level modes', () => {
    const next = toggleModeInSet(
      new Set<import('@/types/mode-id').ModeModifierId>([
        'plan-task',
        'goal',
      ]),
      'computer-use',
    );
    expect(next.has('computer-use')).toBe(true);
    expect(next.has('plan-task')).toBe(false);
    expect(next.has('goal')).toBe(false);
  });

  it('toggling computer-use off leaves the set intact otherwise', () => {
    const next = toggleModeInSet(
      new Set<import('@/types/mode-id').ModeModifierId>(['computer-use']),
      'computer-use',
    );
    expect(next.has('computer-use')).toBe(false);
    expect(next.size).toBe(0);
  });
});
