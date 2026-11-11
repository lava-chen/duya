/**
 * The window/tab title: what is written, and what is refused.
 *
 * Three separate claims, tested separately because each fails differently:
 *
 * 1. `sanitizeTerminalTitle` is the ONLY place untrusted text becomes OSC
 *    payload. If it lets an `ESC` or `BEL` through, the sequence terminates
 *    early and the remainder is interpreted as terminal input — not a cosmetic
 *    bug, which is why the control-character cases are here rather than left to
 *    a rendering snapshot.
 * 2. `TerminalTitle` decides WHEN bytes go out. De-duplication is behavioural:
 *    an identical `set` must produce no write, and `clear` must not resurrect a
 *    title that was never written.
 * 3. `TUIApp` reaches that object on the transitions that mean something. This
 *    is the same class of check as `terminal-render-wiring.test.ts`: a correct
 *    helper nobody calls is indistinguishable from a missing feature.
 */

import { PassThrough, Writable } from 'stream';
import { describe, expect, it, vi } from 'vitest';

import { TUIApp } from '../TUIApp.js';
import {
  composeTerminalTitle,
  MAX_TERMINAL_TITLE_CHARS,
  sanitizeTerminalTitle,
  screenActive,
  TerminalTitle,
  terminalTitleEnabled,
  terminalTitleSequence,
} from '../terminal-title.js';

function recorder(): { readonly chunks: string[]; readonly writer: { isTTY: boolean; write: (chunk: string) => unknown } } {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      isTTY: true,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  };
}

describe('sanitizeTerminalTitle', () => {
  it('collapses whitespace and drops control characters', () => {
    // The newline and tab would otherwise rewrite the row the terminal is about
    // to repaint; the ESC and BEL would terminate the OSC early.
    expect(sanitizeTerminalTitle('  Project\t|\nWorking\x1b\x07\u009d\u009c |  Thread  '))
      .toBe('Project | Working | Thread');
  });

  it('strips bidi and zero-width formatting', () => {
    expect(sanitizeTerminalTitle('Pro\u202Ej\u2066e\u200Fc\u061Ct\u200B \uFEFFT\u2060itle'))
      .toBe('Project Title');
  });

  it('truncates on a codepoint boundary', () => {
    const sanitized = sanitizeTerminalTitle('a'.repeat(MAX_TERMINAL_TITLE_CHARS + 10));
    expect([...sanitized]).toHaveLength(MAX_TERMINAL_TITLE_CHARS);
  });

  it('keeps the last visible character over a separator at the boundary', () => {
    const input = `${'a'.repeat(MAX_TERMINAL_TITLE_CHARS - 1)} b`;
    const sanitized = sanitizeTerminalTitle(input);
    expect([...sanitized]).toHaveLength(MAX_TERMINAL_TITLE_CHARS);
    expect(sanitized.endsWith('b')).toBe(true);
  });

  it('returns an empty string when nothing visible survives', () => {
    expect(sanitizeTerminalTitle('\x07\x1b\u202E\uFEFF\n\t ')).toBe('');
  });

  it('degrades every non-ASCII codepoint under GNU Screen', () => {
    // Screen truncates UTF-8 titles to a byte, so a CJK title would become
    // control bytes. `?` is deliberately lossy and deliberately visible.
    expect(sanitizeTerminalTitle('日本語 ćafé', 'ascii')).toBe('??? ?af?');
    expect(sanitizeTerminalTitle('日本語', 'ascii')).toBe('???');
  });
});

describe('terminalTitleSequence', () => {
  it('detects Screen by STY, not by TERM', () => {
    expect(screenActive({ STY: '1234.pts-0' })).toBe(true);
    expect(screenActive({ TERM: 'screen-256color' })).toBe(false);
  });

  it('has a process-local opt-out', () => {
    expect(terminalTitleEnabled({})).toBe(true);
    expect(terminalTitleEnabled({ DUYA_TUI_TITLE: '0' })).toBe(false);
  });

  it('writes OSC 0 terminated by BEL', () => {
    expect(terminalTitleSequence('duya · 修复超时')).toBe('\x1b]0;duya · 修复超时\x07');
  });

  it('cannot be terminated early by its input', () => {
    const sequence = terminalTitleSequence('a\x07b\x1b]0;pwned\x07c');
    // Exactly one BEL, and it is the last byte.
    expect(sequence.split('\x07')).toHaveLength(2);
    expect(sequence.endsWith('\x07')).toBe(true);
    expect(sequence).toBe('\x1b]0;ab]0;pwnedc\x07');
  });
});

describe('composeTerminalTitle', () => {
  it('names the program alone when the session has no label', () => {
    expect(composeTerminalTitle({ app: 'duya' })).toBe('duya');
    expect(composeTerminalTitle({ app: 'duya', session: '   ' })).toBe('duya');
  });

  it('appends the session label', () => {
    expect(composeTerminalTitle({ app: 'duya', session: '3f2a1b0c' })).toBe('duya · 3f2a1b0c');
  });

  it('marks working and waiting with an ASCII-safe prefix', () => {
    expect(composeTerminalTitle({ app: 'duya', phase: 'working' })).toBe('▶ duya');
    expect(composeTerminalTitle({ app: 'duya', phase: 'waiting' })).toBe('! duya');
    expect(composeTerminalTitle({ app: 'duya', phase: 'working', encoding: 'ascii' })).toBe('> duya');
  });
});

describe('TerminalTitle', () => {
  it('writes once per distinct title', () => {
    const { chunks, writer } = recorder();
    const title = new TerminalTitle({ writer });
    expect(title.set('duya')).toBe(true);
    expect(title.set('duya')).toBe(false);
    expect(title.set('duya · a1b2')).toBe(true);
    expect(chunks).toEqual(['\x1b]0;duya\x07', '\x1b]0;duya · a1b2\x07']);
  });

  it('does not clear a title it never wrote', () => {
    const { chunks, writer } = recorder();
    expect(new TerminalTitle({ writer }).clear()).toBe(false);
    expect(chunks).toEqual([]);
  });

  it('clears with an empty payload', () => {
    const { chunks, writer } = recorder();
    const title = new TerminalTitle({ writer });
    title.set('duya');
    expect(title.clear()).toBe(true);
    expect(chunks).toEqual(['\x1b]0;duya\x07', '\x1b]0;\x07']);
    // A second clear is a no-op: nothing is owned any more.
    expect(title.clear()).toBe(false);
  });

  it('is a no-op when the writer is not a terminal', () => {
    const chunks: string[] = [];
    const title = new TerminalTitle({ writer: { isTTY: false, write: (chunk: string) => chunks.push(chunk) } });
    expect(title.set('duya')).toBe(false);
    expect(chunks).toEqual([]);
  });

  it('never writes a title that sanitises to nothing', () => {
    const { chunks, writer } = recorder();
    const title = new TerminalTitle({ writer });
    expect(title.set('\x07\x1b')).toBe(false);
    expect(chunks).toEqual([]);
  });
});

describe('TUIApp window title', () => {
  function appWithTitle(onSubmit: () => void = () => undefined): {
    readonly app: TUIApp;
    readonly chunks: string[];
  } {
    const { chunks, writer } = recorder();
    const app = new TUIApp({
      output: new PassThrough(),
      input: new PassThrough(),
      title: 'duya',
      sessionTitle: () => '3f2a1b0c',
      terminalTitle: new TerminalTitle({ writer }),
      onSubmit,
    });
    return { app, chunks };
  }

  it('writes the idle title at start', () => {
    const { app, chunks } = appWithTitle();
    app.start();
    expect(chunks).toEqual(['\x1b]0;duya · 3f2a1b0c\x07']);
    app.stop();
  });

  it('follows the turn phase and does not repeat itself', () => {
    const { app, chunks } = appWithTitle();
    app.start();
    app.setBusy(true);
    app.setBusy(true);
    expect(chunks).toEqual(['\x1b]0;duya · 3f2a1b0c\x07', '\x1b]0;▶ duya · 3f2a1b0c\x07']);
    app.setBusy(false);
    expect(chunks.at(-1)).toBe('\x1b]0;duya · 3f2a1b0c\x07');
    app.stop();
  });

  it('clears the title on stop', () => {
    const { app, chunks } = appWithTitle();
    app.start();
    app.stop();
    expect(chunks.at(-1)).toBe('\x1b]0;\x07');
  });

  /** A real Writable with `isTTY`, so the production wiring is under test. */
  function ttyStream(): { readonly stream: Writable; readonly chunks: string[] } {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    Object.defineProperty(stream, 'isTTY', { value: true });
    return { stream, chunks };
  }

  it('reaches a real tty stream, not just an injected title writer', () => {
    const { stream, chunks } = ttyStream();
    const app = new TUIApp({
      output: stream,
      input: new PassThrough(),
      title: 'duya',
      sessionTitle: () => 'a1b2c3d4',
      onSubmit: () => undefined,
    });
    app.start();
    expect(chunks.join('')).toContain('\x1b]0;duya · a1b2c3d4\x07');
    app.stop();
    expect(chunks.join('')).toContain('\x1b]0;\x07');
  });

  it('writes no title when DUYA_TUI_TITLE=0', () => {
    vi.stubEnv('DUYA_TUI_TITLE', '0');
    try {
      const { stream, chunks } = ttyStream();
      const app = new TUIApp({
        output: stream,
        input: new PassThrough(),
        title: 'duya',
        onSubmit: () => undefined,
      });
      app.start();
      app.stop();
      expect(chunks.join('')).not.toContain('\x1b]0;');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
