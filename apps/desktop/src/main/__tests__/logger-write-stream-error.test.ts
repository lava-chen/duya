/**
 * The desktop logger must not take the process down when a log write fails.
 *
 * ## The defect this locks down
 *
 * `Logger` extends `EventEmitter`, and its write-stream error handler used to
 * be a bare `this.emit('error', err)`. Node's documented behaviour is that
 * emitting `'error'` on an EventEmitter with no `'error'` listener THROWS the
 * error as an uncaught exception. No listener is ever registered for it
 * anywhere in the desktop app, so every write-stream failure became a crash
 * of the whole Electron main process.
 *
 * The failure is reachable with ordinary conditions: the log directory is
 * removed underneath a running app, the disk fills, a permission is revoked.
 * It is also reachable in CI, where a test removes its temporary data root
 * while the logger still holds a write stream into it. That is how this
 * surfaced as a red `test` job whose assertions had all passed: vitest
 * reported "Test Files 155 passed" plus one unhandled error.
 *
 * ## What these tests drive
 *
 * A REAL `Logger` writing into a REAL directory that is then removed, with
 * the write stream opened against a path that no longer exists. The assertion
 * is on the observable consequence -- no uncaught exception, and the logger
 * stays usable -- rather than on the internal shape of the fix.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLogger, type Logger } from '../logging/logger';

const created: string[] = [];

function tempDataRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-logger-test-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('desktop logger write-stream failures', () => {
  it('does not raise an uncaught exception when the log directory disappears', async () => {
    const dataRoot = tempDataRoot();
    process.env.DUYA_CLI_USER_DATA_DIR = dataRoot;
    const logger: Logger = initLogger({ console: false });

    // Remove the directory the logger's write stream points into. The
    // already-open descriptor survives on POSIX, so the failure surfaces on
    // the NEXT write, which is exactly the production shape of the bug.
    fs.rmSync(dataRoot, { recursive: true, force: true });

    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);

    try {
      logger.info('a log line written after the log directory was removed');
      // Give the stream's asynchronous error event a turn to fire.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('uncaughtException', onUncaught);
      delete process.env.DUYA_CLI_USER_DATA_DIR;
    }

    expect(uncaught).toEqual([]);
  });

  it('keeps accepting log calls after a write failure', async () => {
    const dataRoot = tempDataRoot();
    process.env.DUYA_CLI_USER_DATA_DIR = dataRoot;
    const logger: Logger = initLogger({ console: false });

    fs.rmSync(dataRoot, { recursive: true, force: true });
    logger.info('first line');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The logger must not throw on the call path after the stream died.
    expect(() => logger.info('second line')).not.toThrow();
    expect(() => logger.error('third line')).not.toThrow();

    delete process.env.DUYA_CLI_USER_DATA_DIR;
  });
});
