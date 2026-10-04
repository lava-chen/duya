/**
 * Plan 587 M5.5 -- `startManagedBash` owns its child's lifetime through a
 * `ProcessScope`.
 *
 * Before this slice the function kept four resources in local variables -- the
 * watchdog timer, the `AbortSignal` listener, the output descriptor, and the
 * child itself -- and unwound them by hand on each of its exit paths. This test
 * does not re-assert the command's output (that is what the eval matrix and the
 * bash tool tests are for); it asserts the *ownership* invariant, which is the
 * thing the refactor actually bought.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createProcessScope, type ProcessScope, type ProcessSpawner } from '@duya/agent-runtime';
import type { ChildProcess } from 'node:child_process';

// The module under test reaches for the duya root and the task registry, both
// of which want a real userData directory. Stub them before the import so the
// test stays a unit test.
const registry = {
  register: vi.fn(),
  markKilled: vi.fn(),
  markCompleted: vi.fn(),
  markAutoPromoted: vi.fn(),
  getTask: vi.fn(),
};
vi.mock('../../../session/bash-task-registry.js', () => ({
  getBashTaskRegistry: () => registry,
}));
vi.mock('../../../utils/duyaRoot.js', () => ({
  getBashOutputDir: () => process.cwd(),
}));

const { startManagedBash } = await import('../managed-bash.js');

class FakeChild extends EventEmitter {
  constructor(public pid: number | undefined) {
    super();
  }
}

/** A scope whose spawn is faked, so the test never forks a shell. */
function fakeScope(killTree = vi.fn()): { scope: ProcessScope; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawnFn: ProcessSpawner = () => {
    const child = new FakeChild(4242);
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const scope = createProcessScope({ killTree, spawnFn });
  return { scope, children };
}

const baseParams = {
  taskId: 't1',
  command: 'echo hi',
  shellPath: 'sh',
  shellArgs: ['-c', 'echo hi'],
  cwd: process.cwd(),
  env: process.env,
  foregroundTimeoutMs: 60_000,
};

describe('startManagedBash owns its child through the supplied ProcessScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('releases the scope when the command settles, so no timer or fd outlives it', async () => {
    const { scope, children } = fakeScope();
    const handle = await startManagedBash({ ...baseParams, scope });

    // The scope is holding the child and the watchdog while the command runs.
    expect(scope.childCount).toBe(1);
    expect(scope.timerCount).toBe(1);

    children[0]?.emit('close', 0);
    const completion = await handle.settled;

    expect(completion.status).toBe('completed');
    // The invariant: nothing survives the command.
    expect(scope.disposed).toBe(true);
    expect(scope.timerCount).toBe(0);
    expect(scope.childCount).toBe(0);
  });

  it('reports a spawn failure as `failed` and still disposes', async () => {
    const { scope, children } = fakeScope();
    const handle = await startManagedBash({ ...baseParams, scope });

    // Node emits `error` and then `close` for a shell that does not exist.
    children[0]?.emit('error', new Error('spawn ENOENT'));
    children[0]?.emit('close', null);
    const completion = await handle.settled;

    expect(completion.status).toBe('failed');
    expect(completion.error).toContain('ENOENT');
    expect(scope.disposed).toBe(true);
  });

  it('kills the process tree on cancel, through the scope\'s strategy', async () => {
    const killTree = vi.fn();
    const { scope, children } = fakeScope(killTree);
    const abort = new AbortController();
    const handle = await startManagedBash({ ...baseParams, scope, abortSignal: abort.signal });

    abort.abort();
    // A real kill makes the child exit; the fake needs the same nudge before
    // `settled` can resolve.
    children[0]?.emit('close', null);
    await handle.settled;

    expect(killTree).toHaveBeenCalledWith(4242);
    expect(registry.markKilled).toHaveBeenCalledWith('t1', 'Cancelled');
  });

  it('promotes to background without restarting the child', async () => {
    const { scope, children } = fakeScope();
    const handle = await startManagedBash({ ...baseParams, scope });

    handle.promoteToBackground();

    expect(registry.markAutoPromoted).toHaveBeenCalledWith('t1', baseParams.foregroundTimeoutMs);
    // Same live child: the hand-off must not lose the output file or the PID.
    expect(children).toHaveLength(1);
    expect(scope.disposed).toBe(false);
  });
});
