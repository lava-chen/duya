import { describe, it, expect, afterEach, vi } from 'vitest';
import { installConsoleCapture, type ConsoleSink } from '../tui-session.js';

/**
 * The alternate screen owns the terminal. Anything written to stdout while the
 * TUI is up lands on top of the rendered frame and corrupts it.
 *
 * This suite exists because that happened for real: the agent logger defaults to
 * INFO, so every turn emitted dozens of `[INFO] [Agent] ...` lines straight onto
 * the screen, and the capture that should have absorbed them was only installed
 * around the two slash-command call sites. Nothing in the test suite ran a turn,
 * so nothing caught it.
 *
 * The load-bearing assertion in every case below is the one on `stdout.write`:
 * it is the actual corruption, and it is the thing the old code got wrong.
 */

interface Captured {
  notices: string[];
  errors: string[];
}

function stub(): ConsoleSink & Captured {
  const notices: string[] = [];
  const errors: string[] = [];
  return {
    notices,
    errors,
    printNotice: (text: string) => void notices.push(text),
    printError: (text: string) => void errors.push(text),
  };
}

const restoreFns: Array<() => void> = [];
const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const r of restoreFns.splice(0)) r();
  for (const s of spies.splice(0)) s.mockRestore();
  vi.restoreAllMocks();
});

/** Capture every byte that would reach the real terminal. */
function watchStdout(): string[] {
  const written: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      written.push(typeof chunk === 'string' ? chunk : String(chunk));
      const cb = rest.find((a) => typeof a === 'function') as (() => void) | undefined;
      cb?.();
      return true;
    });
  spies.push(spy);
  return written;
}

describe('installConsoleCapture', () => {
  it('routes every console method away from the terminal', () => {
    const tui = stub();
    const stdout = watchStdout();
    const restore = installConsoleCapture(tui);
    restoreFns.push(restore);

    console.log('log-line');
    console.warn('warn-line');
    console.debug('debug-line');
    console.error('error-line');

    expect(tui.notices).toEqual(['log-line', 'warn-line', 'debug-line']);
    expect(tui.errors).toEqual(['error-line']);
    expect(stdout).toEqual([]);
  });

  it('keeps the content of an object argument', () => {
    const tui = stub();
    const restore = installConsoleCapture(tui);
    restoreFns.push(restore);

    // The shape the agent actually emits: a label plus a structured dump.
    console.warn('[duya-ai] anthropic request system prompt', { length: 117041, isMiniMax: true });

    expect(tui.notices).toHaveLength(1);
    expect(tui.notices[0]).toContain('117041');
    expect(tui.notices[0]).not.toContain('[object Object]');
  });

  it('routes output back to the original console after restore', () => {
    // A known-original installed BEFORE the capture, so the assertion does not
    // depend on what the test runner happens to have bound console.log to.
    const seen: unknown[][] = [];
    const harnessOriginal = console.log;
    console.log = (...args: unknown[]) => void seen.push(args);

    const restore = installConsoleCapture(stub());
    console.log('while captured');
    expect(seen).toEqual([]);

    restore();
    console.log('after restore');
    console.log = harnessOriginal;

    expect(seen).toEqual([['after restore']]);
  });

  it('restores the original console methods', () => {
    const before = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      debug: console.debug,
    };

    const restore = installConsoleCapture(stub());
    restore();

    expect(console.log).toBe(before.log);
    expect(console.error).toBe(before.error);
    expect(console.warn).toBe(before.warn);
    expect(console.debug).toBe(before.debug);
  });

  it('leaves the console restorable after the sink throws', () => {
    const before = console.log;
    const restore = installConsoleCapture({
      printNotice: () => {
        throw new Error('sink exploded');
      },
      printError: () => undefined,
    });

    expect(() => console.log('boom')).toThrow('sink exploded');

    // The capture does NOT unwind itself — the session's teardown owns that,
    // via the `finally` in `finish()`. What this pins is that the undo still
    // works once the console is in a throwing state, so a failed sink cannot
    // leave the process permanently unable to write.
    restore();
    expect(console.log).toBe(before);
  });
});