/**
 * Markup → ANSI, pinned against blessed's own bytes.
 *
 * Every expectation here was captured by rendering the same markup through
 * blessed 0.1.81 and reading what it wrote. They are transcribed, not derived —
 * a renderer that agrees with this file agrees with the one it replaces, which
 * is the only claim worth making about a second implementation of something
 * already shipping.
 */

import { describe, expect, it } from 'vitest';

import { escapeMarkup, renderMarkup } from '../screen/own/markup.js';

describe('renderMarkup against blessed ground truth', () => {
  const cases: readonly [string, string, string][] = [
    ['plain text', 'AB', 'AB'],
    ['gray', '{gray-fg}AB{/gray-fg}', '\x1b[90mAB\x1b[m'],
    ['cyan', '{cyan-fg}AB{/cyan-fg}', '\x1b[36mAB\x1b[m'],
    ['bold', '{bold}AB{/bold}', '\x1b[1mAB\x1b[m'],
    ['256-colour', '{241-fg}AB{/241-fg}', '\x1b[38;5;241mAB\x1b[m'],
    ['bright-green', '{bright-green-fg}AB{/bright-green-fg}', '\x1b[92mAB\x1b[m'],
    // Attributes before colours, from `{bold}{241-fg}x{/241-fg}y{/bold}`.
    ['attribute before colour', '{bold}{241-fg}x{/241-fg}y{/bold}', '\x1b[1;38;5;241mx\x1b[m\x1b[1my\x1b[m'],
    // Innermost colour replaces, from `{cyan-fg}{yellow-fg}x{/yellow-fg}y{/cyan-fg}`.
    ['colour replaces', '{cyan-fg}{yellow-fg}x{/yellow-fg}y{/cyan-fg}', '\x1b[33mx\x1b[m\x1b[36my\x1b[m'],
    // Re-entering the same style must not reset, from the `reopen` capture.
    ['no reset when the style is unchanged', '{cyan-fg}a{/cyan-fg}{cyan-fg}b{/cyan-fg}', '\x1b[36mab\x1b[m'],
  ];

  it.each(cases)('renders %s the way blessed does', (_name, markup, expected) => {
    expect(renderMarkup(markup)).toBe(expected);
  });

  it('passes an unknown tag through as literal text', () => {
    // Blessed does this, and dropping it instead would make a mistyped colour
    // invisible rather than obviously wrong.
    expect(renderMarkup('{nope-fg}x{/nope-fg}')).toBe('{nope-fg}x{/nope-fg}');
  });

  it('leaves an unclosed tag open to the end of the line', () => {
    // Lines are rendered independently, so a tag opened on one line cannot be
    // closed on the next. It still applies to the rest of this line.
    expect(renderMarkup('a{cyan-fg}b')).toBe('a\x1b[36mb\x1b[m');
  });

  it('restores the outer style when a nested tag closes', () => {
    expect(renderMarkup('{gray-fg}a{bold}b{/bold}c{/gray-fg}'))
      .toBe('\x1b[90ma\x1b[m\x1b[1;90mb\x1b[m\x1b[90mc\x1b[m');
  });

  it('ignores a close that has nothing open', () => {
    // Unwinding on an unmatched close would let a stray `{/bold}` in model
    // content strip every style from the line.
    expect(renderMarkup('{/bold}plain')).toBe('plain');
  });

  it('is a no-op on a line with no markup at all', () => {
    expect(renderMarkup('a plain line with (braces) and 100% of nothing'))
      .toBe('a plain line with (braces) and 100% of nothing');
  });

  it('keeps multibyte content intact', () => {
    // The CJK bug this renderer is being written next to is a reminder that a
    // renderer which touches text can lose it; this one must not.
    expect(renderMarkup('{cyan-fg}你好世界{/cyan-fg}')).toBe('\x1b[36m你好世界\x1b[m');
    expect(renderMarkup('中')).toBe('中');
  });
});

describe('escapeMarkup', () => {
  it('strips braces so model content cannot inject markup', () => {
    expect(escapeMarkup('a {cyan-fg}b{/cyan-fg} c')).toBe('a cyan-fgb/cyan-fg c');
  });

  it('leaves everything else alone', () => {
    expect(escapeMarkup('你好 world / path / 100%')).toBe('你好 world / path / 100%');
  });
});
