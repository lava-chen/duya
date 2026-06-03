/**
 * Tests for BashTaskRegistry - background bash task lifecycle management.
 *
 * Covers: register, progress tracking, status transitions, output reading,
 * process lifecycle (stop, liveness check), listener notifications, and
 * the session-scoped singleton pattern.
 */

import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync, spawn } from 'child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  BashTaskRegistry,
  BashBackgroundTask,
  BashTaskProgress,
  getBashTaskRegistry,
  resetBashTaskRegistry,
} from '../src/session/bash-task-registry.js';

function makeTask(overrides: Partial<BashBackgroundTask> = {}): BashBackgroundTask {
  return {
    id: 'task-1',
    pid: 12345,
    outputFile: join(tmpdir(), 'duya-test-bash-task-1.log'),
    command: 'echo hello',
    status: 'running',
    startTime: Date.now(),
    ...overrides,
  };
}

function makeProgress(overrides: Partial<BashTaskProgress> = {}): BashTaskProgress {
  return {
    bytes: 1024,
    pid: 12345,
    elapsed: 5000,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// Core CRUD
// ============================================================================

describe('BashTaskRegistry - CRUD', () => {
  let registry: BashTaskRegistry;

  beforeEach(() => {
    resetBashTaskRegistry();
    registry = getBashTaskRegistry();
  });

  afterEach(() => {
    resetBashTaskRegistry();
  });

  it('registers a task and retrieves it', () => {
    const task = makeTask();
    registry.register(task);

    const retrieved = registry.getTask('task-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('task-1');
    expect(retrieved!.pid).toBe(12345);
    expect(retrieved!.status).toBe('running');
  });

  it('returns undefined for unknown task', () => {
    expect(registry.getTask('nonexistent')).toBeUndefined();
  });

  it('lists all tasks', () => {
    registry.register(makeTask({ id: 'task-1' }));
    registry.register(makeTask({ id: 'task-2', pid: 54321 }));

    const tasks = registry.listTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.id).sort()).toEqual(['task-1', 'task-2']);
  });

  it('lists only running tasks', () => {
    registry.register(makeTask({ id: 'task-1', status: 'running' }));
    registry.register(makeTask({ id: 'task-2', status: 'completed' }));
    registry.register(makeTask({ id: 'task-3', status: 'running' }));

    const running = registry.listRunningTasks();
    expect(running).toHaveLength(2);
    expect(running.map((t) => t.id).sort()).toEqual(['task-1', 'task-3']);
  });

  it('removes a task', () => {
    registry.register(makeTask({ id: 'task-1' }));
    expect(registry.removeTask('task-1')).toBe(true);
    expect(registry.getTask('task-1')).toBeUndefined();
    expect(registry.removeTask('task-1')).toBe(false);
  });

  it('reports count and runningCount', () => {
    expect(registry.count).toBe(0);
    expect(registry.runningCount).toBe(0);

    registry.register(makeTask({ id: 'a', status: 'running' }));
    registry.register(makeTask({ id: 'b', status: 'completed' }));
    registry.register(makeTask({ id: 'c', status: 'running' }));

    expect(registry.count).toBe(3);
    expect(registry.runningCount).toBe(2);
  });
});

// ============================================================================
// Progress tracking
// ============================================================================

describe('BashTaskRegistry - progress', () => {
  let registry: BashTaskRegistry;

  beforeEach(() => {
    resetBashTaskRegistry();
    registry = getBashTaskRegistry();
  });

  afterEach(() => {
    resetBashTaskRegistry();
  });

  it('updates progress on a registered task', () => {
    registry.register(makeTask({ id: 'task-1' }));
    registry.updateProgress('task-1', makeProgress({ bytes: 2048, elapsed: 10000 }));

    const task = registry.getTask('task-1')!;
    expect(task.lastProgress).toBeDefined();
    expect(task.lastProgress!.bytes).toBe(2048);
    expect(task.lastProgress!.elapsed).toBe(10000);
  });

  it('ignores progress update for unknown task', () => {
    expect(() => {
      registry.updateProgress('nonexistent', makeProgress());
    }).not.toThrow();
  });

  it('progress notifications fire listeners', () => {
    registry.register(makeTask({ id: 'task-1' }));
    const listener = vi.fn();
    registry.onProgress('task-1', listener);

    registry.updateProgress('task-1', makeProgress({ bytes: 4096 }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].lastProgress!.bytes).toBe(4096);
  });

  it('unsubscribe removes listener', () => {
    registry.register(makeTask({ id: 'task-1' }));
    const listener = vi.fn();
    const unsubscribe = registry.onProgress('task-1', listener);

    unsubscribe();
    registry.updateProgress('task-1', makeProgress());

    expect(listener).not.toHaveBeenCalled();
  });

  it('listener errors do not propagate', () => {
    registry.register(makeTask({ id: 'task-1' }));
    const badListener = vi.fn(() => {
      throw new Error('boom');
    });
    const goodListener = vi.fn();

    registry.onProgress('task-1', badListener);
    registry.onProgress('task-1', goodListener);

    expect(() => {
      registry.updateProgress('task-1', makeProgress());
    }).not.toThrow();

    expect(goodListener).toHaveBeenCalled();
  });
});

// ============================================================================
// Status transitions
// ============================================================================

describe('BashTaskRegistry - status transitions', () => {
  let registry: BashTaskRegistry;

  beforeEach(() => {
    resetBashTaskRegistry();
    registry = getBashTaskRegistry();
  });

  afterEach(() => {
    resetBashTaskRegistry();
  });

  it('markCompleted sets status to completed for exitCode 0', () => {
    registry.register(makeTask({ id: 'task-1', status: 'running' }));
    registry.markCompleted('task-1', 0);

    const task = registry.getTask('task-1')!;
    expect(task.status).toBe('completed');
    expect(task.exitCode).toBe(0);
    expect(task.endTime).toBeDefined();
  });

  it('markCompleted sets status to error for non-zero exitCode', () => {
    registry.register(makeTask({ id: 'task-1', status: 'running' }));
    registry.markCompleted('task-1', 1, 'something went wrong');

    const task = registry.getTask('task-1')!;
    expect(task.status).toBe('error');
    expect(task.exitCode).toBe(1);
    expect(task.error).toBe('something went wrong');
  });

  it('markKilled sets status to killed', () => {
    registry.register(makeTask({ id: 'task-1', status: 'running' }));
    registry.markKilled('task-1', 'disk limit exceeded');

    const task = registry.getTask('task-1')!;
    expect(task.status).toBe('killed');
    expect(task.endTime).toBeDefined();
    expect(task.error).toBe('disk limit exceeded');
  });

  it('status transitions notify listeners', () => {
    registry.register(makeTask({ id: 'task-1', status: 'running' }));
    const listener = vi.fn();
    registry.onProgress('task-1', listener);

    registry.markCompleted('task-1', 0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].status).toBe('completed');
  });

  it('markCompleted ignores unknown task', () => {
    expect(() => registry.markCompleted('nonexistent', 0)).not.toThrow();
  });

  it('markKilled ignores unknown task', () => {
    expect(() => registry.markKilled('nonexistent', 'reason')).not.toThrow();
  });
});

// ============================================================================
// Output file reading
// ============================================================================

describe('BashTaskRegistry - output reading', () => {
  let registry: BashTaskRegistry;
  const testFile = join(tmpdir(), 'duya-test-bash-output.log');

  beforeEach(() => {
    resetBashTaskRegistry();
    registry = getBashTaskRegistry();
  });

  afterEach(() => {
    resetBashTaskRegistry();
    try { unlinkSync(testFile); } catch { /* ok */ }
  });

  it('reads output from task file', () => {
    const content = 'line 1\nline 2\nline 3\n';
    writeFileSync(testFile, content, 'utf-8');

    registry.register(makeTask({ id: 'task-1', outputFile: testFile }));

    const result = registry.readOutput('task-1');
    expect(result).not.toBeNull();
    expect(result!.text).toBe(content);
    expect(result!.totalBytes).toBe(content.length);
  });

  it('returns null for task without output file', () => {
    registry.register(makeTask({ id: 'task-1', outputFile: '' }));
    expect(registry.readOutput('task-1')).toBeNull();
  });

  it('returns null for unknown task', () => {
    expect(registry.readOutput('nonexistent')).toBeNull();
  });

  it('returns empty for empty file', () => {
    writeFileSync(testFile, '', 'utf-8');
    registry.register(makeTask({ id: 'task-1', outputFile: testFile }));

    const result = registry.readOutput('task-1');
    expect(result).not.toBeNull();
    expect(result!.text).toBe('');
    expect(result!.totalBytes).toBe(0);
  });

  it('truncates large output with header', () => {
    const large = 'x'.repeat(200_000);
    writeFileSync(testFile, large, 'utf-8');

    registry.register(makeTask({ id: 'task-1', outputFile: testFile }));

    const result = registry.readOutput('task-1', 50_000);
    expect(result).not.toBeNull();
    expect(result!.text).toContain('truncated');
    expect(result!.text).toContain('200000 bytes total');
    expect(result!.totalBytes).toBe(200_000);
    // The tail portion should be the last 50k chars of 'x'
    expect(result!.text).toContain('x'.repeat(50_000).slice(0, 100));
  });

  it('returns null when file does not exist', () => {
    registry.register(makeTask({ id: 'task-1', outputFile: join(tmpdir(), 'does-not-exist.log') }));
    expect(registry.readOutput('task-1')).toBeNull();
  });

  it('respects custom maxBytes parameter', () => {
    const content = 'a'.repeat(10_000);
    writeFileSync(testFile, content, 'utf-8');

    registry.register(makeTask({ id: 'task-1', outputFile: testFile }));

    // Small maxBytes forces truncation even though file is within default
    const result = registry.readOutput('task-1', 100);
    expect(result).not.toBeNull();
    expect(result!.text).toContain('truncated');
  });
});

// ============================================================================
// Process lifecycle
// ============================================================================

describe('BashTaskRegistry - process lifecycle', () => {
  let registry: BashTaskRegistry;

  beforeEach(() => {
    resetBashTaskRegistry();
    registry = getBashTaskRegistry();
  });

  afterEach(() => {
    resetBashTaskRegistry();
  });

  it('isProcessAlive returns true for running process', () => {
    expect(registry.isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive returns false for nonexistent PID', () => {
    // PID 0 on Unix is idle process; 99999 is almost certainly nonexistent
    expect(registry.isProcessAlive(999999)).toBe(false);
  });

  it('stopTask returns error for unknown task', async () => {
    const result = await registry.stopTask('nonexistent');
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('stopTask returns error for non-running task', async () => {
    registry.register(makeTask({ id: 'task-1', status: 'completed' }));
    const result = await registry.stopTask('task-1');
    expect(result.success).toBe(false);
    expect(result.message).toContain('not running');
  });

  it('stopTask kills a running process and marks killed', async () => {
    // Start a long-running process we can kill
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });

    const pid = child.pid!;
    registry.register(makeTask({ id: 'task-test-kill', pid, status: 'running' }));

    const result = await registry.stopTask('task-test-kill');
    expect(result.success).toBe(true);

    const task = registry.getTask('task-test-kill')!;
    expect(task.status).toBe('killed');

    // Clean up if still alive
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  });

  it('stopTask handles already-dead process gracefully', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });

    const pid = child.pid!;

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
    });

    registry.register(makeTask({ id: 'task-exited', pid, status: 'running' }));

    const result = await registry.stopTask('task-exited');
    // Should succeed since process is already gone
    expect(result.success).toBe(true);
    const task = registry.getTask('task-exited')!;
    expect(['error', 'killed', 'completed']).toContain(task.status);
  });
});

// ============================================================================
// Liveness refresh
// ============================================================================

describe('BashTaskRegistry - liveness refresh', () => {
  let registry: BashTaskRegistry;

  beforeEach(() => {
    resetBashTaskRegistry();
    registry = getBashTaskRegistry();
  });

  afterEach(() => {
    resetBashTaskRegistry();
  });

  it('refreshLiveness marks dead processes as completed/error', () => {
    registry.register(makeTask({ id: 'task-dead', pid: 999999, status: 'running' }));
    registry.register(makeTask({ id: 'task-alive', pid: process.pid, status: 'running' }));

    registry.refreshLiveness();

    // Non-zero exit code → status 'error' (correct behavior)
    expect(registry.getTask('task-dead')!.status).toBe('error');
    expect(registry.getTask('task-alive')!.status).toBe('running');
  });

  it('refreshLiveness ignores non-running tasks', () => {
    registry.register(makeTask({ id: 'task-done', pid: 999999, status: 'completed' }));
    registry.refreshLiveness();
    expect(registry.getTask('task-done')!.status).toBe('completed');
  });
});

// ============================================================================
// Singleton pattern
// ============================================================================

describe('BashTaskRegistry - singleton', () => {
  afterEach(() => {
    resetBashTaskRegistry();
  });

  it('getBashTaskRegistry returns the same instance', () => {
    const r1 = getBashTaskRegistry();
    const r2 = getBashTaskRegistry();
    expect(r1).toBe(r2);
  });

  it('resetBashTaskRegistry creates a new instance', () => {
    const r1 = getBashTaskRegistry();
    r1.register(makeTask({ id: 'stale' }));

    resetBashTaskRegistry();

    const r2 = getBashTaskRegistry();
    expect(r2.getTask('stale')).toBeUndefined();
    expect(r2).not.toBe(r1);
  });
});