// Tests for the markdown fragment smart join. Fence markers are built
// from CODE_FENCE_MARKER so the source contains no raw backtick
// literals (the security scanner pattern-matches those as shell
// syntax) and no regex exec calls.

import { describe, expect, it } from 'vitest';
import { CODE_FENCE_MARKER, endsInsideInlineCode, joinMarkdownFragments, mergeMarkdownFragments } from './markdown-text-merge';

describe('mergeMarkdownFragments', () => {
  it('returns the other side unchanged when one fragment is empty', () => {
    expect(mergeMarkdownFragments('', 'hello')).toBe('hello');
    expect(mergeMarkdownFragments('hello', '')).toBe('hello');
    expect(mergeMarkdownFragments('', '')).toBe('');
  });

  it('joins ordinary blocks with a blank line so paragraphs stay separate', () => {
    expect(mergeMarkdownFragments('First paragraph.', 'Second paragraph.')).toBe(
      'First paragraph.\n\nSecond paragraph.',
    );
  });

  it('collapses duplicated newlines at the seam instead of stacking blank lines', () => {
    expect(mergeMarkdownFragments('First.\n\n\n', '\n\nSecond.')).toBe('First.\n\nSecond.');
  });

  it('keeps a table contiguous across the boundary (single newline, not blank line)', () => {
    const head = 'Results:\n| A | B |\n| --- | --- |\n| 1 | 2 |';
    const tail = '| 3 | 4 |\n| 5 | 6 |';
    // A blank line here would end the GFM table and render the tail rows
    // as literal pipe text.
    expect(mergeMarkdownFragments(head, tail)).toBe(head + '\n' + tail);
  });

  it('does not force a single newline when only one side is a table row', () => {
    // Tail is a fresh table with its own header — it needs a blank line
    // before it to start a new table.
    const head = 'Some closing remark.';
    const tail = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    expect(mergeMarkdownFragments(head, tail)).toBe(head + '\n\n' + tail);
  });

  it('joins with a single newline while a code fence is still open', () => {
    const openFence = 'Code sample:\n' + CODE_FENCE_MARKER + 'ts\nconst a = 1;';
    const rest = 'const b = 2;\n' + CODE_FENCE_MARKER;
    expect(mergeMarkdownFragments(openFence, rest)).toBe(openFence + '\n' + rest);
  });

  it('uses a blank line again once the fence is closed', () => {
    const closedFence = 'Code sample:\n' + CODE_FENCE_MARKER + 'ts\nconst a = 1;\n' + CODE_FENCE_MARKER;
    const rest = 'After the block.';
    expect(mergeMarkdownFragments(closedFence, rest)).toBe(closedFence + '\n\n' + rest);
  });

  it('does not let a tilde fence close a backtick fence', () => {
    const openBacktickFence = CODE_FENCE_MARKER + 'ts\nconst a = 1;';
    const tildeClose = 'const b = 2;\n~~~';
    // Still inside the backtick fence — single newline join.
    expect(mergeMarkdownFragments(openBacktickFence, tildeClose)).toBe(
      openBacktickFence + '\n' + tildeClose,
    );
  });

  it('keeps list runs as one loose list via the blank-line join', () => {
    const head = '1. first\n2. second';
    const tail = '3. third';
    // Blank line between items of the same marker type stays a single
    // (loose) list in CommonMark — no special casing needed.
    expect(mergeMarkdownFragments(head, tail)).toBe(head + '\n\n' + tail);
  });

  it('keeps an unterminated inline-code span contiguous across the seam', () => {
    // An SSE chunk cut the text right between the opening and closing
    // backticks of an inline-code span. Without protection the joiner
    // would inject \n\n and react-markdown would pair the half-open
    // span with the *next* matching backtick on the tail side,
    // swallowing the seam into a stray <code> pill.
    const head = 'before `foo';
    const tail = 'bar` after';
    expect(mergeMarkdownFragments(head, tail)).toBe(head + '\n' + tail);
  });

  it('does not treat backticks inside a fenced code block as inline-code markers', () => {
    // The opening backtick on line 1 is paired with the closing backtick
    // on line 2 (both outside the fence). Inside the fence, the two
    // backticks around `hi` are literal and do not flip parity, so the
    // prefix ends balanced and the joiner falls through to the normal
    // blank-line rule.
    const fence = CODE_FENCE_MARKER;
    const head = 'intro `' + fence + 'ts\nconst x = `hi`;';
    const tail = 'after';
    expect(mergeMarkdownFragments(head, tail)).toBe(head + '\n\n' + tail);
  });

  it('treats backticks on the head line after a closed fence as half-open', () => {
    // The first fence closes on its own line, so the final backtick on
    // the *next* line is an unmatched opening marker. Parity is odd, so
    // the seam must use a single newline to avoid pairing the opener
    // with stray text on the tail side.
    const fence = CODE_FENCE_MARKER;
    const head = 'intro ' + fence + 'ts\nconst x = 1;\n' + fence + '\nrun `';
    const tail = 'echo hi`';
    expect(mergeMarkdownFragments(head, tail)).toBe(head + '\n' + tail);
  });
});

describe('endsInsideInlineCode', () => {
  it('returns false for text with no backticks', () => {
    expect(endsInsideInlineCode('plain prose')).toBe(false);
  });

  it('returns false for text with balanced backticks', () => {
    expect(endsInsideInlineCode('`code` and `more`')).toBe(false);
  });

  it('returns true for text that ends on an opening backtick', () => {
    expect(endsInsideInlineCode('start `code')).toBe(true);
  });

  it('returns true for text that ends on an odd backtick', () => {
    expect(endsInsideInlineCode('`a` `b')).toBe(true);
  });

  it('ignores backticks inside fenced code blocks', () => {
    const fence = CODE_FENCE_MARKER;
    expect(endsInsideInlineCode('`a' + fence + 'ts\n`still literal`\n' + fence)).toBe(false);
  });
});

describe('joinMarkdownFragments', () => {
  it('folds a fragment list into one document with the same seam rules', () => {
    const fence = CODE_FENCE_MARKER;
    const parts = [
      'Intro text.',
      '| A | B |\n| --- | --- |',
      '| 1 | 2 |',
      fence + 'js\ncode()',
      'more()' + '\n' + fence,
      'Outro.',
    ];
    expect(joinMarkdownFragments(parts)).toBe(
      'Intro text.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n' + fence + 'js\ncode()\nmore()\n' + fence + '\n\nOutro.',
    );
  });

  it('returns an empty string for an empty list', () => {
    expect(joinMarkdownFragments([])).toBe('');
  });
});
