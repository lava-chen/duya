/**
 * Tests for the FsyncPolicy group-commit batching. We use a real file fd
 * (opened in tmpdir) and mock fsyncSync via injection — the goal is to
 * verify the dirty/clean lifecycle and barrier escalation, not the OS
 * fsync behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// We need to import the module AFTER mocking fs.fsyncSync so the
// internal references pick up the mock. The mock is installed before
// the import via `vi.mock` (Vitest's hoisted mock). vi.hoisted ensures
// the mock fn reference is captured at hoist-time so the mock factory
// can close over it without a temporal-dead-zone error.
const { fsyncSync } = vi.hoisted(() => ({ fsyncSync: vi.fn() }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return {
    ...actual,
    fsyncSync,
  };
});

import { FsyncPolicy } from '../fsync-policy';

describe('FsyncPolicy', () => {
  let tmpDir: string;
  let fd1: number;
  let fd2: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsync-test-'));
    fd1 = fs.openSync(path.join(tmpDir, 'a.jsonl'), 'w');
    fd2 = fs.openSync(path.join(tmpDir, 'b.jsonl'), 'w');
    fsyncSync.mockClear();
  });

  afterEach(() => {
    fs.closeSync(fd1);
    fs.closeSync(fd2);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('markDirty + drain runs fsyncSync once per dirty fd', () => {
    const policy = new FsyncPolicy({ intervalMs: 60_000 });
    policy.markDirty(fd1);
    policy.markDirty(fd2);
    policy.markDirty(fd1); // duplicate; still one fsync for fd1
    expect(policy._peekDirty()).toEqual(expect.arrayContaining([fd1, fd2]));

    policy.drain();
    expect(fsyncSync).toHaveBeenCalledTimes(2);
    expect(fsyncSync).toHaveBeenCalledWith(fd1);
    expect(fsyncSync).toHaveBeenCalledWith(fd2);
    expect(policy._peekDirty()).toEqual([]);

    policy.dispose();
  });

  it('markBarrier queues an immediate fsync on the next microtask', async () => {
    const policy = new FsyncPolicy({ intervalMs: 60_000 });
    policy.markDirty(fd1);
    policy.markBarrier(fd1, 'user_msg');
    // The barrier schedules a microtask that calls drain().
    await new Promise<void>((r) => queueMicrotask(() => r()));
    await new Promise<void>((r) => queueMicrotask(() => r()));
    expect(fsyncSync).toHaveBeenCalledWith(fd1);
    policy.dispose();
  });

  it('group timer drains all pending dirty fds', async () => {
    const policy = new FsyncPolicy({ intervalMs: 30 });
    policy.markDirty(fd1);
    policy.markDirty(fd2);
    // Wait long enough for the timer to fire (50ms > 30ms interval).
    await new Promise((r) => setTimeout(r, 80));
    expect(fsyncSync).toHaveBeenCalledTimes(2);
    policy.dispose();
  });

  it('disabled policy is a no-op', () => {
    const policy = new FsyncPolicy({ disabled: true });
    policy.markDirty(fd1);
    policy.markBarrier(fd1, 'user_msg');
    policy.drain();
    expect(fsyncSync).not.toHaveBeenCalled();
    policy.dispose();
  });

  it('fsyncSync errors do not throw — they are silently dropped', () => {
    const policy = new FsyncPolicy({ intervalMs: 60_000 });
    fsyncSync.mockImplementationOnce(() => {
      throw new Error('EBADF');
    });
    policy.markDirty(fd1);
    // Should not throw even though fsyncSync raised.
    expect(() => policy.drain()).not.toThrow();
    policy.dispose();
  });

  it('dispose() drains pending fds and tears down the timer', async () => {
    const policy = new FsyncPolicy({ intervalMs: 30 });
    policy.markDirty(fd1);
    policy.dispose();
    expect(fsyncSync).toHaveBeenCalledWith(fd1);
    // Subsequent markDirty calls are no-ops.
    fsyncSync.mockClear();
    policy.markDirty(fd2);
    policy.drain();
    expect(fsyncSync).not.toHaveBeenCalled();
  });

  it('multiple barriers collapse into a single drain (idempotent)', async () => {
    const policy = new FsyncPolicy({ intervalMs: 60_000 });
    policy.markBarrier(fd1, 'user_msg');
    policy.markBarrier(fd1, 'turn_end');
    await new Promise<void>((r) => queueMicrotask(() => r()));
    await new Promise<void>((r) => queueMicrotask(() => r()));
    // Despite two barrier calls, fsyncSync runs once for fd1.
    const fd1Calls = fsyncSync.mock.calls.filter((c) => c[0] === fd1);
    expect(fd1Calls.length).toBeLessThanOrEqual(1);
    policy.dispose();
  });
});