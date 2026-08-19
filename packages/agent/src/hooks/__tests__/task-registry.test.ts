/**
 * HookTaskRegistry tests — lifecycle, output reads, kill, finalize, cleanup.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { HookTaskRegistry, type HookBackgroundTask } from '../task-registry.js';

function mkTask(overrides: Partial<HookBackgroundTask> = {}): HookBackgroundTask {
  return {
    id: 'hook-t1',
    event: 'UserPromptSubmit',
    hookType: 'command',
    command: 'echo hi',
    sessionId: 's1',
    rewake: true,
    pid: 1234,
    outputFile: '/tmp/out.log',
    status: 'running',
    startTime: Date.now(),
    ...overrides,
  };
}

describe('HookTaskRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers and lists tasks, notifying change listeners', () => {
    const registry = new HookTaskRegistry();
    const listener = vi.fn();
    registry.onAnyChange(listener);
    registry.register(mkTask());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.listTasks()).toHaveLength(1);
    expect(registry.listRunningTasks()).toHaveLength(1);
    expect(registry.getTask('hook-t1')?.status).toBe('running');
  });

  it('marks completed tasks and moves them out of running', () => {
    const registry = new HookTaskRegistry();
    registry.register(mkTask());
    registry.markCompleted('hook-t1', 0);
    const task = registry.getTask('hook-t1');
    expect(task?.status).toBe('completed');
    expect(task?.endTime).toBeDefined();
    expect(task?.exitCode).toBe(0);
    expect(registry.listRunningTasks()).toHaveLength(0);
  });

  it('marks non-zero exits as error and killed tasks as killed', () => {
    const registry = new HookTaskRegistry();
    registry.register(mkTask());
    registry.markCompleted('hook-t1', 2, 'exited with code 2');
    expect(registry.getTask('hook-t1')?.status).toBe('error');

    registry.register(mkTask({ id: 'hook-t2' }));
    registry.markKilled('hook-t2', 'Stopped');
    expect(registry.getTask('hook-t2')?.status).toBe('killed');
  });

  it('ignores settlement of unknown or already-settled tasks', () => {
    const registry = new HookTaskRegistry();
    registry.register(mkTask());
    registry.markKilled('hook-t1', 'first');
    registry.markCompleted('hook-t1', 0); // no-op — already killed
    expect(registry.getTask('hook-t1')?.status).toBe('killed');
    registry.markCompleted('nope', 0); // no throw
  });

  it('stopTask kills running tasks and reports status', async () => {
    const registry = new HookTaskRegistry();
    // Use a real child so the PID exists; kill must not throw.
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    registry.register(mkTask({ id: 'hook-kill', pid: child.pid ?? -1 }));
    const result = await registry.stopTask('hook-kill');
    expect(result.success).toBe(true);
    expect(registry.getTask('hook-kill')?.status).toBe('killed');
    child.kill();
  });

  it('stopTask on an unknown task fails gracefully', async () => {
    const registry = new HookTaskRegistry();
    const result = await registry.stopTask('ghost');
    expect(result.success).toBe(false);
  });

  it('finalizeAll kills every running task', async () => {
    const registry = new HookTaskRegistry();
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    registry.register(mkTask({ id: 'hook-a', pid: child.pid ?? -1 }));
    registry.register(mkTask({ id: 'hook-b', pid: child.pid ?? -1 }));
    registry.markCompleted('hook-b', 0); // already settled — must survive
    await registry.finalizeAll('session teardown');
    expect(registry.getTask('hook-a')?.status).toBe('killed');
    expect(registry.getTask('hook-b')?.status).toBe('completed');
    child.kill();
  });

  it('readOutput returns null for unknown tasks or missing files', () => {
    const registry = new HookTaskRegistry();
    expect(registry.readOutput('ghost')).toBeNull();
    registry.register(mkTask());
    expect(registry.readOutput('hook-t1')).toBeNull();
  });

  it('evicts terminal tasks after the TTL', async () => {
    vi.useFakeTimers();
    const registry = new HookTaskRegistry();
    registry.register(mkTask());
    registry.markCompleted('hook-t1', 0);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    expect(registry.getTask('hook-t1')).toBeUndefined();
    vi.useRealTimers();
  });
});
