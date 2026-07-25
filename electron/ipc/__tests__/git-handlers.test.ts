/**
 * git-handlers.test.ts — Unit tests for the `git:status` IPC channel.
 *
 * Coverage:
 *   - non-string / empty cwd             → { isGitRepo: false }
 *   - not a git repo (.git absent)       → { isGitRepo: false }
 *   - git binary missing (ENOENT)        → { isGitRepo: false }
 *   - happy path with numstat output     → fileChanges + totals derived
 *   - empty stdout                       → empty changes + zero totals
 *
 * Mirrors the pattern in `files-handlers.test.ts`: mock `electron`
 * to capture `ipcMain.handle` calls; mock `fs` and `child_process`
 * to drive the registry's disk + git probes through fixtures;
 * register `git:status` once per test in `beforeEach`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';

const mocks = vi.hoisted(() => {
  const fsState = {
    existsSync: vi.fn(() => true),
  };
  const spawnState = {
    spawnSync: vi.fn<() => SpawnSyncReturns<string>>(),
  };
  return {
    fs: fsState,
    spawn: spawnState,
    captured: {
      handle: new Map<
        string,
        (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>
      >(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      c: string,
      fn: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>
    ) => {
      mocks.captured.handle.set(c, fn);
    },
  },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
    getAppPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '0.0.0-test'),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    getLocale: vi.fn(() => 'en-US'),
    getLocaleCountryCode: vi.fn(() => 'US'),
  },
}));

vi.mock('fs', () => mocks.fs);
vi.mock('child_process', () => mocks.spawn);

import { registerGitHandlers } from '../git-handlers';

async function invokeHandler(
  channel: string,
  event: unknown = {},
  ...args: unknown[]
): Promise<unknown> {
  const handler = mocks.captured.handle.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return await handler(event, ...args);
}

const NUMSTAT_FIXTURE = [
  '12\t3\tREADME.md',
  '5\t0\tsrc/foo.ts',
  '-\t-\tlogo.png',
  '',
  '7\t2\tpackage.json',
].join('\n');

describe('git:status', () => {
  beforeEach(() => {
    mocks.fs.existsSync.mockReset();
    mocks.fs.existsSync.mockReturnValue(true);
    mocks.spawn.spawnSync.mockReset();
    mocks.captured.handle.clear();
    registerGitHandlers();
  });

  it('returns isGitRepo: false when cwd is not a string', async () => {
    const result = await invokeHandler('git:status', {}, 12345);
    expect(result).toEqual({ isGitRepo: false });
    expect(mocks.spawn.spawnSync).not.toHaveBeenCalled();
  });

  it('returns isGitRepo: false when cwd is empty', async () => {
    const result = await invokeHandler('git:status', {}, '');
    expect(result).toEqual({ isGitRepo: false });
  });

  it('returns isGitRepo: false when .git is missing', async () => {
    mocks.fs.existsSync.mockReturnValue(false);
    const result = await invokeHandler('git:status', {}, '/tmp/not-a-repo');
    expect(result).toEqual({ isGitRepo: false });
    expect(mocks.spawn.spawnSync).not.toHaveBeenCalled();
  });

  it('returns parsed fileChanges + totals on happy path', async () => {
    mocks.spawn.spawnSync.mockReturnValueOnce({
      pid: 1,
      output: [],
      stdout: NUMSTAT_FIXTURE,
      stderr: '',
      status: 0,
      signal: null,
      error: undefined,
    } as SpawnSyncReturns<string>);
    const result = await invokeHandler('git:status', {}, '/tmp/repo');

    expect(result.isGitRepo).toBe(true);
    expect(result.fileChanges).toEqual([
      { path: 'README.md', additions: 12, removals: 3 },
      { path: 'src/foo.ts', additions: 5, removals: 0 },
      { path: 'logo.png', additions: 0, removals: 0 },
      { path: 'package.json', additions: 7, removals: 2 },
    ]);
    expect(result.totals).toEqual({
      additions: 24,
      removals: 5,
      fileCount: 4,
    });
  });

  it('returns isGitRepo: false when git binary is missing (ENOENT)', async () => {
    const err = new Error('spawnSync ENOENT') as Error & { code: string };
    err.code = 'ENOENT';
    mocks.spawn.spawnSync.mockReturnValueOnce({
      pid: 0,
      output: [],
      stdout: '',
      stderr: '',
      status: null,
      signal: null,
      error: err,
    } as unknown as SpawnSyncReturns<string>);
    const result = await invokeHandler('git:status', {}, '/tmp/repo');
    expect(result).toEqual({ isGitRepo: false });
  });

  it('returns empty changes when stdout is empty', async () => {
    mocks.spawn.spawnSync.mockReturnValueOnce({
      pid: 1,
      output: [],
      stdout: '',
      stderr: '',
      status: 0,
      signal: null,
      error: undefined,
    } as SpawnSyncReturns<string>);
    const result = await invokeHandler('git:status', {}, '/tmp/repo');
    expect(result.isGitRepo).toBe(true);
    expect(result.fileChanges).toEqual([]);
    expect(result.totals).toEqual({ additions: 0, removals: 0, fileCount: 0 });
  });
});