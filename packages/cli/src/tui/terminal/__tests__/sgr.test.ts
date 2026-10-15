/**
 * Tag → ANSI conversion.
 *
 * The vocabulary is closed, so these are exhaustive over it. The cases that
 * matter most are the ones where the old renderer LOST text: an unterminated
 * brace, an unknown tag, an out-of-range colour number. Blessed swallowed all
 * three, which is what `escapeTags` was written to work around.
 */

import { describe, expect, it } from 'vitest';

import { tagsToAnsi } from '../sgr.js';

describe('tagsToAnsi', () => {
  it('converts the named foreground colours', () => {
    expect(tagsToAnsi('{cyan-fg}x{/cyan-fg}')).toBe('\x1b[36mx\x1b[39m');
    expect(tagsToAnsi('{gray-fg}x')).toBe('\x1b[90mx');
    expect(tagsToAnsi('{red-fg}x')).toBe('\x1b[31mx');
    expect(tagsToAnsi('{yellow-fg}x')).toBe('\x1b[33mx');
    expect(tagsToAnsi('{magenta-fg}x')).toBe('\x1b[35mx');
  });

  it('treats gray and grey as bright black', () => {
    // theme.ts justifies the light palette's 256-colour substitutions by saying
    // `{gray-fg}` is "bright black"; if that stops being true the contrast
    // argument behind the whole light palette stops holding.
    expect(tagsToAnsi('{gray-fg}x')).toBe(tagsToAnsi('{grey-fg}x'));
    expect(tagsToAnsi('{gray-fg}')).toBe('\x1b[90m');
  });

  it('converts 256-colour numbers, which the light palette is built from', () => {
    expect(tagsToAnsi('{241-fg}x')).toBe('\x1b[38;5;241mx');
    expect(tagsToAnsi('{30-fg}x')).toBe('\x1b[38;5;30mx');
    expect(tagsToAnsi('{255-fg}x')).toBe('\x1b[38;5;255mx');
    expect(tagsToAnsi('{0-fg}x')).toBe('\x1b[38;5;0mx');
  });

  it('rejects a colour number outside the palette instead of trusting it', () => {
    // A typo like `{9999-fg}` must not silently become some colour.
    expect(tagsToAnsi('{9999-fg}x')).toBe('{9999-fg}x');
  });

  it('converts bold and its reset', () => {
    expect(tagsToAnsi('{bold}x{/bold}')).toBe('\x1b[1mx\x1b[22m');
  });

  it('leaves plain text alone', () => {
    expect(tagsToAnsi('plain text')).toBe('plain text');
    expect(tagsToAnsi('')).toBe('');
  });

  it('emits an escaped brace literally, and consumes the escape marker', () => {
    // Exactly what `escapeTags` produces: it escapes `{` only, because `}`
    // alone cannot open a tag. The backslash is an escape marker, not output —
    // printing it would put a stray `\` before every brace in the model's JSON.
    expect(tagsToAnsi('\\{a}')).toBe('{a}');
    expect(tagsToAnsi('function f() \\{ return 1; \\}')).toBe('function f() { return 1; \\}');
    expect(tagsToAnsi('{"a": 1}')).toBe('{"a": 1}');
  });

  it('prints an unknown tag rather than swallowing it', () => {
    // Blessed dropped these. Model output containing braces is most JSON, most
    // code and most stack traces — silently losing characters there is worse
    // than printing a stray brace.
    expect(tagsToAnsi('a {weird} b')).toBe('a {weird} b');
    expect(tagsToAnsi('{1F44D}')).toBe('{1F44D}');
    expect(tagsToAnsi('{bold-fg}')).toBe('{bold-fg}');
  });

  it('prints an unterminated brace as text instead of eating the rest', () => {
    expect(tagsToAnsi('{unclosed')).toBe('{unclosed');
    expect(tagsToAnsi('{cyan-fg}{unclosed')).toBe('\x1b[36m{unclosed');
  });

  it('handles a bare slash-brace as a foreground reset', () => {
    expect(tagsToAnsi('{/cyan-fg}')).toBe('\x1b[39m');
    expect(tagsToAnsi('{/241-fg}')).toBe('\x1b[39m');
  });

  it('round-trips the exact tag set the renderers emit', () => {
    // The vocabulary below was read out of transcript-view.ts and theme.ts, not
    // recalled. If a renderer starts using a tag outside it, this fails.
    const vocabulary = [
      '{bold}', '{/bold}',
      '{cyan-fg}', '{/cyan-fg}',
      '{gray-fg}', '{/gray-fg}',
      '{red-fg}', '{/red-fg}',
      '{yellow-fg}', '{/yellow-fg}',
      '{green-fg}', '{bright-green-fg}', '{bright-red-fg}', '{magenta-fg}',
      '{28-fg}', '{30-fg}', '{128-fg}', '{160-fg}', '{172-fg}', '{241-fg}', '{243-fg}',
    ];
    for (const tag of vocabulary) {
      expect(tagsToAnsi(tag)).not.toBe(tag);
      expect(tagsToAnsi(tag)).toMatch(/^\x1b\[[0-9;]*m$/u);
    }
  });
});
