/**
 * The fold, and what it must not break.
 *
 * ## The defect these pin down
 *
 * A transcript line wider than the pane is not a long line, it is a LOST
 * one: the inline writer disables wrap around a frame, so the terminal cuts
 * the overflow — and on Windows ConPTY a line that reaches the last column
 * wraps anyway, which lands the frame one row lower than intended and cuts
 * the row under the status bar.
 *
 * So every rendered row has to fit the pane. Fitting it is the easy half:
 * the fold has to happen on the RENDERED text, because folding the raw
 * source breaks Markdown at the break and leaves the markers on screen.
 *
 * minimax-code does it in the same order (`marked` → styled text →
 * `wrapTextWithAnsi`); these tests hold duya to it.
 */

import { describe, expect, it } from 'vitest';
import { renderOneBlock } from '../transcript-view.js';
import { wrapSpans } from '../markdown/wrap.js';
import { visibleWidth } from '../width.js';

/** Blessed tags removed, so an assertion can read what a reader sees. */
function strip(text: string): string {
  return text.replace(/\{[^}]*\}/gu, '');
}

function render(text: string, width: number): string[] {
  return strip(renderOneBlock(
    { kind: 'assistant', id: 'a', finalized: true, text },
    { expanded: false, showToolResults: true, toolResultLines: 5, width },
  )).split('\n');
}

describe('folding a rendered line', () => {
  it('folds a paragraph to the pane width', () => {
    const rows = render('word '.repeat(80), 60);
    for (const row of rows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(60);
    }
    expect(rows.length).toBeGreaterThan(1);
  });

  it('keeps every word: a folded paragraph loses nothing', () => {
    const words = Array.from({ length: 40 }, (_, index) => `w${index}`).join(' ');
    const rows = render(words, 60);
    // The first row carries the assistant anchor; the words are what matter.
    const text = rows.join(' ').replace(/^●\s*/u, '');
    expect(text.split(/\s+/u).filter(Boolean)).toEqual(
      words.split(/\s+/u).filter(Boolean),
    );
  });

  it('does not leave a half-open Markdown link behind', () => {
    // The link is longer than the pane, so the fold lands inside it.
    const rows = render(`see [the docs](https://example.com/${'a'.repeat(120)}) now`, 60);
    const text = rows.join('\n');
    // The raw opener is gone: the link was parsed, so the fold cut the
    // RENDERED target, not the Markdown around it.
    expect(text).not.toContain('](');
    expect(text).toContain('the docs');
    // Nothing was lost: every character of the target is still there.
    expect(text.replace(/\s+/gu, '')).toContain(`https://example.com/${'a'.repeat(120)}`);
  });

  it('does not leave a half-open bold span behind', () => {
    const rows = render(`**${'bold words '.repeat(12)}**`, 60);
    expect(rows.join('\n')).not.toContain('**');
  });

  it('folds a list item to the pane width too', () => {
    const rows = render(`- ${'item words '.repeat(20)}`, 60);
    for (const row of rows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(60);
    }
    expect(rows[0]).toContain('•');
  });
});

describe('a table stays a table', () => {
  const wide = [
    '| 角色 | 干什么 | 关键文件 |',
    '|------|------|------|',
    '| Worker 端（跑在每个会话的子进程里） | 真正的 agent：会话类、单轮驱动器 | worker-session-runtime.ts（E:/Projects/duya/packages/host/src/worker-session-runtime.ts） |',
  ].join('\n');

  it('keeps the ruled grid instead of collapsing to label: value', () => {
    const rows = render(wide, 120);
    expect(rows.some((row) => row.includes('│'))).toBe(true);
    expect(rows.some((row) => row.includes('┼'))).toBe(true);
    // The old fallback printed `角色: Worker 端…`; the shape that is not a
    // table any more.
    expect(rows.join('\n')).not.toMatch(/角色\s*:/u);
  });

  it('fits every row inside the pane', () => {
    for (const row of render(wide, 120)) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(120);
    }
  });

  it('puts the columns on one baseline', () => {
    const rows = render(wide, 120).filter((row) => row.includes('│'));
    // The DISPLAY column of the first bar, not the string index: a CJK cell
    // is one character and two cells, so the index drifts with the content.
    const columns = rows.map((row) => visibleWidth(row.slice(0, row.indexOf('│'))));
    expect(new Set(columns).size).toBe(1);
  });
});

describe('reasoning is rendered as Markdown too', () => {
  it('draws a list as a list, not as raw source', () => {
    const rows = strip(renderOneBlock(
      { kind: 'thinking', id: 't', finalized: true, text: '- packages/host/src/worker-manager.ts' },
      { expanded: false, showToolResults: true, toolResultLines: 5, width: 80 },
    )).split('\n');
    expect(rows.join('\n')).toContain('• packages/host/src/worker-manager.ts');
    expect(rows.join('\n')).not.toContain('- packages/host');
  });

  it('folds a long reasoning line to the pane width', () => {
    const rows = strip(renderOneBlock(
      { kind: 'thinking', id: 't', finalized: true, text: `reasoning ${'word '.repeat(60)}` },
      { expanded: false, showToolResults: true, toolResultLines: 5, width: 60 },
    )).split('\n');
    for (const row of rows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(60);
    }
  });
});

describe('wrapSpans', () => {
  it('breaks at a space and drops it', () => {
    const rows = wrapSpans([{ text: 'alpha beta gamma' }], 12);
    expect(rows.map((row) => row.map((span) => span.text).join(''))).toEqual([
      'alpha beta',
      'gamma',
    ]);
  });

  it('breaks a token that is wider than the limit', () => {
    const rows = wrapSpans([{ text: 'abcdefghij' }], 4);
    expect(rows.map((row) => row.map((span) => span.text).join(''))).toEqual([
      'abcd', 'efgh', 'ij',
    ]);
  });

  it('never splits a double-width character', () => {
    const rows = wrapSpans([{ text: '中文中文' }], 4);
    for (const row of rows) {
      expect(visibleWidth(row.map((span) => span.text).join(''))).toBeLessThanOrEqual(4);
    }
  });

  it('keeps the style on both halves of a split', () => {
    const rows = wrapSpans([{ text: 'abcdefgh', fg: { kind: 'named', name: 'cyan' } }], 4);
    for (const row of rows) {
      for (const span of row) {
        expect(span.fg).toEqual({ kind: 'named', name: 'cyan' });
      }
    }
  });
});
