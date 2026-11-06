/**
 * OSC integrations beyond the title: the bytes, the gates, and the wiring.
 *
 * Four claims are tested separately because each fails differently:
 *
 * 1. The sequence constructors emit exactly the standard bytes. A stray
 *    character in an OSC body is not cosmetic — it terminates the sequence
 *    early and the remainder becomes terminal input.
 * 2. Payload preparation is safe: paths are valid `file:` URIs, notification
 *    bodies cannot smuggle control characters and are cut on a UTF-8 boundary.
 * 3. Policy refuses to write when it must. Notifications/progress are opt-in,
 *    progress is hard-gated on Windows Terminal, and `9;4` must never reach a
 *    terminal that would read it as an OSC 9 notification.
 * 4. The TUI actually reaches the integration. A correct helper nobody calls
 *    is indistinguishable from a missing feature.
 */

import { PassThrough, Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bell,
  desktopNotification,
  itermNotification,
  reportWorkingDirectory,
  setClipboard,
  setProgress,
} from '../terminal/ansi.js';
import {
  MAX_CLIPBOARD_BYTES,
  MAX_NOTIFICATION_BYTES,
  NOTIFY_THROTTLE_MS,
  notificationBackend,
  notificationSequence,
  osc7Uri,
  progressSequence,
  sanitizeNotification,
  TerminalIntegration,
  terminalIntegrationFlags,
  tmuxPassthrough,
  type TerminalOscWriter,
} from '../terminal-integration.js';
import { TUIApp } from '../TUIApp.js';

beforeEach(() => {
  // Agent/CI shells export TERM=dumb. A dumb terminal has no OSC parser, so
  // the integration *correctly* refuses to write there; the tests that
  // exercise the live TUI need a named terminal instead. Tests of the flag
  // resolver pass an explicit env bag and are unaffected.
  vi.stubEnv('TERM', 'xterm-256color');
});

afterEach(() => vi.unstubAllEnvs());

/** A writer that records bytes and can fail once, to test retry semantics. */
function recorder(): {
  readonly chunks: string[];
  readonly writer: TerminalOscWriter;
  failNext(): void;
} {
  const chunks: string[] = [];
  let failing = false;
  return {
    chunks,
    writer: {
      isTTY: true,
      write(chunk: string) {
        if (failing) {
          failing = false;
          throw new Error('tty write failed');
        }
        chunks.push(chunk);
        return true;
      },
    },
    failNext() { failing = true; },
  };
}

/** A real Writable with `isTTY`, so the production TUI wiring is under test. */
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

describe('OSC sequence bytes', () => {
  it('encodes cwd, clipboard, notifications and progress', () => {
    expect(reportWorkingDirectory('file://host/tmp/x')).toBe('\x1b]7;file://host/tmp/x\x07');
    expect(setClipboard('aGk=')).toBe('\x1b]52;c;aGk=\x07');
    expect(desktopNotification('done')).toBe('\x1b]9;done\x07');
    expect(itermNotification('done')).toBe('\x1b]777;notify;duya;done\x1b\\');
    expect(bell()).toBe('\x07');
    expect(setProgress(2)).toBe('\x1b]9;4;2;0\x07');
    expect(setProgress(0)).toBe('\x1b]9;4;0;0\x07');
  });

  it('clamps the progress percentage to 0..100 and rounds it', () => {
    expect(setProgress(1, 137)).toBe('\x1b]9;4;1;100\x07');
    expect(setProgress(1, -4)).toBe('\x1b]9;4;1;0\x07');
    expect(setProgress(1, 4.6)).toBe('\x1b]9;4;1;5\x07');
  });
});

describe('osc7Uri', () => {
  it('encodes a Windows drive path without encoding the drive colon', () => {
    expect(osc7Uri('C:\\Users\\a b', 'host', 'win32'))
      .toBe('file://host/C:/Users/a%20b');
  });

  it('percent-encodes non-ASCII path segments', () => {
    expect(osc7Uri('/tmp/项目 x', 'host', 'linux'))
      .toBe('file://host/tmp/%E9%A1%B9%E7%9B%AE%20x');
  });

  it('encodes the hostname', () => {
    expect(osc7Uri('/tmp', 'my host', 'linux')).toBe('file://my%20host/tmp');
  });

  it('keeps a UNC server in the path rather than claiming it is the host', () => {
    expect(osc7Uri('\\\\server\\share\\a', 'host', 'win32'))
      .toBe('file://host//server/share/a');
  });
});

describe('sanitizeNotification', () => {
  it('folds control characters that would terminate the OSC early', () => {
    const clean = sanitizeNotification('a\x07b\x1b[31m\n\t c');
    expect(clean).not.toMatch(/[\x00-\x1f\x7f-\x9f]/u);
    expect(clean).not.toContain('  ');
    expect(clean).toBe('a b [31m c');
  });

  it('drops bidi and zero-width formatting (Trojan Source)', () => {
    expect(sanitizeNotification('safe\u202E\u200Btext')).toBe('safetext');
  });

  it('truncates on a UTF-8 boundary and appends an ellipsis', () => {
    const clean = sanitizeNotification('汉'.repeat(200));
    expect(Buffer.byteLength(clean, 'utf8')).toBeLessThanOrEqual(MAX_NOTIFICATION_BYTES);
    expect(clean.endsWith('…')).toBe(true);
    // No U+FFFD: cutting a CJK codepoint in half would produce one.
    expect(clean).not.toContain('\ufffd');
  });

  it('returns empty for a body that is only controls', () => {
    expect(sanitizeNotification('\x07\x1b\n')).toBe('');
  });
});

describe('notification backend selection', () => {
  it('uses the titled iTerm2 form only for iTerm2', () => {
    expect(notificationBackend('iterm2')).toBe('iterm');
    expect(notificationSequence('done', 'iterm2')).toBe('\x1b]777;notify;duya;done\x1b\\');
  });

  it('uses OSC 9 for kitty and WezTerm', () => {
    expect(notificationBackend('kitty')).toBe('osc9');
    expect(notificationBackend('wezterm')).toBe('osc9');
    expect(notificationSequence('done', 'kitty')).toBe('\x1b]9;done\x07');
  });

  it('falls back to a bell where OSC 9 would be ignored or misread', () => {
    for (const program of ['windows-terminal', 'vscode', 'apple-terminal', 'alacritty', 'tmux', 'unknown'] as const) {
      expect(notificationBackend(program)).toBe('bell');
      expect(notificationSequence('done', program)).toBe('\x07');
    }
  });
});

describe('progress hard gate', () => {
  it('builds a sequence only for Windows Terminal', () => {
    expect(progressSequence(2, 'windows-terminal')).toBe('\x1b]9;4;2;0\x07');
  });

  it('refuses every other terminal, including ones that support OSC 9', () => {
    for (const program of ['iterm2', 'kitty', 'wezterm', 'vscode', 'tmux', 'unknown'] as const) {
      expect(progressSequence(2, program)).toBeNull();
    }
  });
});

describe('tmuxPassthrough', () => {
  it('is the identity without TMUX', () => {
    expect(tmuxPassthrough('\x1b]9;4;2;0\x07', {})).toBe('\x1b]9;4;2;0\x07');
  });

  it('wraps in DCS and doubles every ESC', () => {
    expect(tmuxPassthrough('\x1b]9;4;2;0\x07', { TMUX: '/tmp/tmux-1000/default,1,0' }))
      .toBe('\x1bPtmux;\x1b\x1b]9;4;2;0\x07\x1b\\');
  });
});

describe('terminalIntegrationFlags', () => {
  const base = { TERM: 'xterm-256color' };

  it('enables only the side-effect-free channels by default', () => {
    expect(terminalIntegrationFlags(base)).toEqual({
      cwd: true, clipboard: true, notify: false, progress: false,
    });
  });

  it('turns everything off under the master switch or TERM=dumb', () => {
    expect(terminalIntegrationFlags({ ...base, DUYA_TUI_TERMINAL_INTEGRATION: '0' }, 'windows-terminal'))
      .toEqual({ cwd: false, clipboard: false, notify: false, progress: false });
    expect(terminalIntegrationFlags({ TERM: 'dumb' }))
      .toEqual({ cwd: false, clipboard: false, notify: false, progress: false });
  });

  it('requires an explicit opt-in for notifications', () => {
    expect(terminalIntegrationFlags({ ...base, DUYA_TUI_NOTIFY: '1' }).notify).toBe(true);
    expect(terminalIntegrationFlags({ ...base, DUYA_TUI_NOTIFY: 'true' }).notify).toBe(false);
  });

  it('requires BOTH the opt-in and Windows Terminal for progress', () => {
    expect(terminalIntegrationFlags({ ...base, DUYA_TUI_PROGRESS: '1' }, 'windows-terminal').progress).toBe(true);
    expect(terminalIntegrationFlags({ ...base, DUYA_TUI_PROGRESS: '1' }, 'kitty').progress).toBe(false);
    expect(terminalIntegrationFlags(base, 'windows-terminal').progress).toBe(false);
  });

  it('lets each always-on channel be disabled individually', () => {
    expect(terminalIntegrationFlags({ ...base, DUYA_TUI_CWD: '0' }).cwd).toBe(false);
    expect(terminalIntegrationFlags({ ...base, DUYA_TUI_CLIPBOARD: '0' }).clipboard).toBe(false);
  });
});

describe('TerminalIntegration', () => {
  it('writes cwd once, then again only after a real change', () => {
    const { chunks, writer } = recorder();
    const integration = new TerminalIntegration({ writer, platform: 'linux', host: 'host' });
    expect(integration.reportCwd('/tmp/a')).toBe(true);
    expect(integration.reportCwd('/tmp/a')).toBe(false);
    expect(integration.reportCwd('/tmp/b')).toBe(true);
    expect(chunks).toEqual([
      '\x1b]7;file://host/tmp/a\x07',
      '\x1b]7;file://host/tmp/b\x07',
    ]);
  });

  it('does not cache a failed write, so the next call retries', () => {
    const { chunks, writer, failNext } = recorder();
    const integration = new TerminalIntegration({ writer, platform: 'linux', host: 'host' });
    failNext();
    expect(integration.reportCwd('/tmp/a')).toBe(false);
    expect(integration.reportCwd('/tmp/a')).toBe(true);
    expect(chunks).toEqual(['\x1b]7;file://host/tmp/a\x07']);
  });

  it('base64-encodes the clipboard text', () => {
    const { chunks, writer } = recorder();
    const integration = new TerminalIntegration({ writer });
    expect(integration.copy('hi')).toBe(true);
    expect(chunks).toEqual(['\x1b]52;c;aGk=\x07']);
  });

  it('refuses an empty or oversized clipboard payload', () => {
    const { chunks, writer } = recorder();
    const integration = new TerminalIntegration({ writer });
    expect(integration.copy('')).toBe(false);
    expect(integration.copy('x'.repeat(MAX_CLIPBOARD_BYTES + 1))).toBe(false);
    expect(chunks).toEqual([]);
  });

  it('never notifies unless opted in, and throttles an identical body', () => {
    const { chunks, writer } = recorder();
    let clock = 0;
    const off = new TerminalIntegration({ writer, now: () => clock });
    expect(off.notify('Turn complete')).toBe(false);

    const on = new TerminalIntegration({
      writer,
      flags: { notify: true },
      program: 'kitty',
      now: () => clock,
    });
    expect(on.notify('Turn complete')).toBe(true);
    expect(on.notify('Turn complete')).toBe(false);
    clock = NOTIFY_THROTTLE_MS;
    expect(on.notify('Turn complete')).toBe(true);
    expect(chunks).toEqual(['\x1b]9;Turn complete\x07', '\x1b]9;Turn complete\x07']);
  });

  it('does not cache a notification whose write failed', () => {
    const { chunks, writer, failNext } = recorder();
    const integration = new TerminalIntegration({ writer, flags: { notify: true }, program: 'kitty' });
    failNext();
    expect(integration.notify('Turn complete')).toBe(false);
    expect(integration.notify('Turn complete')).toBe(true);
    expect(chunks).toEqual(['\x1b]9;Turn complete\x07']);
  });

  it('refuses progress outside Windows Terminal even when enabled', () => {
    const { chunks, writer } = recorder();
    const integration = new TerminalIntegration({ writer, flags: { progress: true }, program: 'kitty' });
    expect(integration.progress(2)).toBe(false);
    expect(chunks).toEqual([]);
  });

  it('writes progress transitions and removes the indicator on dispose', () => {
    const { chunks, writer } = recorder();
    const integration = new TerminalIntegration({
      writer, flags: { progress: true }, program: 'windows-terminal',
    });
    expect(integration.progress(0)).toBe(false); // nothing to remove yet
    expect(integration.progress(2)).toBe(true);
    expect(integration.progress(2)).toBe(false);
    expect(integration.progress(3)).toBe(true);
    integration.dispose();
    expect(chunks).toEqual([
      '\x1b]9;4;2;0\x07',
      '\x1b]9;4;3;0\x07',
      '\x1b]9;4;0;0\x07',
    ]);
  });

  it('passes sequences through tmux for the outer terminal', () => {
    const { chunks, writer } = recorder();
    const integration = new TerminalIntegration({
      writer, env: { TMUX: '/tmp/tmux,1,0', TERM: 'screen-256color' },
    });
    expect(integration.copy('hi')).toBe(true);
    expect(chunks).toEqual(['\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\']);
  });

  it('writes nothing when the output is not a tty', () => {
    const { chunks, writer } = recorder();
    const integration = new TerminalIntegration({ writer: { ...writer, isTTY: false } });
    expect(integration.reportCwd('/tmp')).toBe(false);
    expect(integration.copy('hi')).toBe(false);
    expect(chunks).toEqual([]);
  });
});

describe('TUIApp wiring', () => {
  it('reports the working directory on start and sends /copy text over OSC 52', () => {
    const { stream, chunks } = ttyStream();
    const app = new TUIApp({
      output: stream,
      input: new PassThrough(),
      workspaceDirectory: () => '/tmp/duya',
      onSubmit: () => undefined,
    });
    app.start();
    expect(chunks.join('')).toMatch(/\x1b\]7;file:\/\//u);
    // The callback, not process.cwd(): `/project` moves the surface.
    expect(chunks.join('')).toContain('/tmp/duya\x07');
    expect(app.copyToTerminalClipboard('hi')).toBe(true);
    expect(chunks.join('')).toContain('\x1b]52;c;aGk=\x07');
    app.stop();
  });

  it('drives progress from busy/permission transitions when enabled', () => {
    const { chunks, writer } = recorder();
    const integration = new TerminalIntegration({
      writer, flags: { progress: true }, program: 'windows-terminal',
    });
    const app = new TUIApp({
      output: new PassThrough(),
      input: new PassThrough(),
      terminalIntegration: integration,
      onSubmit: () => undefined,
    });
    app.start();
    app.setBusy(true);
    app.setBusy(false);
    app.stop();
    expect(chunks).toContain('\x1b]9;4;2;0\x07');
    expect(chunks).toContain('\x1b]9;4;0;0\x07');
  });

  it('notifies on a completed turn when enabled', () => {
    const { chunks, writer } = recorder();
    const integration = new TerminalIntegration({ writer, flags: { notify: true }, program: 'unknown' });
    const app = new TUIApp({
      output: new PassThrough(),
      input: new PassThrough(),
      terminalIntegration: integration,
      onSubmit: () => undefined,
    });
    app.start();
    app.setBusy(true);
    app.setBusy(false);
    expect(chunks).toContain('\x07'); // bell: the fallback backend
    app.stop();
  });

  it('writes no OSC integration bytes under the master switch', () => {
    vi.stubEnv('DUYA_TUI_TERMINAL_INTEGRATION', '0');
    const { stream, chunks } = ttyStream();
    // Default construction, so the switch is exercised through the real
    // wiring rather than through an injected, already-disabled object.
    const app = new TUIApp({
      output: stream,
      input: new PassThrough(),
      onSubmit: () => undefined,
    });
    app.start();
    expect(app.copyToTerminalClipboard('hi')).toBe(false);
    expect(chunks.join('')).not.toContain('\x1b]7;');
    expect(chunks.join('')).not.toContain('\x1b]52;');
    app.stop();
  });
});
