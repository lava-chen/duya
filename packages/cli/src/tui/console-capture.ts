/**
 * Console capture for the full-screen TUI.
 *
 * ## Why this exists
 *
 * `blessed` renders through its own writer, not through `process.stdout`. That
 * means anything in the same process that calls `console.log` bypasses the
 * renderer entirely and the text lands inline, in the middle of the transcript,
 * unscrollable and unstyled. The Host used to do exactly this: `duya tui` starts
 * an ephemeral Host in-process, and every line the Host logged — including each
 * worker's stderr, including the stderr of the npm/MCP children that worker
 * spawned — went straight onto the screen until the user's own turn was
 * unreadable.
 *
 * Redirecting the Host's own diagnostics was necessary but not sufficient: the
 * property the user actually needs is "nothing but the TUI paints this
 * terminal", and that has to hold for the next `console.*` call nobody
 * remembered to move. So the TUI claims `console` for its lifetime and hands
 * it to the Host's diagnostics log.
 *
 * ## What is deliberately NOT touched
 *
 * `process.stdout` / `process.stderr` keep their original bindings. Patching
 * those would break `blessed`'s own rendering, which is the one thing that must
 * keep working. Only the `console` METHODS are swapped.
 *
 * Writes are best-effort: a logging call must never throw into a run.
 */

import * as fs from 'fs';
import * as path from 'path';

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleCapture {
  /** Put the original console methods back. Safe to call more than once. */
  restore(): void;
  /** The file captured lines are being appended to. */
  readonly logPath: string;
  /** Lines captured so far; the count is what a test asserts on. */
  readonly capturedCount: () => number;
}

const METHODS: readonly ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];

/**
 * Send every `console.*` call to `logPath` until the returned handle is
 * restored.
 */
export function captureConsoleToFile(logPath: string): ConsoleCapture {
  const target = globalThis.console;
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  let captured = 0;

  const append = (method: ConsoleMethod, args: readonly unknown[]): void => {
    captured += 1;
    const rendered = args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.stack ?? arg.message;
        try {
          return JSON.stringify(arg) ?? String(arg);
        } catch {
          return '[unserializable]';
        }
      })
      .join(' ');
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(
        logPath,
        `[${new Date().toISOString()}] [${method.toUpperCase()}] ${rendered}\n`,
        'utf8',
      );
    } catch {
      // Diagnostics must never fail the run they are describing.
    }
  };

  for (const method of METHODS) {
    const original = target[method] as (...args: unknown[]) => void;
    originals.set(method, original);
    target[method] = (...args: unknown[]): void => {
      append(method, args);
    };
  }

  let restored = false;
  return {
    logPath,
    capturedCount: () => captured,
    restore: (): void => {
      if (restored) return;
      restored = true;
      for (const [method, original] of originals) {
        target[method] = original as typeof target.log;
      }
    },
  };
}
