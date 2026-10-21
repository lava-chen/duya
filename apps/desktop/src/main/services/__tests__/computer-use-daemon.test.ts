/**
 * computer-use-daemon.ts — unit tests.
 *
 * Uses a fake spawn factory (returns an EventEmitter standing in for
 * a ChildProcess) so we don't actually fork node. Covers heartbeat
 * parsing, exit-driven restart scheduling, backoff growth + cap,
 * stderr forwarding, and the onHealth broadcast contract.
 *
 * Plan 453 Task D.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, StdioOptions } from 'node:child_process';

import {
  __resetComputerUseDaemon,
  setComputerUseDaemonOptions,
  getComputerUseDaemon,
  type ComputerUseDaemonOptions,
  type ComputerUseHealth,
} from '../computer-use-daemon';

// --- Fake process --------------------------------------------------------

class FakeProcess extends EventEmitter {
  pid = 1000 + Math.floor(Math.random() * 1000);
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.emit('exit', null, signal);
    return true;
  }
  pushStdout(text: string): void {
    this.stdout.emit('data', Buffer.from(text, 'utf-8'));
  }
  pushStderr(text: string): void {
    this.stderr.emit('data', Buffer.from(text, 'utf-8'));
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

function makeSpawnFn() {
  const proc = new FakeProcess();
  const spawnFn = vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: { stdio: StdioOptions; env: NodeJS.ProcessEnv; cwd?: string },
    ): ChildProcess => proc as unknown as ChildProcess,
  );
  return { proc, spawnFn };
}

// --- Helpers -------------------------------------------------------------

function defaultOpts(overrides: Partial<ComputerUseDaemonOptions> = {}): ComputerUseDaemonOptions {
  return {
    entry: 'C:/fake/entry.js',
    backoffInitialMs: 10,
    backoffMaxMs: 1000,
    backoffMultiplier: 2,
    heartbeatTimeoutMs: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetComputerUseDaemon();
});

afterEach(() => {
  vi.useRealTimers();
  __resetComputerUseDaemon();
});

describe('ComputerUseDaemon', () => {
  it('throws if getComputerUseDaemon called before init', () => {
    expect(() => getComputerUseDaemon()).toThrow();
  });

  it('start() spawns the entry and reports running', async () => {
    const { spawnFn, proc } = makeSpawnFn();
    setComputerUseDaemonOptions(defaultOpts({ spawnFn }));

    const daemon = getComputerUseDaemon();
    await daemon.start();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(daemon.getHealth().running).toBe(true);
    expect(daemon.getHealth().pid).toBe(proc.pid);
    expect(daemon.getHealth().lastError).toBeNull();
  });

  it('onHealth fires immediately with current state on subscribe', () => {
    const { spawnFn } = makeSpawnFn();
    setComputerUseDaemonOptions(defaultOpts({ spawnFn }));
    const daemon = getComputerUseDaemon();

    const received: ComputerUseHealth[] = [];
    daemon.onHealth((h) => received.push(h));
    expect(received).toHaveLength(1);
    expect(received[0].running).toBe(false);
  });

  it('emits health updates on heartbeat', async () => {
    const { spawnFn, proc } = makeSpawnFn();
    setComputerUseDaemonOptions(defaultOpts({ spawnFn }));
    const daemon = getComputerUseDaemon();
    await daemon.start();

    const received: ComputerUseHealth[] = [];
    daemon.onHealth((h) => received.push(h));

    proc.pushStdout(
      JSON.stringify({ type: 'heartbeat', schemaVersion: '0.4.0' }) + '\n',
    );
    expect(received.length).toBeGreaterThan(0);
    const last = received[received.length - 1];
    expect(last.schemaVersion).toBe('0.4.0');
    expect(last.running).toBe(true);
  });

  it('parses multiple heartbeats on the same chunk', async () => {
    const { spawnFn, proc } = makeSpawnFn();
    setComputerUseDaemonOptions(defaultOpts({ spawnFn }));
    const daemon = getComputerUseDaemon();
    await daemon.start();

    const received: ComputerUseHealth[] = [];
    daemon.onHealth((h) => received.push(h));

    proc.pushStdout(
      JSON.stringify({ type: 'heartbeat', schemaVersion: '0.4.0' }) +
        '\n' +
        JSON.stringify({ type: 'heartbeat', schemaVersion: '0.4.1' }) +
        '\n',
    );

    expect(received.some((h) => h.schemaVersion === '0.4.1')).toBe(true);
  });

  it('forwards stderr lines as error logs', async () => {
    const { spawnFn, proc } = makeSpawnFn();
    setComputerUseDaemonOptions(defaultOpts({ spawnFn }));
    const daemon = getComputerUseDaemon();
    await daemon.start();

    // Should not throw; the daemon should log the stderr line.
    expect(() => proc.pushStderr('something failed\n')).not.toThrow();
  });

  it('restart on non-expected exit uses exponential backoff', async () => {
    const spawnFn = vi.fn();
    const proc1 = new FakeProcess();
    const proc2 = new FakeProcess();
    spawnFn.mockReturnValueOnce(proc1 as unknown as ChildProcess);
    spawnFn.mockReturnValueOnce(proc2 as unknown as ChildProcess);
    spawnFn.mockReturnValue(proc2 as unknown as ChildProcess); // any further calls

    setComputerUseDaemonOptions(
      defaultOpts({
        spawnFn,
        backoffInitialMs: 10,
        backoffMaxMs: 100,
        backoffMultiplier: 3,
      }),
    );
    const daemon = getComputerUseDaemon();
    await daemon.start();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(daemon.getHealth().running).toBe(true);

    // Crash the daemon.
    proc1.exit(1);

    // Restart scheduled with backoff = 10ms.
    expect(daemon.getHealth().nextRestartInMs).toBe(10);
    expect(daemon.getHealth().restartCount).toBe(1);
    expect(daemon.getHealth().running).toBe(false);

    // Advance the timer; new proc spawns.
    await vi.advanceTimersByTimeAsync(10);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(daemon.getHealth().running).toBe(true);

    // Crash again; backoff grows 10 → 30.
    proc2.exit(2);
    expect(daemon.getHealth().nextRestartInMs).toBe(30);
    expect(daemon.getHealth().restartCount).toBe(2);

    // Third crash: 30 → 90 (still under cap).
    await vi.advanceTimersByTimeAsync(30);
    const proc3 = (spawnFn.mock.results[2]?.value as FakeProcess) ?? null;
    proc3?.exit(3);
    expect(daemon.getHealth().nextRestartInMs).toBe(90);
  });

  it('caps backoff at backoffMaxMs', async () => {
    const spawnFn = vi.fn();
    const proc = new FakeProcess();
    spawnFn.mockReturnValue(proc as unknown as ChildProcess);

    setComputerUseDaemonOptions(
      defaultOpts({
        spawnFn,
        backoffInitialMs: 10,
        backoffMaxMs: 50,
        backoffMultiplier: 4,
      }),
    );
    const daemon = getComputerUseDaemon();
    await daemon.start();

    proc.exit(1);
    expect(daemon.getHealth().nextRestartInMs).toBe(10);
    await vi.advanceTimersByTimeAsync(10);
    proc.exit(1);
    // 10 * 4 = 40 < 50
    expect(daemon.getHealth().nextRestartInMs).toBe(40);
    await vi.advanceTimersByTimeAsync(40);
    proc.exit(1);
    // 40 * 4 = 160 → capped at 50
    expect(daemon.getHealth().nextRestartInMs).toBe(50);
  });

  it('a successful heartbeat resets the backoff', async () => {
    const spawnFn = vi.fn();
    const proc1 = new FakeProcess();
    const proc2 = new FakeProcess();
    spawnFn.mockReturnValueOnce(proc1 as unknown as ChildProcess);
    spawnFn.mockReturnValueOnce(proc2 as unknown as ChildProcess);
    spawnFn.mockReturnValue(proc2 as unknown as ChildProcess);

    setComputerUseDaemonOptions(
      defaultOpts({
        spawnFn,
        backoffInitialMs: 10,
        backoffMaxMs: 100,
        backoffMultiplier: 3,
      }),
    );
    const daemon = getComputerUseDaemon();
    await daemon.start();

    proc1.exit(1);
    expect(daemon.getHealth().nextRestartInMs).toBe(10);
    await vi.advanceTimersByTimeAsync(10);

    // New process: send a heartbeat to reset backoff.
    proc2.pushStdout(
      JSON.stringify({ type: 'heartbeat', schemaVersion: '0.4.0' }) + '\n',
    );
    proc2.exit(1);
    // Backoff resets to 10 after heartbeat.
    expect(daemon.getHealth().nextRestartInMs).toBe(10);
  });

  it('stop() prevents further restarts', async () => {
    const spawnFn = vi.fn();
    const proc = new FakeProcess();
    spawnFn.mockReturnValue(proc as unknown as ChildProcess);

    setComputerUseDaemonOptions(defaultOpts({ spawnFn }));
    const daemon = getComputerUseDaemon();
    await daemon.start();

    await daemon.stop();
    expect(daemon.getHealth().running).toBe(false);

    proc.exit(1);
    expect(daemon.getHealth().nextRestartInMs).toBeNull();
  });

  it('start() is idempotent', async () => {
    const { spawnFn } = makeSpawnFn();
    setComputerUseDaemonOptions(defaultOpts({ spawnFn }));
    const daemon = getComputerUseDaemon();

    await daemon.start();
    await daemon.start();
    await daemon.start();

    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});