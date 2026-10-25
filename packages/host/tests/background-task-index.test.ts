import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackgroundTaskIndex, narrowBackgroundTask } from '../src/background-task-index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempOutput(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'duya-bg-task-'));
  roots.push(root);
  const file = join(root, 'output.log');
  writeFileSync(file, contents);
  return file;
}

function rawTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    pid: 1234,
    outputFile: tempOutput('hello'),
    command: 'npm test',
    status: 'running',
    startTime: 1_000,
    ...overrides,
  };
}

describe('narrowBackgroundTask', () => {
  it('rejects rows a guess would have to fill in', () => {
    expect(narrowBackgroundTask(null)).toBeNull();
    expect(narrowBackgroundTask('task')).toBeNull();
    expect(narrowBackgroundTask([])).toBeNull();
    expect(narrowBackgroundTask(rawTask({ id: '' }))).toBeNull();
    expect(narrowBackgroundTask(rawTask({ status: 'paused' }))).toBeNull();
    expect(narrowBackgroundTask(rawTask({ startTime: 'now' }))).toBeNull();
  });

  it('keeps the fields the view renders and drops the local path from the summary', () => {
    const task = narrowBackgroundTask(rawTask({
      lastProgress: { bytes: 4096, pid: 1234, elapsed: 2_000, timestamp: 3_000 },
      endTime: 2_000,
      exitCode: 1,
      error: 'boom',
      autoPromoted: true,
    }));
    expect(task?.summary).toEqual({
      id: 'task-1',
      command: 'npm test',
      status: 'running',
      startedAtMs: 1_000,
      endedAtMs: 2_000,
      exitCode: 1,
      error: 'boom',
      outputBytes: 4096,
      pid: 1234,
      autoPromoted: true,
    });
    expect(JSON.stringify(task?.summary)).not.toContain('output.log');
  });
});

describe('BackgroundTaskIndex', () => {
  it('reports an unobserved session instead of claiming it has no work', async () => {
    const index = new BackgroundTaskIndex();
    expect(await index.listBackgroundTasks('session-a')).toEqual({ observed: false, tasks: [] });
  });

  it('replaces the snapshot wholesale so a finished-removed task cannot linger', async () => {
    const index = new BackgroundTaskIndex();
    index.apply('session-a', [
      rawTask({ id: 'one' }),
      rawTask({ id: 'two' }),
    ]);
    expect((await index.listBackgroundTasks('session-a')).tasks.map((task) => task.id)).toEqual(['one', 'two']);

    index.apply('session-a', [rawTask({ id: 'two' })]);
    expect((await index.listBackgroundTasks('session-a')).tasks.map((task) => task.id)).toEqual(['two']);
  });

  it('orders running first, then newest first', async () => {
    const index = new BackgroundTaskIndex();
    index.apply('session-a', [
      rawTask({ id: 'done-new', status: 'completed', startTime: 3_000 }),
      rawTask({ id: 'running-old', status: 'running', startTime: 1_000 }),
      rawTask({ id: 'done-old', status: 'error', startTime: 2_000 }),
      rawTask({ id: 'running-new', status: 'running', startTime: 4_000 }),
    ]);
    const listed = await index.listBackgroundTasks('session-a');
    expect(listed.tasks.map((task) => task.id)).toEqual([
      'running-new', 'running-old', 'done-new', 'done-old',
    ]);
  });

  it('does not leak one session into another', async () => {
    const index = new BackgroundTaskIndex();
    index.apply('session-a', [rawTask({ id: 'a' })]);
    expect((await index.listBackgroundTasks('session-b')).tasks).toEqual([]);
  });

  it('serves the tail and says it was clipped', async () => {
    const index = new BackgroundTaskIndex();
    const outputFile = tempOutput('0123456789');
    index.apply('session-a', [rawTask({ outputFile })]);

    const clipped = await index.readBackgroundTaskOutput('session-a', 'task-1', 4);
    expect(clipped).toEqual({ taskId: 'task-1', text: '6789', totalBytes: 10, truncated: true });

    const whole = await index.readBackgroundTaskOutput('session-a', 'task-1', 100);
    expect(whole).toEqual({ taskId: 'task-1', text: '0123456789', totalBytes: 10, truncated: false });
  });

  it('separates an unknown task from a vanished output file', async () => {
    const index = new BackgroundTaskIndex();
    const outputFile = tempOutput('gone soon');
    index.apply('session-a', [rawTask({ outputFile })]);
    rmSync(outputFile);

    expect(await index.readBackgroundTaskOutput('session-a', 'nope')).toBeNull();
    expect(await index.readBackgroundTaskOutput('session-a', 'task-1')).toEqual({
      taskId: 'task-1', text: '', totalBytes: 0, truncated: false,
    });
  });
});
