/**
 * recorder/hook-worker.ts — unit tests.
 *
 * Drives the shared daemon spawn pipeline with a FakeProcess (same
 * pattern as computer-use-daemon.test.ts). Covers event dispatch,
 * heartbeat passthrough, the restart-once-then-fail policy, and clean
 * stop. No real subprocess is ever spawned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, StdioOptions } from 'node:child_process';

vi.mock('../../logging/logger', () => {
  const noop = () => undefined;
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    time: () => noop,
    timeAsync: async (label: string, fn: () => Promise<unknown>) => fn(),
  };
  return { getLogger: () => logger, LogComponent: { ComputerUse: 'ComputerUse' } };
});

import { RecorderHookWorker } from '../recorder/hook-worker';

class FakeProcess extends EventEmitter {
  pid = 1000 + Math.floor(Math.random() * 1000);
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.emit('exit', null, signal);
    return true;
  }
  pushStdout(text: string): void {
    this.stdout.emit('data', Buffer.from(text, 'utf-8'));
  }
  exit(code: number | null): void {
    this.emit('exit', code, null);
  }
}

function keydownLine(keycode = 30): string {
  return (
    JSON.stringify({
      kind: 'keydown',
      ts: 1,
      keycode,
      name: null,
      char: 'a',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    }) + '\n'
  );
}

function makeSpawnFns() {
  const procs: FakeProcess[] = [];
  const spawnFn = vi.fn(
    (
      _cmd: string,
      args: string[],
      _opts: { stdio: StdioOptions; env: NodeJS.ProcessEnv; cwd?: string },
    ): ChildProcess => {
      const proc = new FakeProcess();
      procs.push(proc);
      void args;
      return proc as unknown as ChildProcess;
    },
  );
  return { procs, spawnFn };
}

/** an existing file path — spawn is mocked, only existsSync matters */
const ENTRY = process.execPath;

function makeWorker(
  spawnFn: ReturnType<typeof makeSpawnFns>['spawnFn'],
  callbacks: Partial<ConstructorParameters<typeof RecorderHookWorker>[0]> = {},
): RecorderHookWorker {
  return new RecorderHookWorker(
    {
      onEvent: () => undefined,
      onFailed: () => undefined,
      onCrash: () => undefined,
      ...callbacks,
    },
    { entryPath: ENTRY, heartbeatTimeoutMs: 1000, spawnFn },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RecorderHookWorker', () => {
  it('dispatches worker events from stdout and reaches running state', async () => {
    const { spawnFn } = makeSpawnFns();
    const events: unknown[] = [];
    const worker = makeWorker(spawnFn, { onEvent: (e) => events.push(e) });
    await worker.start();

    const proc = spawnFn.mock.results[0]?.value as unknown as FakeProcess;
    proc.pushStdout(keydownLine());
    expect(events).toHaveLength(1);
    expect(worker.currentState).toBe('running');
    await worker.stop();
  });

  it('garbage lines do not dispatch and do not crash', async () => {
    const { spawnFn } = makeSpawnFns();
    const events: unknown[] = [];
    const worker = makeWorker(spawnFn, { onEvent: (e) => events.push(e) });
    await worker.start();

    const proc = spawnFn.mock.results[0]?.value as unknown as FakeProcess;
    proc.pushStdout('not json\n');
    proc.pushStdout(keydownLine());
    expect(events).toHaveLength(1);
    await worker.stop();
  });

  it('restarts exactly once after a crash, then fails terminally', async () => {
    const { spawnFn, procs } = makeSpawnFns();
    const failed: string[] = [];
    const crashes: number[] = [];
    const worker = makeWorker(spawnFn, {
      onFailed: (reason) => failed.push(reason),
      onCrash: () => crashes.push(1),
    });
    await worker.start();

    // First crash → one automatic restart (backoff default 1000ms).
    procs[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(crashes).toHaveLength(1);
    expect(failed).toHaveLength(0);
    expect(worker.currentState).not.toBe('failed');

    // Second crash → restart budget spent → terminal failure, no third spawn.
    procs[1]!.exit(1);
    expect(failed).toHaveLength(1);
    expect(worker.currentState).toBe('failed');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('heartbeat timeout kills the worker and consumes the restart budget', async () => {
    const { spawnFn, procs } = makeSpawnFns();
    const failed: string[] = [];
    const worker = makeWorker(spawnFn, { onFailed: (r) => failed.push(r) });
    await worker.start();

    // No heartbeat within the 1s (test) timeout → daemon kills the proc.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000); // restart backoff
    expect(spawnFn).toHaveBeenCalledTimes(2);

    // Restarted worker also never heartbeats → second timeout → failed.
    await vi.advanceTimersByTimeAsync(1000);
    expect(failed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    void procs;
  });

  it('heartbeats keep the worker alive across many timeouts', async () => {
    const { spawnFn } = makeSpawnFns();
    const failed: string[] = [];
    const worker = makeWorker(spawnFn, { onFailed: (r) => failed.push(r) });
    await worker.start();
    const proc = spawnFn.mock.results[0]?.value as unknown as FakeProcess;

    for (let i = 0; i < 5; i++) {
      proc.pushStdout(JSON.stringify({ kind: 'heartbeat', type: 'heartbeat', ts: i }) + '\n');
      await vi.advanceTimersByTimeAsync(900);
    }
    expect(failed).toHaveLength(0);
    expect(worker.currentState).toBe('running');
    await worker.stop();
  });

  it('stop() prevents restarts and reports idle', async () => {
    const { spawnFn, procs } = makeSpawnFns();
    const failed: string[] = [];
    const worker = makeWorker(spawnFn, { onFailed: (r) => failed.push(r) });
    await worker.start();

    await worker.stop();
    procs[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(failed).toHaveLength(0);
    expect(worker.currentState).toBe('idle');
  });

  it('missing entry file fails fast without spawning', async () => {
    const { spawnFn } = makeSpawnFns();
    const failed: string[] = [];
    const worker = new RecorderHookWorker(
      { onEvent: () => undefined, onFailed: (r) => failed.push(r), onCrash: () => undefined },
      { entryPath: 'Z:/does/not/exist/hook-worker-entry.js' },
    );
    await worker.start();
    expect(failed).toHaveLength(1);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
