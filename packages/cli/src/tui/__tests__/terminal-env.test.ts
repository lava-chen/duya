/**
 * Terminal capability detection.
 *
 * These are table-driven on purpose. Detection is a pile of "if this variable
 * is set, then that terminal can do X" rules, and the rules are exactly where
 * a terminal nobody tried breaks: `TERM=dumb`, Windows without `WT_SESSION`,
 * a UTF-8 locale under a terminal that still mangles box characters. Each row
 * is one real terminal shape, so a new one is a new row rather than a new
 * machine.
 *
 * ## Why every row names a platform
 *
 * `detectTerminalEnvironment` takes the platform as an explicit input because
 * one rule cannot be reached from an environment bag. The POSIX rows below all
 * pass `'linux'`: without it they would take their answer from whichever
 * machine happened to run the suite, and the Windows fix would have silently
 * rewritten what these rows assert. A detection test whose expected value
 * depends on the host is a detection bug waiting for a different CI image.
 */

import { describe, expect, it } from 'vitest';

import { detectTerminalEnvironment } from '../terminal-env.js';

/** A POSIX host, which is what the pre-Windows rows are describing. */
const POSIX = 'linux' as const;

describe('detectTerminalEnvironment', () => {
  it('reads a full-colour Windows Terminal as truecolor', () => {
    const env = detectTerminalEnvironment({ WT_SESSION: 'abc-123' }, 'win32');
    expect(env.program).toBe('windows-terminal');
    // Windows Terminal does not always export COLORTERM, but it is 24-bit.
    expect(env.colorDepth).toBe('truecolor');
    expect(env.unicodeBox).toBe(true);
    expect(env.supportsLightPalette).toBe(true);
  });

  it('names the common emulators from TERM_PROGRAM', () => {
    const cases = [
      ['vscode', 'vscode'],
      ['iTerm.app', 'iterm2'],
      ['WezTerm', 'wezterm'],
      ['Apple_Terminal', 'apple-terminal'],
      ['Alacritty', 'alacritty'],
    ] as const;
    for (const [termProgram, expected] of cases) {
      expect(detectTerminalEnvironment({ TERM_PROGRAM: termProgram }, POSIX).program).toBe(expected);
    }
  });

  it('names kitty from TERM, which is the only hint it gives', () => {
    const env = detectTerminalEnvironment({ TERM: 'xterm-kitty' }, POSIX);
    expect(env.program).toBe('kitty');
    expect(env.kittyGraphics).toBe(true);
  });

  it('trusts COLORTERM over TERM for the 24-bit claim', () => {
    // TERM alone would say 16; COLORTERM is the more specific promise.
    expect(detectTerminalEnvironment({ TERM: 'xterm', COLORTERM: 'truecolor' }, POSIX).colorDepth)
      .toBe('truecolor');
    expect(detectTerminalEnvironment({ TERM: 'xterm', COLORTERM: '24bit' }, POSIX).colorDepth)
      .toBe('truecolor');
  });

  it('reads a 256-colour TERM as 256', () => {
    const env = detectTerminalEnvironment({ TERM: 'xterm-256color' }, POSIX);
    expect(env.colorDepth).toBe(256);
    expect(env.supportsLightPalette).toBe(true);
  });

  it('refuses to invent capabilities when TERM is unset', () => {
    // The old code answered this with 'xterm-256color', which told blessed the
    // terminal had 256 colours when it may have eight.
    const env = detectTerminalEnvironment({}, POSIX);
    expect(env.term).toBe('dumb');
    expect(env.colorDepth).toBe(16);
    expect(env.unicodeBox).toBe(false);
    expect(env.hyperlinks).toBe(false);
  });

  it('treats TERM=dumb as the degraded terminal it is', () => {
    const env = detectTerminalEnvironment({ TERM: 'dumb', COLORTERM: 'truecolor' }, POSIX);
    expect(env.term).toBe('dumb');
    expect(env.unicodeBox).toBe(false);
    expect(env.hyperlinks).toBe(false);
    expect(env.kittyGraphics).toBe(false);
  });

  it('refuses box drawing under the Linux virtual console even with a UTF-8 locale', () => {
    // The VC advertises a normal TERM and mangles box characters anyway,
    // depending on the console font. LANG is not evidence about that.
    expect(detectTerminalEnvironment({ TERM: 'linux', LANG: 'en_US.UTF-8' }, POSIX).unicodeBox)
      .toBe(false);
  });

  it('allows box drawing for an unrecognised terminal only with a UTF-8 locale', () => {
    expect(detectTerminalEnvironment({ TERM: 'xterm', LANG: 'en_US.UTF-8' }, POSIX).unicodeBox)
      .toBe(true);
    expect(detectTerminalEnvironment({ TERM: 'xterm', LANG: 'C' }, POSIX).unicodeBox).toBe(false);
  });

  it('does not hand OSC 8 hyperlinks to a terminal it could not identify', () => {
    // A literal `]8;;url` showing in the transcript is worse than a plain URL.
    expect(detectTerminalEnvironment({ TERM: 'xterm-256color' }, POSIX).hyperlinks).toBe(false);
    expect(detectTerminalEnvironment({ TERM_PROGRAM: 'vscode' }, POSIX).hyperlinks).toBe(true);
  });

  it('reports the image protocol only where it exists', () => {
    expect(detectTerminalEnvironment({ TERM: 'xterm-kitty' }, POSIX).kittyGraphics).toBe(true);
    expect(detectTerminalEnvironment({ TERM_PROGRAM: 'iTerm.app' }, POSIX).kittyGraphics).toBe(true);
    expect(detectTerminalEnvironment({ TERM_PROGRAM: 'Apple_Terminal' }, POSIX).kittyGraphics)
      .toBe(false);
  });

  it('says the light palette is unusable below 256 colours', () => {
    // theme.ts writes the light palette as 256-colour numbers, so on a
    // 16-colour terminal every tag quantises to something arbitrary.
    expect(detectTerminalEnvironment({ TERM: 'xterm' }, POSIX).supportsLightPalette).toBe(false);
    expect(detectTerminalEnvironment({ TERM: 'xterm-256color' }, POSIX).supportsLightPalette)
      .toBe(true);
    expect(detectTerminalEnvironment({ WT_SESSION: 'x' }, POSIX).supportsLightPalette).toBe(true);
  });

  it('recognises tmux, whose abilities come from the outer terminal', () => {
    const env = detectTerminalEnvironment(
      { TERM: 'screen-256color', TMUX: '/tmp/tmux-0/default,1,0' },
      POSIX,
    );
    expect(env.program).toBe('tmux');
    expect(env.colorDepth).toBe(256);
    // Not a named emulator, so box drawing needs the locale to vouch for it.
    expect(env.unicodeBox).toBe(false);
    expect(detectTerminalEnvironment(
      { TERM: 'screen-256color', LANG: 'en_US.UTF-8' },
      POSIX,
    ).unicodeBox).toBe(true);
  });
});

/**
 * The rows that keep CJK out of `?`.
 *
 * Without these, a stock Windows PowerShell renders every Chinese character in
 * the transcript and in the composer as a literal `?`, because it sets none of
 * `LC_ALL` / `LC_CTYPE` / `LANG` and the POSIX locale probe read that absence
 * as "cannot do UTF-8".
 */
describe('detectTerminalEnvironment on Windows', () => {
  it('treats a console with no locale variables as UTF-8 capable', () => {
    // No WT_SESSION, no TERM_PROGRAM, no LANG -- exactly what
    // `node packages/cli/bundle/cli.cjs tui` inherits from Windows PowerShell.
    const env = detectTerminalEnvironment({}, 'win32');
    expect(env.program).toBe('unknown');
    expect(env.unicodeBox).toBe(true);
  });

  it('still refuses a Windows console that declares TERM=dumb or TERM=linux', () => {
    // A degraded terminal says so explicitly, and that statement outranks the
    // platform default.
    expect(detectTerminalEnvironment({ TERM: 'dumb' }, 'win32').unicodeBox).toBe(false);
    expect(detectTerminalEnvironment({ TERM: 'linux' }, 'win32').unicodeBox).toBe(false);
  });

  it('honours DUYA_TUI_ASCII as the way back to the ASCII-only path', () => {
    // The fix is a default, not a removal of the capability: someone whose
    // console genuinely cannot draw the glyphs still has a way to say so.
    expect(detectTerminalEnvironment({}, 'win32').unicodeBox).toBe(true);
    expect(detectTerminalEnvironment({ DUYA_TUI_ASCII: '1' }, 'win32').unicodeBox).toBe(false);
    // And it outranks a terminal we would otherwise trust by name.
    expect(detectTerminalEnvironment({ WT_SESSION: 'x', DUYA_TUI_ASCII: '1' }, 'win32').unicodeBox)
      .toBe(false);
  });
});
