/**
 * Terminal capability detection.
 *
 * These are table-driven on purpose. Detection is a pile of "if this variable
 * is set, then that terminal can do X" rules, and the rules are exactly where
 * a terminal nobody tried breaks: `TERM=dumb`, Windows without `WT_SESSION`,
 * a UTF-8 locale under a terminal that still mangles box characters. Each row
 * is one real terminal shape, so a new one is a new row rather than a new
 * machine.
 */

import { describe, expect, it } from 'vitest';

import { detectTerminalEnvironment } from '../terminal-env.js';

describe('detectTerminalEnvironment', () => {
  it('reads a full-colour Windows Terminal as truecolor', () => {
    const env = detectTerminalEnvironment({ WT_SESSION: 'abc-123' });
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
      expect(detectTerminalEnvironment({ TERM_PROGRAM: termProgram }).program).toBe(expected);
    }
  });

  it('names kitty from TERM, which is the only hint it gives', () => {
    const env = detectTerminalEnvironment({ TERM: 'xterm-kitty' });
    expect(env.program).toBe('kitty');
    expect(env.kittyGraphics).toBe(true);
  });

  it('trusts COLORTERM over TERM for the 24-bit claim', () => {
    // TERM alone would say 16; COLORTERM is the more specific promise.
    expect(detectTerminalEnvironment({ TERM: 'xterm', COLORTERM: 'truecolor' }).colorDepth)
      .toBe('truecolor');
    expect(detectTerminalEnvironment({ TERM: 'xterm', COLORTERM: '24bit' }).colorDepth)
      .toBe('truecolor');
  });

  it('reads a 256-colour TERM as 256', () => {
    const env = detectTerminalEnvironment({ TERM: 'xterm-256color' });
    expect(env.colorDepth).toBe(256);
    expect(env.supportsLightPalette).toBe(true);
  });

  it('refuses to invent capabilities when TERM is unset', () => {
    // The old code answered this with 'xterm-256color', which told blessed the
    // terminal had 256 colours when it may have eight.
    const env = detectTerminalEnvironment({});
    expect(env.term).toBe('dumb');
    expect(env.colorDepth).toBe(16);
    expect(env.unicodeBox).toBe(false);
    expect(env.hyperlinks).toBe(false);
  });

  it('treats TERM=dumb as the degraded terminal it is', () => {
    const env = detectTerminalEnvironment({ TERM: 'dumb', COLORTERM: 'truecolor' });
    expect(env.term).toBe('dumb');
    expect(env.unicodeBox).toBe(false);
    expect(env.hyperlinks).toBe(false);
    expect(env.kittyGraphics).toBe(false);
  });

  it('refuses box drawing under the Linux virtual console even with a UTF-8 locale', () => {
    // The VC advertises a normal TERM and mangles box characters anyway,
    // depending on the console font. LANG is not evidence about that.
    expect(detectTerminalEnvironment({ TERM: 'linux', LANG: 'en_US.UTF-8' }).unicodeBox).toBe(false);
  });

  it('allows box drawing for an unrecognised terminal only with a UTF-8 locale', () => {
    expect(detectTerminalEnvironment({ TERM: 'xterm', LANG: 'en_US.UTF-8' }).unicodeBox).toBe(true);
    expect(detectTerminalEnvironment({ TERM: 'xterm', LANG: 'C' }).unicodeBox).toBe(false);
  });

  it('does not hand OSC 8 hyperlinks to a terminal it could not identify', () => {
    // A literal `]8;;url` showing in the transcript is worse than a plain URL.
    expect(detectTerminalEnvironment({ TERM: 'xterm-256color' }).hyperlinks).toBe(false);
    expect(detectTerminalEnvironment({ TERM_PROGRAM: 'vscode' }).hyperlinks).toBe(true);
  });

  it('reports the image protocol only where it exists', () => {
    expect(detectTerminalEnvironment({ TERM: 'xterm-kitty' }).kittyGraphics).toBe(true);
    expect(detectTerminalEnvironment({ TERM_PROGRAM: 'iTerm.app' }).kittyGraphics).toBe(true);
    expect(detectTerminalEnvironment({ TERM_PROGRAM: 'Apple_Terminal' }).kittyGraphics).toBe(false);
  });

  it('says the light palette is unusable below 256 colours', () => {
    // theme.ts writes the light palette as 256-colour numbers, so on a
    // 16-colour terminal every tag quantises to something arbitrary.
    expect(detectTerminalEnvironment({ TERM: 'xterm' }).supportsLightPalette).toBe(false);
    expect(detectTerminalEnvironment({ TERM: 'xterm-256color' }).supportsLightPalette).toBe(true);
    expect(detectTerminalEnvironment({ WT_SESSION: 'x' }).supportsLightPalette).toBe(true);
  });

  it('recognises tmux, whose abilities come from the outer terminal', () => {
    const env = detectTerminalEnvironment({ TERM: 'screen-256color', TMUX: '/tmp/tmux-0/default,1,0' });
    expect(env.program).toBe('tmux');
    expect(env.colorDepth).toBe(256);
    // Not a named emulator, so box drawing needs the locale to vouch for it.
    expect(env.unicodeBox).toBe(false);
    expect(detectTerminalEnvironment({ TERM: 'screen-256color', LANG: 'en_US.UTF-8' }).unicodeBox)
      .toBe(true);
  });
});
