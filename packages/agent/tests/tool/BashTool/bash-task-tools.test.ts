/**
 * Background shell tasks must answer through the same tools the BashTool result
 * text points at.
 *
 * BashTool tells the model to use `get_task_output` / `kill_task` for the task id
 * it returns (explicit `run_in_background`, and now auto-promoted commands too).
 * Those tools resolve sub-agents through BackgroundAgentLifecycle, while shell
 * commands live in BashTaskRegistry — so without the registry fallback a bash
 * task id came back as `not_found`.
 */

import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GetTaskOutputTool } from '../../../src/tool/BackgroundTaskTool/GetTaskOutputTool.js';
import { KillTaskTool } from '../../../src/tool/BackgroundTaskTool/KillTaskTool.js';
import { getBashTaskRegistry, resetBashTaskRegistry } from '../../../src/session/bash-task-registry.js';
import { detectShellForFamily } from '../../../src/utils/shellDetector.js';

// Keep the sub-agent lifecycle singleton out of the way (and out of the DB):
// the registry fallback is exactly what is under test here.
const state = vi.hoisted(() => ({ lc: null as unknown }));

vi.mock('../../../lifecycle/BackgroundAgentLifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lifecycle/BackgroundAgentLifecycle.js')>();
  state.lc = new actual.BackgroundAgentLifecycle();
  return {
    ...actual,
    getBackgroundAgentLifecycle: () => state.lc,
  };
});

const shellInfo = detectShellForFamily('unix');
const hasShell = shellInfo !== null;

/**
 * Sentinel PID for tasks that only need to *look* running. It must never be
 * this process's own PID: the afterEach guard stops running tasks, and
 * `stopTask` kills the whole tree — passing `process.pid` would make the test
 * suite suicide (vitest reports it as a closed IPC channel, not a failure).
 * A pid that is not alive never reaches `killProcessTree`.
 */
const DEAD_PID = 999_999;

function parse(result: { result: string }): Record<string, any> {
  return JSON.parse(result.result);
}

async function waitFor(predicate: () => boolean, timeoutMs = 6_000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

describe.skipIf(!hasShell)('background shell tasks through the task tools', () => {
  const getTaskOutput = new GetTaskOutputTool();
  const killTask = new KillTaskTool();

  let dir: string;
  let child: ChildProcess | null = null;

  beforeEach(() => {
    resetBashTaskRegistry();
    dir = mkdtempSync(join(tmpdir(), 'duya-bash-task-tools-'));
  });

  afterEach(async () => {
    const registry = getBashTaskRegistry();
    for (const task of registry.listTasks()) {
      if (task.status === 'running') await registry.stopTask(task.id);
    }
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    child = null;
    resetBashTaskRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('snapshots a running shell task with its live output tail', async () => {
    const outputFile = join(dir, 'running.log');
    writeFileSync(outputFile, 'compiling module 1/9\n');

    getBashTaskRegistry().register({
      id: 'bash-live',
      pid: DEAD_PID,
      outputFile,
      command: 'npm run build',
      status: 'running',
      startTime: Date.now(),
      autoPromoted: true,
    });

    const payload = parse(await getTaskOutput.execute({ task_ids: ['bash-live'] }));

    expect(payload.results[0].status).toBe('running');
    expect(payload.results[0].output).toContain('compiling module 1/9');
    expect(payload.results[0].output).toMatch(/do not poll/i);
  });

  it('inlines the output of a finished shell task', async () => {
    const outputFile = join(dir, 'done.log');
    writeFileSync(outputFile, 'build succeeded\n');
    const registry = getBashTaskRegistry();

    registry.register({
      id: 'bash-done',
      pid: DEAD_PID,
      outputFile,
      command: 'npm run build',
      status: 'running',
      startTime: Date.now(),
    });
    registry.markCompleted('bash-done', 0);

    const payload = parse(await getTaskOutput.execute({ task_ids: ['bash-done'] }));

    expect(payload.results[0].status).toBe('completed');
    expect(payload.results[0].output).toContain('build succeeded');
    expect(payload.summary).toContain('1/1');
  });

  it('maps a failed shell task onto the shared failed status', async () => {
    const outputFile = join(dir, 'failed.log');
    writeFileSync(outputFile, 'error: boom\n');
    const registry = getBashTaskRegistry();

    registry.register({
      id: 'bash-failed',
      pid: DEAD_PID,
      outputFile,
      command: 'npm run build',
      status: 'running',
      startTime: Date.now(),
    });
    registry.markCompleted('bash-failed', 1, 'Exit code 1');

    const payload = parse(await getTaskOutput.execute({ task_ids: ['bash-failed'] }));

    expect(payload.results[0].status).toBe('failed');
    expect(payload.results[0].output).toContain('error: boom');
  });

  it('kills a running shell task and reports already_exited afterwards', async () => {
    const outputFile = join(dir, 'killed.log');
    writeFileSync(outputFile, '');
    const registry = getBashTaskRegistry();

    child = spawn(shellInfo!.path, ['-c', 'sleep 20'], { stdio: 'ignore', windowsHide: true });
    await waitFor(() => child?.pid !== undefined, 2_000);

    registry.register({
      id: 'bash-kill',
      pid: child.pid ?? -1,
      outputFile,
      command: 'sleep 20',
      status: 'running',
      startTime: Date.now(),
    });

    const killed = parse(await killTask.execute({ task_id: 'bash-kill' }));
    expect(killed.outcome).toBe('killed');
    expect(registry.getTask('bash-kill')?.status).toBe('killed');

    const exited = await waitFor(() => child?.exitCode !== null || child?.signalCode !== null);
    expect(exited).toBe(true);

    const again = parse(await killTask.execute({ task_id: 'bash-kill' }));
    expect(again.outcome).toBe('already_exited');
  });

  it('reports not_found for an id tracked by neither registry', async () => {
    const payload = parse(await killTask.execute({ task_id: 'nope' }));
    expect(payload.outcome).toBe('not_found');

    const snapshot = parse(await getTaskOutput.execute({ task_ids: ['nope'] }));
    expect(snapshot.results[0].status).toBe('not_found');
  });
});
