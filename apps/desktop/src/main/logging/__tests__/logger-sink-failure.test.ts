/**
 * The logger survives a log directory that went away.
 *
 * ## The defect this guards
 *
 * The file sink is a `fs.WriteStream`, and its `error` event was forwarded
 * to the logger with `this.emit('error', err)`. `EventEmitter.emit('error')`
 * THROWS when no listener is registered for it -- and nothing in the app
 * registers one. So the FIRST failure of the log file (a directory that was
 * removed, a full disk, a read-only path) became an uncaught exception that
 * took the process down.
 *
 * The logger is the one component that must never do that: a broken log sink
 * is a degraded-logging condition, not a fatal one.
 *
 * ## How it showed up
 *
 * `apps/desktop/src/main/cli/handlers/crons.test.ts` points Electron's
 * userData at a temp directory and removes it in `afterEach`. The stream's
 * open is asynchronous, so it could land after the removal: the open failed
 * with ENOENT, the error was forwarded, nobody was listening, and vitest
 * reported one unhandled error and failed the run -- with every test file
 * green. The failure looked like it came from the harness; it came from the
 * logger.
 *
 * ## What is asserted here
 *
 * | what | how it is checked |
 * | --- | --- |
 * | a failed sink does not become an uncaught exception | a `process` listener records any uncaught exception, and the test asserts none arrived |
 * | the logger keeps working after the sink died | logging after the failure does not throw |
 * | a listener still gets told | the error is delivered to a registered listener |
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Logger from '../logger.js';

interface LoggerInternals {
  cleanup(): void;
}

/** Waits for the stream's asynchronous open to settle. */
function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const createdDirs: string[] = [];
const createdLoggers: Logger[] = [];

function makeLogger(): { logger: Logger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'duya-logger-test-'));
  createdDirs.push(dir);
  const previous = process.env.DUYA_CLI_USER_DATA_DIR;
  process.env.DUYA_CLI_USER_DATA_DIR = dir;
  try {
    const logger = new Logger({ console: false });
    createdLoggers.push(logger);
    return { logger, dir };
  } finally {
    if (previous === undefined) {
      delete process.env.DUYA_CLI_USER_DATA_DIR;
    } else {
      process.env.DUYA_CLI_USER_DATA_DIR = previous;
    }
  }
}

/**
 * Removes the directory the logger's sink was opened against, so the sink's
 * pending open fails with ENOENT.
 */
function killTheSink(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

afterEach(() => {
  for (const logger of createdLoggers.splice(0)) {
    (logger as unknown as LoggerInternals).cleanup();
  }
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('the logger when its log directory goes away', () => {
  it('does not raise an uncaught exception', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);

    try {
      const { logger, dir } = makeLogger();
      killTheSink(dir);
      await settle();

      // Logging has to keep working: the app is still running, only its
      // log directory is gone.
      expect(() => logger.info('the log directory went away')).not.toThrow();
      expect(() => logger.error('still alive')).not.toThrow();
      await settle();

      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('still tells a listener that registered for the failure', async () => {
    const { logger, dir } = makeLogger();
    const seen: unknown[] = [];
    logger.on('error', (error) => {
      seen.push(error);
    });

    killTheSink(dir);
    await settle();

    expect(seen.length).toBeGreaterThan(0);
  });
});
