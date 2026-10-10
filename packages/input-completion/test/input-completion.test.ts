import { describe, expect, it } from 'vitest';
import { detectPopoverTrigger, filterItems, resolveItemSelection, cycleIndex } from '../src/index.js';
import type { PopoverItem } from '../src/index.js';

/**
 * The shared core, held to the desktop's existing behaviour.
 *
 * ## Why these are ported-assertions rather than new-spec assertions
 *
 * Every case here has a counterpart in
 * `apps/desktop/src/renderer/lib/message-input-logic.spec.ts`. The desktop's
 * implementation is moving into this package, so if these tests merely re-state
 * what the new code does, they prove nothing about whether the move was
 * faithful. The desktop suite therefore STAYS in place and keeps running against
 * a re-export of this package — that pairing is what makes it a move rather than
 * a rewrite, and it is the only thing that would catch a behaviour change
 * introduced while relocating the code.
 *
 * What these tests add is coverage the desktop never had: the desktop's spec
 * never exercised `detectPopoverTrigger` at all, and never exercised
 * `cycleIndex`.
 */

function item(label: string, value: string, description?: string): PopoverItem {
  return description === undefined ? { label, value } : { label, value, description };
}

describe('detectPopoverTrigger', () => {
  it('opens the skill popup for a slash at the start of the input', () => {
    expect(detectPopoverTrigger('/doc', 4)).toEqual({ mode: 'skill', filter: 'doc', triggerPos: 0 });
  });

  it('opens the skill popup for a slash after whitespace', () => {
    // 'hello /doc' is ten characters, so the caret that sees the whole token
    // is 10 — and passing 9 would correctly report a narrower 'do'.
    expect(detectPopoverTrigger('hello /doc', 10)).toEqual({
      mode: 'skill',
      filter: 'doc',
      triggerPos: 6,
    });
  });

  it('reports triggerPos at the SLASH, not at the first typed character', () => {
    // Off-by-one here silently deletes a character of surrounding text on
    // accept, so the position is asserted rather than derived.
    const trigger = detectPopoverTrigger('/doctor', 7);
    expect(trigger?.triggerPos).toBe(0);
    expect('/doctor'.slice(0, trigger?.triggerPos ?? -1)).toBe('');
  });

  it('opens on a bare slash with an empty filter', () => {
    expect(detectPopoverTrigger('/', 1)).toEqual({ mode: 'skill', filter: '', triggerPos: 0 });
  });

  it('does NOT open mid-word, so a path does not open a command popup', () => {
    // `src/index.ts` contains a slash after a non-space character.
    expect(detectPopoverTrigger('src/index.ts', 12)).toBeNull();
  });

  it('does NOT open for a URL', () => {
    expect(detectPopoverTrigger('http://example.com/x', 20)).toBeNull();
  });

  it('opens the context popup for @', () => {
    expect(detectPopoverTrigger('@rea', 4)).toEqual({ mode: 'context', filter: 'rea', triggerPos: 0 });
  });

  it('lets @ win when both triggers would match', () => {
    // `foo/@ba` satisfies the @ pattern and also the after-whitespace / pattern.
    // The narrower reading is the context popup.
    expect(detectPopoverTrigger('foo/@ba', 7)?.mode).toBe('context');
  });

  it('narrows the filter as the caret moves back into the trigger span', () => {
    // Not a close: moving the caret LEFT stays inside the span, so the popup
    // stays open with a shorter filter. Asserted because the opposite was my
    // first guess and the guard only proves anything if it is right.
    expect(detectPopoverTrigger('/doc', 3)).toEqual({ mode: 'skill', filter: 'do', triggerPos: 0 });
    expect(detectPopoverTrigger('/doc', 2)).toEqual({ mode: 'skill', filter: 'd', triggerPos: 0 });
  });

  it('closes when the caret moves before the trigger', () => {
    expect(detectPopoverTrigger('/doc', 0)).toBeNull();
  });

  it('ignores text after the caret', () => {
    // Same string, two carets, two answers — proof the anchor is `beforeCursor`.
    expect(detectPopoverTrigger('/doc trailing', 4)?.filter).toBe('doc');
    expect(detectPopoverTrigger('/doc trailing', 13)).toBeNull();
  });
});

describe('filterItems', () => {
  const ITEMS = [
    item('doctor', '/doctor', 'Diagnose project issues'),
    item('review', '/review', 'Review a diff'),
    item('compact', '/compact', '压缩对话上下文'),
  ];

  it('matches on label', () => {
    expect(filterItems(ITEMS, 'doc').map((i) => i.value)).toEqual(['/doctor']);
  });

  it('matches on description as well as label', () => {
    expect(filterItems(ITEMS, 'diff').map((i) => i.value)).toEqual(['/review']);
  });

  it('is case-insensitive', () => {
    expect(filterItems(ITEMS, 'DOC').map((i) => i.value)).toEqual(['/doctor']);
  });

  it('matches Chinese text', () => {
    expect(filterItems(ITEMS, '压缩').map((i) => i.value)).toEqual(['/compact']);
  });

  it('is a substring match, not a prefix match — middle hits count', () => {
    expect(filterItems(ITEMS, 'oct').map((i) => i.value)).toEqual(['/doctor']);
  });

  it('returns everything for an empty filter', () => {
    expect(filterItems(ITEMS, '')).toHaveLength(3);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterItems(ITEMS, 'zzzz')).toEqual([]);
  });
});

describe('resolveItemSelection', () => {
  const doctor = item('审查', '/doctor', 'Review code');

  it('replaces only the active fragment, mid-sentence', () => {
    // The desktop's own assertion (`message-input-logic.spec.ts:22-25`).
    const result = resolveItemSelection(doctor, 'skill', 6, 'hello /do world', 'do');
    expect(result.newInputValue).toBe('hello /doctor world');
  });

  it('adds a trailing space when nothing follows', () => {
    expect(resolveItemSelection(doctor, 'skill', 0, '/do', 'do').newInputValue).toBe('/doctor ');
  });

  it('does not double the space when whitespace already follows', () => {
    expect(resolveItemSelection(doctor, 'skill', 0, '/do world', 'do').newInputValue).toBe('/doctor world');
  });

  it('reports the command value for a slash acceptance', () => {
    expect(resolveItemSelection(doctor, 'skill', 0, '/do', 'do').action).toBe('insert_slash_command');
    expect(resolveItemSelection(doctor, 'skill', 0, '/do', 'do').commandValue).toBe('/doctor');
  });

  it('prefixes an @ acceptance with @ and a space', () => {
    expect(resolveItemSelection(doctor, 'context', 0, '@re', 're').newInputValue).toBe('@/doctor ');
  });
});

describe('cycleIndex', () => {
  it('advances and wraps at the end', () => {
    expect(cycleIndex(0, 'down', 3)).toBe(1);
    expect(cycleIndex(2, 'down', 3)).toBe(0);
  });

  it('retreats and wraps at the start', () => {
    expect(cycleIndex(1, 'up', 3)).toBe(0);
    expect(cycleIndex(0, 'up', 3)).toBe(2);
  });

  it('returns 0 rather than NaN for an empty list', () => {
    // Callers compute a selection index before they know the list is non-empty.
    expect(cycleIndex(0, 'down', 0)).toBe(0);
    expect(cycleIndex(0, 'up', 0)).toBe(0);
  });
});