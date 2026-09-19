/**
 * Tests for the file-backed BashTaskStore.
 *
 * Verifies the durability layer for BashTaskRegistry:
 *   - rehydrate returns empty array when no file exists
 *   - rehydrate tolerates a corrupt JSON file
 *   - rehydrate marks previously-running tasks whose PID is no longer
 *     alive as `lost` (startup-recovery semantics from mcode)
 *   - rehydrate trims terminal tasks older than retention
 *   - persist writes a JSON snapshot that round-trips through rehydrate
 *
 * Each test uses a temporary file path so the global BashTaskStore
 * singleton does not leak between cases.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BashTaskStore,
  getBashTaskStore,
  resetBashTaskStore,
} from '../src/session/bash-task-store.js';
import type { BashBackgroundTask } from '../src/session/bash-task-registry.js';

function makeTask(overrides: Partial<BashBackgroundTask> = {}): BashBackgroundTask {
  return {
    id: 'task-1',
    pid: 12345,
    outputFile: '/tmp/duya-test.log',
    command: 'echo hello',
    status: 'running',
    startTime: 1_000_000,
    ...overrides,
  };
}

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(join(tmpdir(), 'duya-bash-store-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('BashTaskStore — rehydrate empty / corrupt', () => {
  it('returns [] when no snapshot file exists', async () => {
    await withTempDir(async (dir) => {
      const store = new BashTaskStore({ filePath: join(dir, 'no-such.json') });
      const tasks = await store.rehydrate();
      expect(tasks).toEqual([]);
    });
  });

  it('returns [] when the snapshot file is corrupt', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'corrupt.json');
      writeFileSync(path, '{not valid json', 'utf-8');
      const store = new BashTaskStore({ filePath: path });
      const tasks = await store.rehydrate();
      expect(tasks).toEqual([]);
    });
  });

  it('returns [] when the snapshot version is wrong', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'wrong-version.json');
      writeFileSync(path, JSON.stringify({ version: 99, tasks: [] }), 'utf-8');
      const store = new BashTaskStore({ filePath: path });
      const tasks = await store.rehydrate();
      expect(tasks).toEqual([]);
    });
  });
});

describe('BashTaskStore — liveness reconciliation', () => {
  it('marks running tasks whose PID is dead as lost', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'snapshot.json');
      // PID 999999 is almost certainly not alive on any host.
      const dead: BashBackgroundTask = makeTask({ id: 'dead', pid: 999_999, status: 'running' });
      writeFileSync(
        path,
        JSON.stringify({ version: 1, savedAt: Date.now(), tasks: [dead] }),
        'utf-8',
      );

      const store = new BashTaskStore({ filePath: path });
      const tasks = await store.rehydrate();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('dead');
      expect(tasks[0].status).toBe('lost');
      expect(tasks[0].endTime).toBeDefined();
      expect(tasks[0].error).toMatch(/lost on rehydrate/);
    });
  });

  it('keeps running tasks whose PID is alive as running', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'snapshot.json');
      // Use the current process PID — definitely alive.
      const alive: BashBackgroundTask = makeTask({
        id: 'alive',
        pid: process.pid,
        status: 'running',
      });
      writeFileSync(
        path,
        JSON.stringify({ version: 1, savedAt: Date.now(), tasks: [alive] }),
        'utf-8',
      );

      const store = new BashTaskStore({ filePath: path });
      const tasks = await store.rehydrate();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('running');
    });
  });
});

describe('BashTaskStore — retention trim', () => {
  it('drops terminal tasks older than the retention window', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'snapshot.json');
      const now = 10_000_000;
      const fresh = makeTask({
        id: 'fresh',
        status: 'completed',
        endTime: now - 1000,
      });
      const stale = makeTask({
        id: 'stale',
        status: 'completed',
        endTime: now - (48 * 60 * 60 * 1000), // 48h ago
      });
      writeFileSync(
        path,
        JSON.stringify({ version: 1, savedAt: now, tasks: [fresh, stale] }),
        'utf-8',
      );

      const store = new BashTaskStore({
        filePath: path,
        retentionMs: 24 * 60 * 60 * 1000,
        nowMs: () => now,
      });
      const tasks = await store.rehydrate();

      expect(tasks.map((t) => t.id)).toEqual(['fresh']);
    });
  });

  it('always keeps running tasks regardless of age', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'snapshot.json');
      const now = 10_000_000;
      const oldRunning = makeTask({
        id: 'old-running',
        status: 'running',
        pid: process.pid, // keep alive so liveness check passes
        startTime: now - (48 * 60 * 60 * 1000),
      });
      writeFileSync(
        path,
        JSON.stringify({ version: 1, savedAt: now, tasks: [oldRunning] }),
        'utf-8',
      );

      const store = new BashTaskStore({
        filePath: path,
        retentionMs: 24 * 60 * 60 * 1000,
        nowMs: () => now,
      });
      const tasks = await store.rehydrate();

      expect(tasks.map((t) => t.id)).toEqual(['old-running']);
    });
  });
});

describe('BashTaskStore — persist round-trip', () => {
  it('writes a snapshot that rehydrate can read back', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'roundtrip.json');
      const fixedNow = Date.now();
      const store = new BashTaskStore({ filePath: path, nowMs: () => fixedNow });

      const tasks: BashBackgroundTask[] = [
        makeTask({ id: 'a', status: 'running' }),
        makeTask({
          id: 'b',
          status: 'completed',
          exitCode: 0,
          endTime: fixedNow - 1_000, // 1s ago — within retention
        }),
      ];
      await store.persist(tasks);

      expect(existsSync(path)).toBe(true);
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      expect(raw.version).toBe(1);
      expect(raw.tasks).toHaveLength(2);

      const rehydrated = await store.rehydrate();
      expect(rehydrated.map((t) => t.id).sort()).toEqual(['a', 'b']);
      expect(rehydrated.find((t) => t.id === 'b')!.exitCode).toBe(0);
    });
  });

  it('coalesces concurrent persist() calls into a single file write', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'coalesce.json');
      const store = new BashTaskStore({ filePath: path });

      await Promise.all([
        store.persist([makeTask({ id: 'a' })]),
        store.persist([makeTask({ id: 'b' })]),
        store.persist([makeTask({ id: 'c' })]),
      ]);

      const rehydrated = await store.rehydrate();
      // Last write wins, so we expect exactly one of the three IDs.
      expect(rehydrated).toHaveLength(1);
      expect(['a', 'b', 'c']).toContain(rehydrated[0].id);
    });
  });

  it('swallows filesystem errors without throwing', async () => {
    // Use a directory path that exists but is not writable.
    await withTempDir(async (dir) => {
      // Pick a path that cannot be created (parent is a file, not a dir).
      const blocker = join(dir, 'blocker');
      writeFileSync(blocker, 'I am a file', 'utf-8');
      const path = join(blocker, 'cannot-create.json');

      const store = new BashTaskStore({ filePath: path });
      // Should not throw, even though the write will fail.
      await expect(store.persist([makeTask()])).resolves.toBeUndefined();
    });
  });
});

describe('BashTaskStore — singleton', () => {
  beforeEach(() => {
    resetBashTaskStore();
  });

  afterEach(() => {
    resetBashTaskStore();
  });

  it('getBashTaskStore returns the same instance', () => {
    const a = getBashTaskStore();
    const b = getBashTaskStore();
    expect(a).toBe(b);
  });

  it('resetBashTaskStore creates a new instance', () => {
    const a = getBashTaskStore();
    resetBashTaskStore();
    const b = getBashTaskStore();
    expect(b).not.toBe(a);
  });
});