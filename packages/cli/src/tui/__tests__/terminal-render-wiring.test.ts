/**
 * The wiring between detection and the renderer.
 *
 * `terminal-env.test.ts` proves the DETECTION is right for a given terminal.
 * This proves the detection REACHES blessed. Without it, putting `colors: 256`
 * and `fullUnicode: true` back into the `blessed.program` call would leave
 * every existing test green while the feature quietly stopped working — the
 * classic failure where the tested function is correct and its caller ignores
 * it.
 *
 * The seam that makes this observable is `RenderConfig`: the exact options
 * object is published on the writer and passed to blessed by reference, so
 * what a test reads is what `Program` was constructed from.
 */

import { describe, expect, it } from 'vitest';
import { Writable, PassThrough } from 'stream';

import { TUIApp, type RenderConfig } from '../TUIApp.js';
import { detectTerminalEnvironment, type TerminalEnvironment } from '../terminal-env.js';

function sink(): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

/** Build an app against a known terminal and read back what it rendered with. */
function renderConfigFor(
  env: NodeJS.ProcessEnv,
  options: { theme?: 'dark' | 'light' } = {},
): RenderConfig & { readonly theme: string } {
  const stream = sink();
  const app = new TUIApp({
    output: stream,
    input: new PassThrough(),
    terminalEnv: detectTerminalEnvironment(env),
    onSubmit: () => undefined,
    ...(options.theme === undefined ? {} : { theme: options.theme }),
  });
  try {
    // Started and stopped so blessed's screen and terminal modes are torn down
    // between cases; `stop()` is a no-op on an app that never started.
    app.start();
    // The writer is the object the render config was published on.
    const published = (app as unknown as {
      writer: Record<string, unknown>;
      theme: { name: string };
    });
    return {
      ...(published.writer.renderConfig as RenderConfig),
      theme: published.theme.name,
    };
  } finally {
    app.stop();
  }
}

describe('terminal capabilities reach the renderer', () => {
  it('asks blessed for 16 colours on a 16-colour terminal', () => {
    expect(renderConfigFor({ TERM: 'xterm' }).program.colors).toBe(16);
  });

  it('asks blessed for the 256 palette when the terminal has it', () => {
    expect(renderConfigFor({ TERM: 'xterm-256color' }).program.colors).toBe(256);
  });

  it('asks blessed for its 24-bit path on a truecolor terminal', () => {
    // blessed's `colors: 16` is the 24-bit path; anything higher is the
    // 256-colour palette. Mapping truecolor to 256 would be a silent downgrade.
    expect(renderConfigFor({ COLORTERM: 'truecolor' }).program.colors).toBe(16);
    expect(renderConfigFor({ WT_SESSION: 'abc' }).program.colors).toBe(16);
  });

  it('passes the real TERM through instead of inventing one', () => {
    expect(renderConfigFor({ TERM: 'xterm-kitty' }).program.terminal).toBe('xterm-kitty');
    // The old code answered an unset TERM with 'xterm-256color'.
    expect(renderConfigFor({}).program.terminal).toBe('dumb');
  });

  it('turns off box characters where they cannot be trusted', () => {
    expect(renderConfigFor({ TERM: 'linux', LANG: 'en_US.UTF-8' }).screen.fullUnicode).toBe(false);
    expect(renderConfigFor({ TERM_PROGRAM: 'WezTerm' }).screen.fullUnicode).toBe(true);
  });

  it('refuses a light theme the terminal cannot render', () => {
    // The light palette is 256-colour numbers; on 16 colours every tag
    // quantises to something arbitrary, so this is a fallback, not a style.
    expect(renderConfigFor({ TERM: 'xterm' }, { theme: 'light' }).theme).toBe('dark');
  });

  it('keeps a light theme where it can be honoured', () => {
    expect(renderConfigFor({ TERM: 'xterm-256color' }, { theme: 'light' }).theme).toBe('light');
    expect(renderConfigFor({ WT_SESSION: 'abc' }, { theme: 'light' }).theme).toBe('light');
  });

  it('leaves an explicit dark theme alone everywhere', () => {
    expect(renderConfigFor({ TERM: 'xterm' }, { theme: 'dark' }).theme).toBe('dark');
  });
});

describe('detection is total', () => {
  it('returns a complete environment for an empty bag', () => {
    // No optional field may be undefined: TUIApp reads these during
    // construction, so a hole here is a crash at startup, not a degraded UI.
    //
    // The platform is named rather than inherited: `unicodeBox` deliberately
    // disagrees between the two, so a row that did not say which one it meant
    // would assert the wrong thing on half the machines that run it.
    const posix = detectTerminalEnvironment({}, 'linux');
    expect(posix).toEqual({
      term: 'dumb',
      program: 'unknown',
      colorDepth: 16,
      unicodeBox: false,
      hyperlinks: false,
      kittyGraphics: false,
      supportsLightPalette: false,
    });

    // Same empty bag, Windows. Every field is still present — detection is
    // still total — but `unicodeBox` is true, because blessed replaces every
    // non-ASCII cell with `?` when it is false and a stock Windows PowerShell
    // sets none of the POSIX locale variables the old check looked for.
    const windows = detectTerminalEnvironment({}, 'win32');
    expect(windows).toEqual({
      term: 'dumb',
      program: 'unknown',
      colorDepth: 16,
      unicodeBox: true,
      hyperlinks: false,
      kittyGraphics: false,
      supportsLightPalette: false,
    });
  });
});
