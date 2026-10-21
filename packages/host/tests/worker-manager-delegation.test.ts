import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { WorkerManager, type WorkerManagerLogger } from '../src/worker-manager.js';

const SESSION_ID = 'delegation-session';

function recordingLogger(): WorkerManagerLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function nextMessage(
  child: ChildProcess,
  predicate: (message: Record<string, unknown>) => boolean,
  description: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${description}`));
    }, 10_000);
    const onMessage = (value: unknown) => {
      if (typeof value !== 'object' || value === null || !predicate(value as Record<string, unknown>)) return;
      clearTimeout(timeout);
      child.off('message', onMessage);
      resolve(value as Record<string, unknown>);
    };
    child.on('message', onMessage);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Worker ${child.pid ?? '<unknown>'} did not exit`)), 10_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('WorkerManager stale-worker delegation boundary', () => {
  it('refuses stale session:spawn requests while retaining background drain handling', async () => {
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'duya-worker-delegation-'));
    const fixturePath = path.join(fixtureDir, 'fixture.cjs');
    await writeFile(fixturePath, `
      process.on('message', (command) => {
        if (!command || typeof command !== 'object') return;
        if (command.type === 'test:emit') {
          process.send(command.message);
          process.send({ type: 'test:ack', id: command.id });
        } else if (command.type === 'test:exit') {
          process.exit(0);
        } else if (command.type === 'db:response') {
          process.send({ type: 'test:received', message: command });
        }
      });
      process.send({ type: 'test:ready' });
    `);

    const forwarded: Array<{ sessionId: string; message: Record<string, unknown> }> = [];
    const manager = new WorkerManager(
      {
        getState: () => 'IDLE',
        transitionToStreaming: () => undefined,
        transitionToCrashed: () => undefined,
      },
      {
        logger: recordingLogger(),
        resolveWorkerPath: () => fixturePath,
        resolveBetterSqlite3Path: () => path.join(fixtureDir, 'unused-better-sqlite3'),
      },
    );
    manager.setMessageHandler((sessionId, message) => forwarded.push({ sessionId, message }));

    const children: ChildProcess[] = [];
    try {
      const oldChild = manager.spawnWorker(SESSION_ID);
      children.push(oldChild);
      await nextMessage(oldChild, (message) => message.type === 'test:ready', 'old worker ready');

      const oldDrainAck = nextMessage(oldChild, (message) => message.type === 'test:ack' && message.id === 'old-drain', 'old worker drain report');
      oldChild.send({
        type: 'test:emit',
        id: 'old-drain',
        message: { type: 'background_tasks:update', inFlight: 1 },
      });
      await oldDrainAck;

      const replacement = manager.spawnWorker(SESSION_ID);
      children.push(replacement);
      await nextMessage(replacement, (message) => message.type === 'test:ready', 'replacement worker ready');
      expect(manager.getWorker(SESSION_ID)).toBe(replacement);

      const staleId = 'stale-spawn-request';
      const staleResponse = nextMessage(oldChild, (message) =>
        message.type === 'test:received' &&
        (message.message as Record<string, unknown> | undefined)?.id === staleId,
      'stale request response');
      oldChild.send({
        type: 'test:emit',
        id: 'stale-spawn',
        message: {
          type: 'db:request',
          id: staleId,
          action: 'session:spawnChild',
          execution: { sessionId: SESSION_ID, runId: 'run-old', epoch: 3 },
        },
      });
      const received = await staleResponse;
      expect(received.message).toMatchObject({
        type: 'db:response',
        id: staleId,
        success: false,
        error: expect.stringContaining('superseded worker'),
      });
      expect(forwarded.some(({ message }) => message.type === 'db:request' && message.id === staleId)).toBe(false);

      // The stale worker's background-task control message remains active while
      // it drains; it is consumed by WorkerManager and never reaches the Host handler.
      const keepDrainingAck = nextMessage(oldChild, (message) => message.type === 'test:ack' && message.id === 'old-still-draining', 'draining worker update');
      oldChild.send({
        type: 'test:emit',
        id: 'old-still-draining',
        message: { type: 'background_tasks:update', inFlight: 2 },
      });
      await keepDrainingAck;
      expect(forwarded.some(({ message }) => message.type === 'background_tasks:update')).toBe(false);

      const oldExit = waitForExit(oldChild);
      oldChild.send({
        type: 'test:emit',
        id: 'old-drained',
        message: { type: 'background_tasks:update', inFlight: 0 },
      });
      await oldExit;

      const currentMessage = { type: 'probe:current-worker', value: 'still-forwarded' };
      replacement.send({ type: 'test:emit', id: 'current-probe', message: currentMessage });
      await waitUntil(
        () => forwarded.some(({ sessionId, message }) => sessionId === SESSION_ID && message.type === currentMessage.type),
        'current worker message forwarding',
      );
      expect(manager.getWorker(SESSION_ID)).toBe(replacement);
    } finally {
      manager.stopIdleReaper();
      const exits = children.map(waitForExit);
      manager.killAll();
      await Promise.all(exits);
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
