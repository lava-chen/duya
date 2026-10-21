/**
 * Worker stderr accounting.
 *
 * These tests fork a REAL child and read its REAL stderr pipe, because the bug
 * this covers was never in a branch — it was in the shape of the data arriving
 * from outside: every chunk of a worker's stderr used to be logged twice, once
 * as an ERROR "raw passthrough" and once classified, and nothing collapsed
 * repeats. A unit test that called the private recorder would have been written
 * against the fixed version and would not have caught the original shape.
 *
 * The assertion that matters most is the first one: for one turn that produced
 * one line of child-process noise, the user must be able to see ONE record.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkerManager, type WorkerManagerLogger } from '../src/worker-manager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'stderr-worker.cjs');

interface StderrRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  error?: Error;
  fields?: Record<string, unknown>;
}

/** A logger that keeps everything, so a test can assert on what the user saw. */
function recordingLogger(sink: StderrRecord[]): WorkerManagerLogger {
  return {
    debug: (message, fields) => {
      sink.push({ level: 'debug', message, ...(fields === undefined ? {} : { fields }) });
    },
    info: (message, fields) => {
      sink.push({ level: 'info', message, ...(fields === undefined ? {} : { fields }) });
    },
    warn: (message, fields) => {
      sink.push({ level: 'warn', message, ...(fields === undefined ? {} : { fields }) });
    },
    error: (message, error, fields) => {
      sink.push({
        level: 'error',
        message,
        ...(error === undefined ? {} : { error }),
        ...(fields === undefined ? {} : { fields }),
      });
    },
  };
}

const managers: WorkerManager[] = [];
const FIXTURE_ENV = [
  'DUYA_TEST_STDERR_REPEAT',
  'DUYA_TEST_STDERR_DISTINCT',
  'DUYA_TEST_STDERR_MULTILINE',
  'DUYA_TEST_STDERR_HOLD',
];

function startManager(env: Record<string, string>): { records: StderrRecord[] } {
  const records: StderrRecord[] = [];
  const manager = new WorkerManager(
    {
      getState: () => 'IDLE',
      transitionToStreaming: () => undefined,
      transitionToCrashed: () => undefined,
    },
    {
      logger: recordingLogger(records),
      resolveWorkerPath: () => FIXTURE,
      resolveBetterSqlite3Path: () => path.join(HERE, 'no-such-better-sqlite3'),
    },
  );
  managers.push(manager);
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  manager.spawnWorker('session-1');
  return { records };
}

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.stopIdleReaper();
    manager.killAll();
  }
  // The fixture reads these at spawn time; a leftover value would silently
  // change the shape of the NEXT test's child.
  for (const key of FIXTURE_ENV) delete process.env[key];
});

/** Wait until `count` stderr records exist, or fail loudly rather than hang. */
async function waitForStderrRecords(records: StderrRecord[], count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (records.filter((r) => r.message === 'Worker stderr').length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${count} stderr records; saw ${records.length}: ` +
          JSON.stringify(records.map((r) => `${r.level}:${r.message}`)),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('worker stderr accounting', () => {
  it('emits exactly one record per line, never a second passthrough copy', async () => {
    const { records } = startManager({ DUYA_TEST_STDERR_REPEAT: '1' });
    await waitForStderrRecords(records, 1);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Count by CONTENT, not by message name: the old handler emitted every
    // chunk twice under two different messages, so a test that only asserted
    // one message was absent would pass again the moment someone renamed it.
    const mentioning = records.filter((r) =>
      String(r.fields?.line ?? '').includes('npm error 404'),
    );
    expect(mentioning).toHaveLength(1);
  });

  it('collapses a repeating line into one record plus a single repeat summary', async () => {
    const { records } = startManager({ DUYA_TEST_STDERR_REPEAT: '50' });
    await waitForStderrRecords(records, 4);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const stderr = records.filter((r) => r.message === 'Worker stderr');
    // 50 identical lines collapse to the first few, not 50 (and not 100).
    expect(stderr.length).toBeLessThanOrEqual(5);
    expect(stderr.length).toBeGreaterThan(0);

    const repeatWarnings = records.filter(
      (r) => r.message === 'Worker stderr line repeating; further copies dropped',
    );
    expect(repeatWarnings).toHaveLength(1);
    expect(repeatWarnings[0]?.fields).toMatchObject({ occurrences: 5 });
  });

  it('treats unprefixed child-process noise as INFO, not ERROR', async () => {
    // `npm error 404 …` is what a worker prints when a spawned npm call fails.
    // It contains no [ERROR] prefix and no `Error:` — classifying it as an
    // error manufactured alerts nobody could act on.
    const { records } = startManager({ DUYA_TEST_STDERR_REPEAT: '1' });
    await waitForStderrRecords(records, 1);

    const stderr = records.filter((r) => r.message === 'Worker stderr');
    expect(stderr[0]?.level).toBe('info');
    expect(stderr[0]?.fields?.line).toContain('npm error 404');
  });

  it('splits a multi-line chunk and keeps the raw text on every record', async () => {
    const { records } = startManager({ DUYA_TEST_STDERR_MULTILINE: '1' });
    await waitForStderrRecords(records, 3);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stderr = records.filter((r) => r.message === 'Worker stderr');
    const lines = stderr.map((r) => r.fields?.line);
    expect(lines).toEqual(
      expect.arrayContaining([
        '[WARN] first of three',
        '[ERROR] second of three',
        'third, unprefixed',
      ]),
    );
    // Levels follow the worker's own prefix; unprefixed stays INFO.
    expect(stderr.find((r) => r.fields?.line === '[WARN] first of three')?.level).toBe('warn');
    expect(stderr.find((r) => r.fields?.line === '[ERROR] second of three')?.level).toBe('error');
    expect(stderr.find((r) => r.fields?.line === 'third, unprefixed')?.level).toBe('info');
  });

  it('drops distinct lines past the ceiling and says so once', async () => {
    const { records } = startManager({ DUYA_TEST_STDERR_DISTINCT: '260' });
    await waitForStderrRecords(records, 1);

    const CEILING = 'Worker stderr line ceiling reached; further lines dropped';
    const deadline = Date.now() + 15_000;
    while (!records.some((r) => r.message === CEILING)) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the ceiling warning');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Long enough for the child to finish writing and the worker to exit, so a
    // SECOND ceiling warning would have been recorded by now if one were going
    // to be.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(records.filter((r) => r.message === CEILING)).toHaveLength(1);
    const stderr = records.filter((r) => r.message === 'Worker stderr');
    expect(stderr).toHaveLength(200);
    // The worker still shut down cleanly: dropping log lines must not look
    // like a crash.
    expect(records.filter((r) => r.message === 'Worker exited normally')).toHaveLength(1);
  }, 30_000);
});
