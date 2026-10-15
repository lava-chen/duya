/**
 * Viewport geometry and commit planning.
 *
 * These are pure functions, so the claims under test are the CLAIMS: that the
 * conversation region starts at row 1 (which is what turns a scroll into a
 * commit), that the chrome is carved off the bottom, and that the committed
 * output can never reach a row above the region.
 *
 * What this file cannot test is whether a real terminal interprets the emitted
 * sequences as intended. That is stated in the module doc and repeated at the
 * bottom of these tests, because it is the one thing a reader must not mistake
 * for verified.
 */

import { describe, expect, it } from 'vitest';

import {
  conversationRegionBottom,
  detectScrollbackStrategy,
  liveWindow,
  planCommit,
} from '../viewport.js';

const SIZE = { rows: 24, columns: 80 } as const;

describe('conversationRegionBottom', () => {
  it('carves the chrome off the bottom and leaves the region starting at row 1', () => {
    expect(conversationRegionBottom(SIZE, 4)).toBe(20);
  });

  it('keeps at least one row even if the chrome claims the whole screen', () => {
    // A zero-height region would make every scroll a no-op and the live area
    // would never move; one row is the floor that still works.
    expect(conversationRegionBottom(SIZE, 99)).toBe(1);
    expect(conversationRegionBottom(SIZE, 0)).toBe(24);
  });
});

describe('liveWindow', () => {
  it('shows the whole document while it fits', () => {
    expect(liveWindow(5, 0, 20)).toEqual({ liveStart: 0, overflow: 0 });
  });

  it('reports the rows that must be committed once the document outgrows the region', () => {
    // 30 rows of document, 20 rows of region: 10 have to be printed before the
    // next frame can be correct.
    expect(liveWindow(30, 0, 20)).toEqual({ liveStart: 10, overflow: 10 });
  });

  it('does not re-commit rows already committed', () => {
    // Committed 10 already, document now 30: still 10 more to go.
    expect(liveWindow(30, 10, 20)).toEqual({ liveStart: 10, overflow: 0 });
    // Document grew to 35: now 5 genuinely new rows.
    expect(liveWindow(35, 10, 20)).toEqual({ liveStart: 15, overflow: 5 });
  });

  it('never lets the live area start above what is already committed', () => {
    // A shrinking document — the user scrolled back — must commit nothing. The
    // rows at its head have already been printed, and a committed row can
    // never be un-committed, so re-committing them would duplicate history.
    expect(liveWindow(3, 10, 20)).toEqual({ liveStart: 0, overflow: 0 });
  });

  it('treats a zero-row region as one row rather than dividing by zero', () => {
    expect(liveWindow(10, 0, 0)).toEqual({ liveStart: 9, overflow: 9 });
  });
});

describe('detectScrollbackStrategy', () => {
  it('names the terminals that cannot use the plain scroll region', () => {
    expect(detectScrollbackStrategy({ WT_SESSION: 'abc' })).toBe('windows-terminal');
    expect(detectScrollbackStrategy({ ZELLIJ: '0' })).toBe('zellij');
  });

  it('defaults to the standard path, and ignores empty variables', () => {
    expect(detectScrollbackStrategy({})).toBe('standard');
    expect(detectScrollbackStrategy({ WT_SESSION: '', ZELLIJ: '' })).toBe('standard');
  });
});

describe('planCommit', () => {
  const base = { size: SIZE, chromeRows: 4, strategy: 'standard' } as const;

  it('writes nothing when nothing scrolled out', () => {
    const plan = planCommit([], base);
    expect(plan.output).toBe('');
    expect(plan.committed).toBe(0);
  });

  it('sets the region to start at row 1, which is what makes a scroll a commit', () => {
    // If the region's top were not 1, scrolling would DISCARD that row instead
    // of pushing it into scrollback — the conversation would lose rows with no
    // error anywhere.
    const plan = planCommit(['row one'], base);
    expect(plan.output).toContain('\x1b[1;20r');
    expect(plan.output).not.toContain('\x1b[2;20r');
  });

  it('releases the region again so the chrome does not scroll with it', () => {
    const plan = planCommit(['row one'], base);
    expect(plan.output).toContain('\x1b[r');
    expect(plan.output.endsWith('\x1b[r')).toBe(true);
  });

  it('writes one line and one newline per committed row', () => {
    const plan = planCommit(['a', 'b', 'c'], base);
    expect(plan.committed).toBe(3);
    // Three newlines means three scrolls, so three rows reach the scrollback.
    expect(plan.output.match(/\r\n/gu)).toHaveLength(3);
  });

  it('never addresses a row above the conversation region', () => {
    const plan = planCommit(['a', 'b'], base);
    for (const match of plan.output.matchAll(/\x1b\[(\d+);(\d+)H/gu)) {
      expect(Number.parseInt(match[1] ?? '0', 10)).toBeLessThanOrEqual(20);
    }
  });

  it('emits nothing that erases scrollback', () => {
    const plan = planCommit(['a', 'b', 'c'], base);
    expect(plan.output).not.toContain('\x1b[3J');
    expect(plan.output).not.toContain('\x1b[2J');
  });

  it('leaves the region alone under zellij, which manages regions itself', () => {
    const plan = planCommit(['a'], { ...base, strategy: 'zellij' });
    expect(plan.output).not.toContain('\x1b[1;20r');
    expect(plan.output).toBe('a\r\n');
  });

  it('commits exactly the rows it was given, in order', () => {
    const plan = planCommit(['first', 'second'], base);
    const written = [...plan.output.matchAll(/(first|second)/gu)].map((m) => m[1]);
    expect(written).toEqual(['first', 'second']);
  });
});

/*
 * NOT VERIFIED HERE: that a real terminal scrolls the conversation region the
 * way this module assumes, and that Windows Terminal degrades as documented.
 * Those need a terminal. Until someone runs `duya tui` and scrolls up, this is
 * a claim with unit-tested consequences, not an observed behaviour.
 */
