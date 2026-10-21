/**
 * Plan 587 M5.5 -- `ProcessScope` owns a spawned child's whole lifetime.
 *
 * These assertions exist because the three call sites this replaces each had to
 * remember the same four things by hand: clear the timer, drop the listener,
 * close the descriptor, and kill the tree. Each one shipped a variant that
 * worked until an exit path was added later. So the tests here are about the
 * *bookkeeping invariants*, not about `child_process` -- the spawn is injected,
 * which is also what keeps the suite from forking anything.
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createProcessScope, type ProcessScopeOptions } from '@duya/agent-runtime';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

/** A `ChildProcess` stand-in: the scope only ever touches pid + events. */
class FakeChild extends EventEmitter {
  constructor(public pid: number | undefined) {
    super();
  }
}

function harness(overrides: Partial<ProcessScopeOptions> = {}): {
  scope: ReturnType<typeof createProcessScope>;
  spawned: FakeChild[];
  killed: (number | undefined)[];
} {
  const spawned: FakeChild[] = [];
  const killed: (number | undefined)[] = [];
  const spawnFn = vi.fn((_command: string, _args: readonly string[], _opts: SpawnOptions) => {
    const child = new FakeChild(spawned.length + 1000);
    spawned.push(child);
    return child as unknown as ChildProcess;
  });
  const scope = createProcessScope({
    killTree: (pid) => {
      killed.push(pid);
    },
    spawnFn,
    ...overrides,
  });
  return { scope, spawned, killed };
}

describe('ProcessScope', () => {
  it('releases every timer it armed', async () => {
    const { scope } = harness();
    scope.setTimeout(() => {}, 60_000);
    scope.setInterval(() => {}, 1_000);
    expect(scope.timerCount).toBe(2);

    await scope.dispose();

    expect(scope.timerCount).toBe(0);
  });

  it('kills every child it spawned, and nothing survives a rejected kill', async () => {
    // A killer that throws for the first pid and succeeds for the second is the
    // real hazard: a single `for` loop with an `await` inside would strand the
    // second child.
    const killed: (number | undefined)[] = [];
    const { scope, spawned } = harness({
      killTree: (pid) => {
        killed.push(pid);
        if (pid === spawned[0]?.pid) throw new Error('ESRCH: no such process');
      },
    });
    scope.spawn('a', []);
    scope.spawn('b', []);

    await expect(scope.dispose()).resolves.toBeUndefined();

    expect(killed).toEqual([spawned[0]?.pid, spawned[1]?.pid]);
  });

  it('is idempotent: a second dispose does not re-kill', async () => {
    const { scope, spawned, killed } = harness();
    scope.spawn('a', []);

    await scope.dispose();
    await scope.dispose();

    expect(killed).toEqual([spawned[0]?.pid]);
  });

  it('refuses to start new work after dispose', async () => {
    const { scope } = harness();
    await scope.dispose();

    expect(scope.disposed).toBe(true);
    expect(() => scope.spawn('a', [])).toThrow(/after dispose/);
    expect(() => scope.setTimeout(() => {}, 1)).toThrow(/after dispose/);
    expect(() => scope.setInterval(() => {}, 1)).toThrow(/after dispose/);
  });

  it('runs a tracked closer registered after dispose instead of dropping it', async () => {
    const { scope } = harness();
    await scope.dispose();

    const closer = vi.fn();
    scope.track(closer);

    // Dropping it would leak the very resource the scope exists to release.
    expect(closer).toHaveBeenCalledTimes(1);
  });

  it('settles `exited` once when a child emits both error and close', async () => {
    const { scope, spawned } = harness();
    const handle = scope.spawn('a', []);
    const onSettled = vi.fn();
    void handle.exited.then(onSettled);

    // This is exactly what Node does for a spawn that never started.
    spawned[0]?.emit('error', new Error('ENOENT'));
    spawned[0]?.emit('close', null);
    await handle.exited;

    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('drops a child from the scope once it exits on its own', async () => {
    const { scope, spawned } = harness();
    scope.spawn('a', []);
    expect(scope.childCount).toBe(1);

    spawned[0]?.emit('close', 0);
    await Promise.resolve();

    // A child that already exited must not be killed again at dispose time.
    expect(scope.childCount).toBe(0);
  });

  it('detaches an onExit listener on dispose, so a dead child retains nothing', async () => {
    const { scope, spawned } = harness();
    const handle = scope.spawn('a', []);
    const listener = vi.fn();
    scope.onExit(handle, listener);

    await scope.dispose();
    spawned[0]?.emit('close', 0);

    expect(spawned[0]?.listenerCount('close')).toBe(0);
  });

  it('stops counting a one-shot timer once it has fired', async () => {
    vi.useFakeTimers();
    try {
      const { scope } = harness();
      scope.setTimeout(() => {}, 10);
      expect(scope.timerCount).toBe(1);

      vi.advanceTimersByTime(20);

      expect(scope.timerCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a single timer without touching the others', async () => {
    const { scope } = harness();
    const fired = vi.fn();
    scope.setTimeout(fired, 10);
    const keep = scope.setTimeout(() => {}, 60_000);
    expect(scope.timerCount).toBe(2);

    keep.cancel();

    expect(scope.timerCount).toBe(1);
    await scope.dispose();
    expect(fired).not.toHaveBeenCalled();
  });
});
