/**
 * The worker frame fan-out.
 *
 * ## What is under test
 *
 * `WorkerManager` used to have ONE message slot, so a second consumer of the
 * worker frame stream would have displaced the run layer's handler. The
 * session-level exits (compaction, side questions) are exactly such a second
 * consumer, so the slot became a fan-out.
 *
 * The properties that matter:
 *
 * 1. The primary handler still fires. The run layer depends on it.
 * 2. An extra listener fires TOO, and sees the same frame.
 * 3. Unsubscribing stops the delivery. A listener that cannot be removed is
 *    a leak that outlives the request that created it.
 * 4. Replacing the primary handler replaces the PRIMARY, not the others.
 *    The old behaviour was "assign twice, the first is gone"; that has to
 *    survive the refactor, because the run layer relies on it.
 *
 * The frame arrives from a REAL forked child over the REAL IPC channel,
 * because the bug being guarded is about what arrives from outside.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkerManager, type WorkerManagerLogger } from '../src/worker-manager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'message-worker.cjs');

const silentLogger: WorkerManagerLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const managers: WorkerManager[] = [];

function startManager(): WorkerManager {
  const manager = new WorkerManager(
    {
      getState: () => 'IDLE',
      transitionToStreaming: () => undefined,
      transitionToCrashed: () => undefined,
    },
    {
      logger: silentLogger,
      resolveWorkerPath: () => FIXTURE,
      resolveBetterSqlite3Path: () => path.join(HERE, 'no-such-better-sqlite3'),
    },
  );
  managers.push(manager);
  manager.spawnWorker('session-1');
  return manager;
}

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.stopIdleReaper();
    manager.killAll();
  }
  delete process.env.DUYA_TEST_FRAME_TYPE;
  delete process.env.DUYA_TEST_FRAME_HOLD;
});

/** Wait until `count` frames arrived, or fail loudly rather than hang. */
async function waitForFrames(frames: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (frames.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} frames; saw ${frames.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('the worker frame fan-out', () => {
  it('delivers a frame to the primary handler AND to an extra listener', async () => {
    process.env.DUYA_TEST_FRAME_TYPE = 'compact:done';
    process.env.DUYA_TEST_FRAME_HOLD = '1';
    const manager = startManager();
    const primary: Array<{ type: unknown }> = [];
    const extra: Array<{ type: unknown }> = [];
    manager.setMessageHandler((_sessionId, message) => {
      primary.push(message);
    });
    manager.addMessageListener((_sessionId, message) => {
      extra.push(message);
    });

    await waitForFrames(primary, 1);
    await waitForFrames(extra, 1);
    expect(primary[0]?.type).toBe('compact:done');
    expect(extra[0]?.type).toBe('compact:done');
  });

  it('stops delivering to a listener that unsubscribed', async () => {
    process.env.DUYA_TEST_FRAME_TYPE = 'compact:done';
    process.env.DUYA_TEST_FRAME_HOLD = '1';
    const manager = startManager();
    const extra: Array<{ type: unknown }> = [];
    const unsubscribe = manager.addMessageListener((_sessionId, message) => {
      extra.push(message);
    });
    await waitForFrames(extra, 1);
    const seenBefore = extra.length;
    unsubscribe();

    // Give the child time to send more frames; none may arrive after the
    // unsubscribe.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(extra.length).toBe(seenBefore);
  });

  it('replaces the primary handler without touching the other listeners', async () => {
    process.env.DUYA_TEST_FRAME_TYPE = 'compact:done';
    process.env.DUYA_TEST_FRAME_HOLD = '1';
    const manager = startManager();
    const firstPrimary: Array<{ type: unknown }> = [];
    const secondPrimary: Array<{ type: unknown }> = [];
    const extra: Array<{ type: unknown }> = [];
    manager.setMessageHandler((_sessionId, message) => {
      firstPrimary.push(message);
    });
    manager.addMessageListener((_sessionId, message) => {
      extra.push(message);
    });
    manager.setMessageHandler((_sessionId, message) => {
      secondPrimary.push(message);
    });

    await waitForFrames(secondPrimary, 1);
    await waitForFrames(extra, 1);
    // The old behaviour was "assign twice, the first is gone". That has to
    // survive: the run layer assigns once, and a second assignment must not
    // leave two primary handlers running.
    expect(firstPrimary).toHaveLength(0);
  });
});
