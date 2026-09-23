/**
 * Foreground soft-yield (auto-promotion) contract.
 *
 * BashTool starts every command as a managed background task and only decides
 * how long to wait for it. A foreground call that outlives BASH_SOFT_YIELD_MS
 * hands the still-running task id back to the model — the process is NOT
 * restarted, so its PID and output file stay valid and the completion is
 * delivered asynchronously.
 *
 * The real-shell block is skipped when no Unix-compatible shell is available
 * (bare Windows CI), matching BashTool's own "shell unavailable" contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { BashTool } from '../../../src/tool/BashTool/BashTool.js';
import { raceCompletionWithSoftYield } from '../../../src/tool/BashTool/soft-yield.js';
import { BASH_SOFT_YIELD_MS } from '../../../src/tool/BashTool/constants.js';
import { getBashTaskRegistry, resetBashTaskRegistry } from '../../../src/session/bash-task-registry.js';
import { detectShellForFamily } from '../../../src/utils/shellDetector.js';

const hasShell = detectShellForFamily('unix') !== null;

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 6_000,
  stepMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

describe('raceCompletionWithSoftYield', () => {
  it('defaults to a 15s window', () => {
    expect(BASH_SOFT_YIELD_MS).toBe(15_000);
  });

  it('returns the completion when it settles inside the window', async () => {
    await expect(raceCompletionWithSoftYield(Promise.resolve('done'), 5_000)).resolves.toBe('done');
  });

  it('returns undefined when the window elapses first', async () => {
    let lateResolved = false;
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => {
        lateResolved = true;
        resolve('late');
      }, 250);
    });

    const started = Date.now();
    const result = await raceCompletionWithSoftYield(slow, 20);

    expect(result).toBeUndefined();
    // Yielded at the window, not at completion time.
    expect(Date.now() - started).toBeLessThan(200);
    // The losing branch is left alone — it must still be free to settle.
    await slow;
    expect(lateResolved).toBe(true);
  });

  it('awaits the completion when yielding is disabled', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 30));
    await expect(raceCompletionWithSoftYield(slow, 0)).resolves.toBe('late');
  });

  it('awaits the completion for non-finite windows', async () => {
    await expect(raceCompletionWithSoftYield(Promise.resolve('now'), Number.NaN)).resolves.toBe('now');
  });
});

describe.skipIf(!hasShell)('BashTool foreground soft yield (real shell)', () => {
  beforeEach(() => {
    resetBashTaskRegistry();
  });

  afterEach(async () => {
    // Never leave a real child process behind on a failing assertion.
    const registry = getBashTaskRegistry();
    for (const task of registry.listTasks()) {
      if (task.status === 'running') await registry.stopTask(task.id);
    }
    resetBashTaskRegistry();
  });

  it('returns output inline when the command finishes inside the window', async () => {
    const tool = new BashTool({ softYieldMs: 4_000 });
    const result = await tool.execute({ command: 'echo soft-yield-fast' });

    expect(result.error).toBeFalsy();
    expect(result.result).toContain('soft-yield-fast');
    expect(result.metadata?.autoPromoted).toBeUndefined();
    expect(result.metadata?.exitCode).toBe(0);
  });

  it('auto-promotes a still-running command without restarting it', async () => {
    const tool = new BashTool({ softYieldMs: 150 });

    const started = Date.now();
    const result = await tool.execute({ command: 'sleep 1; echo soft-yield-done' });
    const yieldedAfter = Date.now() - started;

    // Yielded near the window, not near completion / the 120s default timeout.
    expect(yieldedAfter).toBeLessThan(900);

    expect(result.metadata?.autoPromoted).toBe(true);
    const taskId = result.metadata?.taskId as string;
    expect(typeof taskId).toBe('string');
    expect(result.result).toContain(`background task ${taskId}`);
    expect(result.result).toContain('Do NOT re-run');
    expect(result.result).toContain('kill_task');

    // The process was handed over live: registered, running, promoted.
    const registry = getBashTaskRegistry();
    const task = registry.getTask(taskId);
    expect(task?.status).toBe('running');
    expect(task?.autoPromoted).toBe(true);
    expect(task?.pid).toBeGreaterThan(0);

    // ...and it keeps running to completion on its own.
    const finished = await waitFor(() => registry.getTask(taskId)?.status !== 'running');
    expect(finished).toBe(true);
    const settled = registry.getTask(taskId);
    expect(settled?.status).toBe('completed');
    expect(settled?.exitCode).toBe(0);
    expect(registry.readOutput(taskId)?.text).toContain('soft-yield-done');
  });

  it('keeps a promoted command alive past the foreground timeout', async () => {
    // Foreground ceiling would kill this at 400ms; promotion at 150ms moves it
    // to the background ceiling so the command finishes instead of dying.
    const tool = new BashTool({ softYieldMs: 150 });
    const result = await tool.execute({ command: 'sleep 1; echo survived', timeout: 400 });

    expect(result.metadata?.autoPromoted).toBe(true);
    const taskId = result.metadata?.taskId as string;
    const registry = getBashTaskRegistry();

    const finished = await waitFor(() => registry.getTask(taskId)?.status !== 'running');
    expect(finished).toBe(true);
    expect(registry.getTask(taskId)?.status).toBe('completed');
    expect(registry.readOutput(taskId)?.text).toContain('survived');
  });

  it('still kills a foreground command that outlives its own timeout', async () => {
    // Window is wider than the timeout, so the watchdog — not the yield — wins.
    const tool = new BashTool({ softYieldMs: 10_000 });
    const result = await tool.execute({ command: 'sleep 5', timeout: 400 });

    expect(result.error).toBe(true);
    expect(result.metadata?.timeout).toBe(true);
    expect(result.result).toContain('timed out');
    expect(result.metadata?.autoPromoted).toBeUndefined();

    const registry = getBashTaskRegistry();
    const task = registry.getTask(result.metadata?.taskId as string);
    expect(task?.status).not.toBe('running');
    expect(task?.error).toContain('Timed out');
  });

  it('never auto-promotes an explicit run_in_background task', async () => {
    const tool = new BashTool({ softYieldMs: 150 });
    const result = await tool.execute({ command: 'sleep 1', run_in_background: true });

    expect(result.metadata?.backgrounded).toBe(true);
    expect(result.metadata?.autoPromoted).toBeUndefined();

    const task = getBashTaskRegistry().getTask(result.metadata?.taskId as string);
    expect(task?.status).toBe('running');
    expect(task?.autoPromoted).toBeUndefined();
  });
});
