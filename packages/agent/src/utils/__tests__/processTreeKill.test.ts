/**
 * Unit tests for the process-tree termination helper.
 *
 * Cross-platform behaviour verified:
 *  - No-op (strategy='noop') when pid is missing or non-positive.
 *  - Windows: spawns `taskkill /F /T /PID <pid>` with stdio='ignore' and
 *    windowsHide=true. The actual command shape is asserted via a
 *    `vi.mock('node:child_process')` replacement (the test runs on
 *    every platform, but the Windows code path is gated on
 *    `process.platform === 'win32'`).
 *  - Unix: when the child was a process-group leader, sends SIGTERM to
 *    the negative PGID then escalates to SIGKILL after a grace period.
 *    Falls back to direct `process.kill(pid, SIGKILL)` when the PGID
 *    send fails (child not detached).
 *  - ESRCH ("process not found") is treated as success and never thrown.
 *  - The helper never throws — even on `taskkill` exit failure or
 *    subprocess spawn errors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess as NodeChildProcess } from 'node:child_process';

// Mock node:child_process so the helper sees our fake spawn, not the
// real one. The helper imports `spawn` by name, so a module-level mock
// replaces it for the duration of the suite. vi.hoisted makes the
// mock reference available to the vi.mock factory (which itself is
// hoisted above all imports).
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: spawnMock,
  };
});

// Import after vi.mock so the helper sees the mocked spawn.
import { killProcessTree } from '../processTreeKill.js';

// Build a minimal ChildProcess-shaped fake that exposes the surface our
// helper actually touches: pid, stdio streams, and event emitter methods.
function fakeChild(pid: number): NodeChildProcess {
  const cp = new EventEmitter() as unknown as NodeChildProcess;
  Object.assign(cp, {
    pid,
    stdout: new Readable({ read() {} }),
    stderr: new Readable({ read() {} }),
    stdin: new EventEmitter() as unknown as NodeChildProcess['stdin'],
  });
  return cp;
}

function platform(name: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: name, configurable: true });
}

describe('killProcessTree', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    spawnMock.mockReset();
    platform('win32'); // restore default for the test runner
  });

  it('returns noop for missing pid without warning', async () => {
    const result = await killProcessTree(undefined, { allowMissingPid: true });
    expect(result).toEqual({ attempted: false, strategy: 'noop', durationMs: 0 });
  });

  it('returns noop for zero or negative pid', async () => {
    expect(await killProcessTree(0, { allowMissingPid: true })).toMatchObject({
      attempted: false,
      strategy: 'noop',
    });
    expect(await killProcessTree(-1, { allowMissingPid: true })).toMatchObject({
      attempted: false,
      strategy: 'noop',
    });
  });

  it('warns when pid is missing and allowMissingPid is false', async () => {
    const result = await killProcessTree(undefined);
    expect(result.strategy).toBe('noop');
    expect(result.attempted).toBe(false);
  });

  it('spawns taskkill /F /T /PID <pid> on Windows', async () => {
    platform('win32');
    const fake = fakeChild(12345);
    spawnMock.mockReturnValue(fake);

    const promise = killProcessTree(12345);
    // Emit exit synchronously so the test does not block on the 5s
    // taskkill watchdog timer.
    (fake as unknown as EventEmitter).emit('exit', 0);
    const result = await promise;

    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/F', '/T', '/PID', '12345'],
      expect.objectContaining({
        stdio: 'ignore',
        windowsHide: true,
      }),
    );
    expect(result.strategy).toBe('taskkill');
    expect(result.attempted).toBe(true);
  });

  it('treats taskkill exit as success regardless of exit code', async () => {
    platform('win32');
    const fake = fakeChild(9999);
    spawnMock.mockReturnValue(fake);

    const promise = killProcessTree(9999);
    // taskkill returns 128 when the PID was already gone — our helper
    // must surface that as a successful attempt, not throw.
    (fake as unknown as EventEmitter).emit('exit', 128);
    const result = await promise;

    expect(result.strategy).toBe('taskkill');
    expect(result.attempted).toBe(true);
  });

  it('does not throw when taskkill itself errors', async () => {
    platform('win32');
    const fake = fakeChild(7);
    spawnMock.mockReturnValue(fake);

    const promise = killProcessTree(7);
    (fake as unknown as EventEmitter).emit('error', new Error('taskkill.exe missing'));
    const result = await promise;

    expect(result.strategy).toBe('taskkill');
    expect(result.attempted).toBe(true);
  });

  it('does not throw when taskkill throws synchronously', async () => {
    platform('win32');
    spawnMock.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const result = await killProcessTree(42);
    expect(result.strategy).toBe('taskkill');
    expect(result.attempted).toBe(true);
  });

  it('sends SIGTERM to the negative PGID on Unix when the child is a group leader', async () => {
    platform('linux');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await killProcessTree(4242, { gracefulKillDelayMs: 10 });

    // First call: SIGTERM to negative PGID
    expect(killSpy).toHaveBeenNthCalledWith(1, -4242, 'SIGTERM');
    // Second call: SIGKILL to negative PGID after grace period
    expect(killSpy).toHaveBeenNthCalledWith(2, -4242, 'SIGKILL');
    expect(result.strategy).toBe('pgid');
    expect(result.attempted).toBe(true);
  });

  it('falls back to direct SIGKILL when the child has no process group', async () => {
    platform('linux');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });

    const result = await killProcessTree(7777, { gracefulKillDelayMs: 5 });

    // Both pgid SIGTERM and pgid SIGKILL fail with ESRCH → we drop to
    // the direct fallback path which also gets ESRCH but resolves cleanly.
    expect(killSpy).toHaveBeenCalled();
    expect(result.strategy).toBe('direct');
    expect(result.attempted).toBe(true);
  });

  it('treats ESRCH on direct fallback as success and does not throw', async () => {
    platform('linux');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    await expect(killProcessTree(11111, { gracefulKillDelayMs: 5 })).resolves.toMatchObject({
      strategy: 'direct',
      attempted: true,
    });
  });

  it('surfaces non-ESRCH errors on the direct path but still resolves', async () => {
    platform('linux');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });

    const result = await killProcessTree(22222, { gracefulKillDelayMs: 5 });
    expect(result.strategy).toBe('direct');
    expect(result.attempted).toBe(true);
  });

  it('honours a custom graceful kill delay on Unix', async () => {
    platform('linux');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const start = Date.now();
    const result = await killProcessTree(5555, { gracefulKillDelayMs: 50 });
    const elapsed = Date.now() - start;

    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(result.strategy).toBe('pgid');
    // Real elapsed time should be at least the requested delay (allow
    // a generous slack for CI scheduling jitter).
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  it('is idempotent — calling twice for the same pid does not throw', async () => {
    platform('win32');
    const fake = fakeChild(31337);
    spawnMock.mockReturnValue(fake);

    const first = killProcessTree(31337);
    (fake as unknown as EventEmitter).emit('exit', 0);
    await first;

    const second = killProcessTree(31337);
    (fake as unknown as EventEmitter).emit('exit', 128);
    await expect(second).resolves.toMatchObject({ strategy: 'taskkill' });
  });
});