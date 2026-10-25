import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';

import { WorkerManager, type WorkerManagerLogger, type WorkerSessionLifecycle } from '../src/worker-manager.js';

function recordingLogger(): WorkerManagerLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/**
 * A lifecycle the test drives by hand: the real one projects the session
 * registry, and the states `waitForWorkersToSettle` reads are its two
 * mid-turn values.
 */
function manualLifecycle(initial: string): WorkerSessionLifecycle & { set(state: string): void } {
  let state = initial;
  return {
    set(next: string): void {
      state = next;
    },
    getState: () => state,
    transitionToStreaming: () => undefined,
    transitionToCrashed: () => undefined,
  };
}

describe('WorkerManager.waitForWorkersToSettle', () => {
  const children: ChildProcess[] = [];
  let fixtureDir = '';
  let fixturePath = '';

  afterAll(async () => {
    for (const child of children) {
      child.kill();
    }
    if (fixtureDir !== '') await rm(fixtureDir, { recursive: true, force: true });
  });

  it('resolves immediately when no supervised worker exists', async () => {
    const manager = new WorkerManager(manualLifecycle('IDLE'), {
      logger: recordingLogger(),
      resolveWorkerPath: () => 'unused.js',
      resolveBetterSqlite3Path: () => 'unused.node',
    });

    expect(manager.hasActiveTurn()).toBe(false);
    expect(await manager.waitForWorkersToSettle(5_000, 10)).toBe('settled');
  });

  it('times out while a worker is mid-turn, then settles when it is done', async () => {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'duya-worker-settle-'));
    fixturePath = path.join(fixtureDir, 'fixture.cjs');
    // The fixture only has to stay alive: `waitForWorkersToSettle` reads the
    // injected lifecycle, not worker traffic.
    await writeFile(fixturePath, 'setInterval(() => undefined, 1_000);\n');

    const lifecycle = manualLifecycle('STREAMING');
    const manager = new WorkerManager(lifecycle, {
      logger: recordingLogger(),
      resolveWorkerPath: () => fixturePath,
      resolveBetterSqlite3Path: () => path.join(fixtureDir, 'unused-better-sqlite3'),
    });

    const child = manager.spawnWorker('settle-session');
    children.push(child);

    expect(manager.hasActiveTurn()).toBe(true);
    const startedAt = Date.now();
    expect(await manager.waitForWorkersToSettle(400, 25)).toBe('timeout');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);

    // The turn finished: the next wait reports settled instead of running to
    // its own cap.
    lifecycle.set('IDLE');
    expect(await manager.waitForWorkersToSettle(5_000, 25)).toBe('settled');
  }, 15_000);

  it('settles before the cap when the turn ends during the wait', async () => {
    fixtureDir = fixtureDir === '' ? await mkdtemp(path.join(os.tmpdir(), 'duya-worker-settle2-')) : fixtureDir;
    if (fixturePath === '') {
      fixturePath = path.join(fixtureDir, 'fixture2.cjs');
      await writeFile(fixturePath, 'setInterval(() => undefined, 1_000);\n');
    }
    const lifecycle = manualLifecycle('COMPLETING');
    const manager = new WorkerManager(lifecycle, {
      logger: recordingLogger(),
      resolveWorkerPath: () => fixturePath,
      resolveBetterSqlite3Path: () => path.join(fixtureDir, 'unused-better-sqlite3'),
    });

    const child = manager.spawnWorker('settle-session-2');
    children.push(child);

    const wait = manager.waitForWorkersToSettle(10_000, 20);
    setTimeout(() => lifecycle.set('IDLE'), 150);
    const startedAt = Date.now();
    expect(await wait).toBe('settled');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 15_000);
});
