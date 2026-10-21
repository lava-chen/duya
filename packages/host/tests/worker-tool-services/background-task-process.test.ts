import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GetTaskOutputTool, KillTaskTool } from '@duya/capabilities/background-task-tool';
import { BashTaskRegistry } from '../../src/managed-shell/task-registry.js';
import { BackgroundAgentLifecycle } from '../../src/worker-subagents/background-lifecycle.js';
import { createWorkerBackgroundTaskPort } from '../../src/worker-tool-services/background-task.js';

function parse(result: { result: string }): Record<string, unknown> {
  return JSON.parse(result.result) as Record<string, unknown>;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe('Host background shell tool path', () => {
  let directory: string;
  let child: ChildProcess | null;
  let registry: BashTaskRegistry;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'duya-host-shell-task-'));
    child = null;
    registry = new BashTaskRegistry({
      store: {
        persist: async () => {},
        rehydrate: async () => [],
      },
    });
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitFor(() => child?.exitCode !== null || child?.signalCode !== null);
    }
    for (const task of registry.listTasks()) registry.removeTask(task.id);
    rmSync(directory, { recursive: true, force: true });
  });

  function makeTools() {
    const port = createWorkerBackgroundTaskPort({
      getAgentLifecycle: () => new BackgroundAgentLifecycle(),
      getShellRegistry: () => registry,
    });
    return { output: new GetTaskOutputTool(port), kill: new KillTaskTool(port) };
  }

  it('reads the live output tail for a running shell task', async () => {
    const outputFile = join(directory, 'running.log');
    writeFileSync(outputFile, 'compiling module 1/9\n');
    registry.register({
      id: 'host-shell-live',
      pid: 999_999,
      outputFile,
      command: 'build',
      status: 'running',
      startTime: Date.now(),
    });

    const payload = parse(await makeTools().output.execute({ task_ids: ['host-shell-live'] })) as {
      results: Array<{ status: string; output: string }>;
    };
    expect(payload.results[0].status).toBe('running');
    expect(payload.results[0].output).toContain('compiling module 1/9');
    expect(payload.results[0].output).toMatch(/do not poll/i);
  });

  it('returns completed and failed shell output using the shared task status vocabulary', async () => {
    for (const item of [
      { id: 'host-shell-done', status: 'completed' as const, exitCode: 0, text: 'build succeeded' },
      { id: 'host-shell-failed', status: 'error' as const, exitCode: 1, text: 'error: build failed' },
    ]) {
      const outputFile = join(directory, `${item.id}.log`);
      writeFileSync(outputFile, `${item.text}\n`);
      registry.register({
        id: item.id,
        pid: 999_999,
        outputFile,
        command: 'build',
        status: 'running',
        startTime: Date.now(),
      });
      const task = registry.getTask(item.id)!;
      task.status = item.status;
      task.exitCode = item.exitCode;
      if (item.status === 'error') task.error = 'Exit code 1';

      const payload = parse(await makeTools().output.execute({ task_ids: [item.id] })) as {
        results: Array<{ status: string; output: string }>;
      };
      expect(payload.results[0].status).toBe(item.status === 'completed' ? 'completed' : 'failed');
      expect(payload.results[0].output).toContain(item.text);
    }
  });

  it('kills a real child process through Host and reports the terminal task on a repeat call', async () => {
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(await waitFor(() => child?.pid !== undefined)).toBe(true);
    const outputFile = join(directory, 'kill.log');
    writeFileSync(outputFile, '');
    registry.register({
      id: 'host-shell-kill',
      pid: child.pid ?? -1,
      outputFile,
      command: 'node long-running-child',
      status: 'running',
      startTime: Date.now(),
    });
    const tools = makeTools();

    const killed = parse(await tools.kill.execute({ task_id: 'host-shell-kill' })) as { outcome: string };
    expect(killed.outcome).toBe('killed');
    expect(registry.getTask('host-shell-kill')?.status).toBe('killed');
    expect(await waitFor(() => child?.exitCode !== null || child?.signalCode !== null)).toBe(true);

    const repeated = parse(await tools.kill.execute({ task_id: 'host-shell-kill' })) as { outcome: string };
    expect(repeated.outcome).toBe('already_exited');
  });
});
