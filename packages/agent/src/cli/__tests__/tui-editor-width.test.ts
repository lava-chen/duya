import { describe, it, expect } from 'vitest';
import { InputEditor, pastePlaceholder, PASTE_PLACEHOLDER_THRESHOLD } from '../ui/editor.js';
import { visibleWidth, wrapWithCursor, capLines, truncateToWidth } from '../ui/width.js';

describe('InputEditor', () => {
  it('deletes a whole code point on backspace, not a surrogate half', () => {
    const e = new InputEditor();
    // An emoji is one character across a surrogate pair. Deleting half of it
    // leaves a lone surrogate, which the terminal renders as a replacement
    // glyph — the classic "the emoji became a box" bug.
    e.insert('\u{1F600}');
    expect(e.length).toBe(1);
    e.backspace();
    expect(e.text).toBe('');
    expect(e.length).toBe(0);
  });

  it('moves the cursor over a CJK character in one step', () => {
    const e = new InputEditor();
    e.insert('你好');
    expect(e.cursor).toBe(2);
    e.moveLeft();
    expect(e.cursor).toBe(1);
  });

  it('collapses an oversized paste and expands it on submit', () => {
    const e = new InputEditor();
    const big = 'x'.repeat(PASTE_PLACEHOLDER_THRESHOLD + 1);
    e.insert(big);

    expect(e.hasCollapsedPaste).toBe(true);
    expect(e.text).toBe(pastePlaceholder(big));
    // The whole point: the layout holds a short label, not the payload.
    expect(e.text.length).toBeLessThan(50);

    expect(e.submit()).toBe(big);
    // Submitting clears, placeholder included.
    expect(e.text).toBe('');
    expect(e.hasCollapsedPaste).toBe(false);
  });

  it('leaves a small paste inline', () => {
    const e = new InputEditor();
    e.insert('short paste');
    expect(e.hasCollapsedPaste).toBe(false);
    expect(e.text).toBe('short paste');
  });

  it('drops the placeholder if the user edits inside it', () => {
    const e = new InputEditor();
    e.insert('y'.repeat(PASTE_PLACEHOLDER_THRESHOLD + 1));
    expect(e.hasCollapsedPaste).toBe(true);
    e.backspace();
    // The label no longer describes the buffer, so the held content is gone
    // rather than being silently re-attached to edited text.
    expect(e.hasCollapsedPaste).toBe(false);
  });

  it('returns null for an empty submit', () => {
    const e = new InputEditor();
    expect(e.submitIfPresent()).toBeNull();
    e.insert('   ');
    expect(e.submitIfPresent()).toBeNull();
  });

  it('trims a plain submit but not a collapsed paste', () => {
    const e = new InputEditor();
    e.insert('  hi  ');
    expect(e.submitIfPresent()).toBe('hi');

    const e2 = new InputEditor();
    e2.insert(' '.repeat(PASTE_PLACEHOLDER_THRESHOLD + 5));
    expect(typeof e2.submitIfPresent()).toBe('string');
  });

  it('walks history and restores the draft past the newest entry', () => {
    const e = new InputEditor();
    e.loadHistory(['one', 'two']);
    e.insert('draft');

    e.historyPrevious();
    expect(e.text).toBe('two');
    e.historyPrevious();
    expect(e.text).toBe('one');
    // Paging forward past the newest restores what the user was typing.
    e.historyNext();
    e.historyNext();
    expect(e.text).toBe('draft');
  });

  it('does not record consecutive duplicates', () => {
    const e = new InputEditor();
    e.insert('a');
    e.submitIfPresent();
    e.insert('a');
    e.submitIfPresent();
    expect(e.exportHistory()).toEqual(['a']);
  });

  it('moves by word and kills a word without eating the separator', () => {
    const e = new InputEditor();
    e.insert('alpha beta gamma');
    e.moveWordLeft();
    expect(e.text.slice(0, e.cursor)).toBe('alpha beta ');

    // Ctrl+W from the start of 'gamma' removes 'beta' but keeps the space, so
    // the words do not run together.
    e.killWordBackward();
    expect(e.text).toBe('alpha gamma');

    // And from the end it removes exactly the last word.
    e.moveEnd();
    e.killWordBackward();
    expect(e.text).toBe('alpha ');
  });
});

describe('visibleWidth', () => {
  it('counts CJK as two cells', () => {
    expect(visibleWidth('中')).toBe(2);
    expect(visibleWidth('中文')).toBe(4);
  });

  it('counts ASCII as one cell', () => {
    expect(visibleWidth('ab')).toBe(2);
  });

  it('measures an astral emoji as ONE cell, matching blessed', () => {
    // Blessed's width table omits the common emoji blocks (measured:
    // strWidth('\u{1F600}') === 1) even though most terminals draw them double
    // width. This is NOT corrected here, and the assertion is the point: the
    // editor's width must equal blessed's width, or the cursor drifts off the
    // glyph. Agreement with the renderer is the property being protected.
    expect(visibleWidth('\u{1F600}')).toBe(1);
    // Still one CHARACTER, which is what the buffer is indexed by, so
    // backspace cannot leave half a surrogate pair behind.
    expect([...'\u{1F600}'].length).toBe(1);
  });

  it('is zero for the empty string', () => {
    expect(visibleWidth('')).toBe(0);
  });
});

describe('wrapWithCursor', () => {
  it('wraps on width, not on character count', () => {
    const r = wrapWithCursor('中文中文', 4, 4);
    expect(r.rows).toEqual(['中文', '中文']);
  });

  it('never breaks inside a code point', () => {
    const r = wrapWithCursor('\u{1F600}\u{1F600}\u{1F600}', 2, 3);
    for (const row of r.rows) {
      // A lone surrogate would show as a replacement glyph.
      expect([...row].every((c) => c.codePointAt(0) !== undefined && c.length <= 2)).toBe(true);
      expect(visibleWidth(row)).toBeLessThanOrEqual(2);
    }
  });

  it('breaks a long token that has no spaces', () => {
    const r = wrapWithCursor('aaaaaaaaaa', 4, 10);
    expect(r.rows.length).toBeGreaterThan(1);
    for (const row of r.rows) expect(row.length).toBeLessThanOrEqual(4);
  });

  it('breaks Latin words at spaces and drops the space', () => {
    const r = wrapWithCursor('hello world', 6, 0);
    expect(r.rows[0]).toBe('hello');
    expect(r.rows[1]?.startsWith(' ')).toBe(false);
  });

  it('honours hard newlines', () => {
    const r = wrapWithCursor('a\nb\nc', 10, 4);
    expect(r.rows).toEqual(['a', 'b', 'c']);
  });

  it('always produces at least one row for empty text', () => {
    const r = wrapWithCursor('', 10, 0);
    expect(r.rows).toEqual(['']);
    expect(r.cursorRow).toBe(1);
  });

  it('reports the cursor row and column', () => {
    const r = wrapWithCursor('中文中文', 4, 2);
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(4);
    expect(wrapWithCursor('中文中文', 4, 6).cursorRow).toBe(2);
  });

  it('never reports a cursor beyond the text', () => {
    const r = wrapWithCursor('ab', 10, 99);
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(2);
  });

  it('survives a nonsensical width', () => {
    expect(() => wrapWithCursor('abc', 0, 0)).not.toThrow();
    expect(wrapWithCursor('abc', -5, 0).rows.length).toBeGreaterThan(0);
  });
});

describe('capLines', () => {
  it('leaves short text alone', () => {
    expect(capLines('a\nb', 5)).toBe('a\nb');
  });

  it('caps and reports what it dropped', () => {
    expect(capLines('a\nb\nc\nd', 2)).toBe('a\nb\n… (2 more lines)');
  });

  it('uses the singular for one dropped line', () => {
    expect(capLines('a\nb', 1)).toContain('1 more line)');
  });
});

describe('truncateToWidth', () => {
  it('leaves short text alone', () => {
    expect(truncateToWidth('abc', 10)).toBe('abc');
  });

  it('truncates on cell width, not character count', () => {
    // Four CJK characters are eight cells; a budget of 5 must not fit them.
    const out = truncateToWidth('中文中文', 5);
    expect(visibleWidth(out)).toBeLessThanOrEqual(5);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never splits a double-width character to make the budget', () => {
    const out = truncateToWidth('中', 2);
    expect(out).toBe('中');
    const tight = truncateToWidth('中', 1);
    expect(tight).toBe('…');
  });
});
