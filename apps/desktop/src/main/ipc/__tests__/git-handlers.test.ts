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
import type {
  HostLocalTurnReviewRecord,
  HostLocalTurnReviewSummary,
} from '@duya/agent-protocol';

const mocks = vi.hoisted(() => {
  const fsState = {
    existsSync: vi.fn(() => true),
    realpathSync: vi.fn((value: string) => value),
    readFileSync: vi.fn(() => ''),
  };
  const spawnState = {
    spawnSync: vi.fn<() => SpawnSyncReturns<string>>(),
  };
  return {
    fs: fsState,
    spawn: spawnState,
    turnReviewAvailable: true,
    turnReviews: {
      getLatestTurnReview: vi.fn(async (_sessionId: string): Promise<HostLocalTurnReviewRecord | null> => null),
      listTurnReviewHistory: vi.fn(async (_sessionId: string, _limit: number): Promise<readonly HostLocalTurnReviewSummary[]> => []),
      getTurnReviewById: vi.fn(async (_reviewId: string): Promise<HostLocalTurnReviewRecord | null> => null),
      getTurnReviewByTurnId: vi.fn(async (_sessionId: string, _turnId: string): Promise<HostLocalTurnReviewRecord | null> => null),
    },
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
vi.mock('../../cli/desktop-host-api', () => ({
  getDesktopHostLocalTurnReviewApi: () => {
    if (!mocks.turnReviewAvailable) throw new Error('Host is not running');
    return mocks.turnReviews;
  },
}));

import {
  parseCommitLogOutput,
  registerGitHandlers,
  validateDiffPair,
  validateGitRef,
} from '../git-handlers';

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

const STATUS_UNTRACKED_FIXTURE = [
  '?? src/created.ts',
  '',
].join('\0');

function spawnResult(stdout: string, status: number | null = 0): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout,
    stderr: '',
    status,
    signal: null,
    error: undefined,
  } as SpawnSyncReturns<string>;
}

/** Whether every token of `wanted` appears in `args`, in order. */
function containsSequence(args: readonly string[], wanted: readonly string[]): boolean {
  let index = 0;
  for (const token of args) {
    if (index < wanted.length && token === wanted[index]) index += 1;
  }
  return index === wanted.length;
}

/**
 * Argument-aware git mock.
 *
 * The handlers enumerate configured filter drivers before every diff, so a
 * blind `mockReturnValueOnce` sequence shifts by one call and the fixture meant
 * for the diff lands on the enumeration. Routing by argv makes each fixture
 * describe the command it answers, and an unmatched call — the enumeration, or
 * anything a test did not anticipate — defaults to empty stdout instead of
 * silently stealing a neighbouring fixture.
 */
function mockGit(
  routes: ReadonlyArray<{ readonly args: readonly string[]; readonly result: SpawnSyncReturns<string> }>,
): void {
  mocks.spawn.spawnSync.mockImplementation(((command: string, args: readonly string[]) => {
    for (const route of routes) {
      if (containsSequence(args, route.args)) return route.result;
    }
    return spawnResult('');
  }) as never);
}

describe('git:status', () => {
  beforeEach(() => {
    mocks.fs.existsSync.mockReset();
    mocks.fs.existsSync.mockReturnValue(true);
    mocks.fs.readFileSync.mockReset();
    mocks.fs.readFileSync.mockReturnValue('');
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
    mockGit([
      { args: ['diff', '--numstat'], result: spawnResult(NUMSTAT_FIXTURE) },
      { args: ['status'], result: spawnResult('') },
    ]);
    const result = await invokeHandler('git:status', {}, '/tmp/repo') as {
      isGitRepo: boolean;
      fileChanges?: Array<{ path: string; additions: number; removals: number }>;
      totals?: { additions: number; removals: number; fileCount: number };
    };

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
    // Routed to the diff itself. With a blind sequence this fixture used to be
    // consumed by the filter enumeration, and the test then passed for the
    // wrong reason — the diff call fell through to an undefined mock result.
    mockGit([
      {
        args: ['diff', '--numstat'],
        result: { ...spawnResult(''), status: null, error: err } as unknown as SpawnSyncReturns<string>,
      },
    ]);
    const result = await invokeHandler('git:status', {}, '/tmp/repo');
    expect(result).toEqual({ isGitRepo: false });
  });

  it('merges untracked files from porcelain into the status result', async () => {
    mocks.fs.readFileSync.mockReturnValue('a\nb\nc');
    mockGit([
      { args: ['diff', '--numstat'], result: spawnResult(NUMSTAT_FIXTURE) },
      { args: ['status'], result: spawnResult(STATUS_UNTRACKED_FIXTURE) },
    ]);
    const result = await invokeHandler('git:status', {}, '/tmp/repo') as {
      isGitRepo: boolean;
      fileChanges?: Array<{ path: string; additions: number; removals: number }>;
      totals?: { additions: number; removals: number; fileCount: number };
    };
    expect(result.isGitRepo).toBe(true);
    // `git diff HEAD` misses untracked paths; the porcelain pass adds them
    // with a line count (plan 308 Phase 2).
    expect(result.fileChanges).toEqual([
      { path: 'README.md', additions: 12, removals: 3 },
      { path: 'src/foo.ts', additions: 5, removals: 0 },
      { path: 'logo.png', additions: 0, removals: 0 },
      { path: 'package.json', additions: 7, removals: 2 },
      { path: 'src/created.ts', additions: 3, removals: 0 },
    ]);
    expect(result.totals).toEqual({ additions: 27, removals: 5, fileCount: 5 });
  });

  it('returns empty changes when stdout is empty', async () => {
    mockGit([{ args: ['diff', '--numstat'], result: spawnResult('') }]);
    const result = await invokeHandler('git:status', {}, '/tmp/repo') as {
      isGitRepo: boolean;
      fileChanges?: unknown[];
      totals?: { additions: number; removals: number; fileCount: number };
    };
    expect(result.isGitRepo).toBe(true);
    expect(result.fileChanges).toEqual([]);
    expect(result.totals).toEqual({ additions: 0, removals: 0, fileCount: 0 });
  });
});

const REVIEW_STATUS_FIXTURE = [
  ' M src/changed.ts',
  '?? src/new-file.ts',
  'R  src/renamed.ts',
  'src/old-name.ts',
  '',
].join('\0');

const REVIEW_NUMSTAT_FIXTURE = [
  '4\t1\tsrc/changed.ts',
  '2\t0\tsrc/renamed.ts',
  '',
].join('\n');

describe('git:review', () => {
  beforeEach(() => {
    mocks.fs.existsSync.mockReset();
    mocks.fs.existsSync.mockReturnValue(true);
    mocks.fs.readFileSync.mockReset();
    mocks.fs.readFileSync.mockReturnValue('');
    mocks.spawn.spawnSync.mockReset();
    mocks.captured.handle.clear();
    registerGitHandlers();
  });

  it('returns working-tree file statuses, stats, and branch information', async () => {
    mockGit([
      { args: ['status'], result: spawnResult(REVIEW_STATUS_FIXTURE) },
      { args: ['diff', '--numstat'], result: spawnResult(REVIEW_NUMSTAT_FIXTURE) },
      { args: ['branch'], result: spawnResult('feature/review\n') },
    ]);

    await expect(invokeHandler('git:review', {}, '/tmp/repo')).resolves.toEqual({
      isGitRepo: true,
      branch: 'feature/review',
      baseRef: 'HEAD',
      files: [
        { path: 'src/changed.ts', status: 'modified', additions: 4, removals: 1 },
        { path: 'src/new-file.ts', status: 'untracked', additions: 0, removals: 0 },
        {
          path: 'src/renamed.ts',
          oldPath: 'src/old-name.ts',
          status: 'renamed',
          additions: 2,
          removals: 0,
        },
      ],
      totals: { additions: 6, removals: 1, fileCount: 3 },
    });
  });

  it('rejects traversal and Git metadata paths before reading a diff', async () => {
    await expect(invokeHandler('git:review-diff', {}, '/tmp/repo', '../outside.ts')).resolves.toEqual({
      isGitRepo: true,
      error: 'Invalid review path.',
    });
    await expect(invokeHandler('git:review-diff', {}, '/tmp/repo', '.git/config')).resolves.toEqual({
      isGitRepo: true,
      error: 'Invalid review path.',
    });
    expect(mocks.spawn.spawnSync).not.toHaveBeenCalled();
  });

  it('returns a bounded read-only patch for a changed file', async () => {
    const patch = [
      'diff --git a/src/changed.ts b/src/changed.ts',
      '--- a/src/changed.ts',
      '+++ b/src/changed.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    mockGit([
      { args: ['status'], result: spawnResult(REVIEW_STATUS_FIXTURE) },
      { args: ['diff', '--numstat'], result: spawnResult(REVIEW_NUMSTAT_FIXTURE) },
      { args: ['diff', '--unified=20'], result: spawnResult(patch) },
    ]);

    await expect(invokeHandler('git:review-diff', {}, '/tmp/repo', 'src/changed.ts')).resolves.toEqual({
      isGitRepo: true,
      path: 'src/changed.ts',
      patch,
      binary: false,
    });
  });

  it('keeps the bounded partial diff when Git reaches its output limit', async () => {
    const patch = [
      'diff --git a/src/changed.ts b/src/changed.ts',
      '--- a/src/changed.ts',
      '+++ b/src/changed.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    const overflow = Object.assign(new Error('maxBuffer length exceeded'), { code: 'ENOBUFS' });
    mockGit([
      { args: ['status'], result: spawnResult(REVIEW_STATUS_FIXTURE) },
      { args: ['diff', '--numstat'], result: spawnResult(REVIEW_NUMSTAT_FIXTURE) },
      {
        args: ['diff', '--unified=20'],
        result: { ...spawnResult(patch), error: overflow } as unknown as SpawnSyncReturns<string>,
      },
    ]);

    await expect(invokeHandler('git:review-diff', {}, '/tmp/repo', 'src/changed.ts')).resolves.toEqual({
      isGitRepo: true,
      path: 'src/changed.ts',
      patch,
      truncated: true,
      binary: false,
    });
  });

  it('rejects an untracked symlink that resolves outside the workspace', async () => {
    // The suffix is matched with the platform's own separator: the handler
    // joins the workspace and the relative path with `path.join`, so on POSIX
    // the path ends in `src/new-file.ts` and a hard-coded `src\\new-file.ts`
    // never matched — the mocked escape was never simulated and the handler
    // correctly reported the path as inside the workspace.
    mocks.fs.realpathSync.mockImplementation((value: string) =>
      value.replace(/\\/g, '/').endsWith('src/new-file.ts') ? '/tmp/outside.ts' : value,
    );
    mockGit([
      { args: ['status'], result: spawnResult(REVIEW_STATUS_FIXTURE) },
      { args: ['diff', '--numstat'], result: spawnResult(REVIEW_NUMSTAT_FIXTURE) },
      { args: ['diff', '--unified=20'], result: spawnResult('') },
    ]);

    await expect(invokeHandler('git:review-diff', {}, '/tmp/repo', 'src/new-file.ts')).resolves.toEqual({
      isGitRepo: true,
      path: 'src/new-file.ts',
      error: 'Untracked paths outside the workspace cannot be reviewed inline.',
    });
  });
});

describe('git:review-latest-turn', () => {
  beforeEach(() => {
    mocks.fs.existsSync.mockReset();
    mocks.fs.existsSync.mockReturnValue(true);
    mocks.fs.readFileSync.mockReset();
    mocks.fs.readFileSync.mockReturnValue('');
    mocks.turnReviewAvailable = true;
    mocks.turnReviews.getLatestTurnReview.mockReset().mockResolvedValue(null);
    mocks.turnReviews.listTurnReviewHistory.mockReset().mockResolvedValue([]);
    mocks.turnReviews.getTurnReviewById.mockReset().mockResolvedValue(null);
    mocks.turnReviews.getTurnReviewByTurnId.mockReset().mockResolvedValue(null);
    mocks.captured.handle.clear();
    registerGitHandlers();
  });

  it('does not expose review history when the session or workspace is invalid', async () => {
    await expect(invokeHandler('git:review-latest-turn', {}, '', '/tmp/repo')).resolves.toEqual({ isGitRepo: false });
    await expect(invokeHandler('git:review-latest-turn', {}, 'session-1', '')).resolves.toEqual({ isGitRepo: false });
  });

  it('keeps review history unavailable when the main database is not ready', async () => {
    mocks.turnReviewAvailable = false;
    await expect(invokeHandler('git:review-latest-turn', {}, 'session-1', '/tmp/repo')).resolves.toEqual({
      isGitRepo: true,
      error: 'Review history is unavailable.',
    });
  });

  it('matches the latest turn by session id only, tolerating cwd drift', async () => {
    // Plan 308 Phase 2: the stored working_directory no longer needs to
    // equal the caller's cwd string (Windows separator / case drift).
    mocks.turnReviews.getLatestTurnReview.mockResolvedValue({
      id: 'row-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      workingDirectory: 'E:\\repo',
      filesJson: JSON.stringify([{ path: 'a.ts', status: 'modified', additions: 1, removals: 0 }]),
      patch: 'diff',
      additions: 1,
      removals: 0,
      truncated: 0,
      binary: 0,
      capturedAt: 100,
    });
    await expect(invokeHandler('git:review-latest-turn', {}, 'session-1', '/tmp/repo')).resolves.toEqual({
      isGitRepo: true,
      review: {
        id: 'row-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        workingDirectory: 'E:\\repo',
        files: [{ path: 'a.ts', status: 'modified', additions: 1, removals: 0 }],
        totals: { additions: 1, removals: 0, fileCount: 1 },
        patch: 'diff',
        truncated: false,
        binary: false,
        capturedAt: 100,
      },
    });
  });
});

describe('executable-config hardening', () => {
  beforeEach(() => {
    mocks.fs.existsSync.mockReset();
    mocks.fs.existsSync.mockReturnValue(true);
    mocks.fs.readFileSync.mockReset();
    mocks.fs.readFileSync.mockReturnValue('');
    mocks.spawn.spawnSync.mockReset();
    mocks.captured.handle.clear();
    registerGitHandlers();
  });

  /** The argv of the first call whose subcommand is `wanted`. */
  function argvFor(wanted: string): string[] {
    for (const call of mocks.spawn.spawnSync.mock.calls) {
      const args = (call[1] ?? []) as string[];
      if (containsSequence(args, [wanted])) return args;
    }
    throw new Error(`no git ${wanted} call was made`);
  }

  const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

  it('points core.hooksPath at the null device on every git call', async () => {
    mockGit([{ args: ['branch'], result: spawnResult('') }]);
    await invokeHandler('git:repo-state', {}, '/tmp/repo');
    expect(mocks.spawn.spawnSync).toHaveBeenCalled();
    for (const call of mocks.spawn.spawnSync.mock.calls) {
      const args = (call[1] ?? []) as string[];
      expect(args).toContain(`core.hooksPath=${NULL_DEVICE}`);
    }
  });

  it('adds --no-ext-diff and --no-textconv to diff calls', async () => {
    mockGit([{ args: ['diff', '--numstat'], result: spawnResult(NUMSTAT_FIXTURE) }]);
    await invokeHandler('git:status', {}, '/tmp/repo');
    const argv = argvFor('diff');
    expect(argv).toContain('--no-ext-diff');
    expect(argv).toContain('--no-textconv');
  });

  it('omits the diff-only flags from commands that would reject them', async () => {
    mockGit([{ args: ['branch'], result: spawnResult('') }]);
    await invokeHandler('git:repo-state', {}, '/tmp/repo');
    // `git status` / `git branch` / `git rev-parse` have no --no-textconv, so
    // adding it there would turn every one of these into a hard error.
    expect(argvFor('status')).not.toContain('--no-textconv');
    expect(argvFor('branch')).not.toContain('--no-textconv');
    expect(argvFor('rev-parse')).not.toContain('--no-textconv');
  });

  it('neutralizes every configured filter driver it discovers', async () => {
    mockGit([
      {
        args: ['config', '--null'],
        result: spawnResult('filter.lfs.clean\0filter.lfs.process\0filter.custom.process\0'),
      },
      { args: ['diff', '--numstat'], result: spawnResult(NUMSTAT_FIXTURE) },
    ]);

    await invokeHandler('git:status', {}, '/tmp/repo');

    const argv = argvFor('diff');
    for (const driver of ['filter.lfs', 'filter.custom']) {
      expect(argv).toContain(`${driver}.clean=`);
      expect(argv).toContain(`${driver}.process=`);
      expect(argv).toContain(`${driver}.required=false`);
    }
  });

  it('still produces the diff when the filter enumeration fails', async () => {
    // `git config --get-regexp` exits 1 when nothing matches, which is the
    // common case. A hard error there would make every diff unreadable.
    mockGit([
      { args: ['config', '--null'], result: spawnResult('', 1) },
      { args: ['diff', '--numstat'], result: spawnResult(NUMSTAT_FIXTURE) },
    ]);

    const result = await invokeHandler('git:status', {}, '/tmp/repo') as {
      isGitRepo: boolean;
      fileChanges?: Array<{ path: string }>;
    };
    expect(result.isGitRepo).toBe(true);
    expect(result.fileChanges?.[0]?.path).toBe('README.md');
  });

  it('does not let enumeration output be mistaken for a filter driver', async () => {
    // Anything that is not `*.clean` / `*.process` must be ignored, or a
    // malformed line could become a `-c` override naming an arbitrary key.
    mockGit([
      { args: ['config', '--null'], result: spawnResult('core.autocrlf\0filter.lfs.clean\0user.name\0') },
      { args: ['diff', '--numstat'], result: spawnResult(NUMSTAT_FIXTURE) },
    ]);

    await invokeHandler('git:status', {}, '/tmp/repo');

    const argv = argvFor('diff');
    expect(argv).toContain('filter.lfs.clean=');
    expect(argv.join(' ')).not.toContain('core.autocrlf=');
    expect(argv.join(' ')).not.toContain('user.name=');
  });
});

describe('git:review-turn-history', () => {
  beforeEach(() => {
    mocks.fs.existsSync.mockReset();
    mocks.fs.existsSync.mockReturnValue(true);
    mocks.fs.readFileSync.mockReset();
    mocks.fs.readFileSync.mockReturnValue('');
    mocks.turnReviewAvailable = true;
    mocks.turnReviews.getLatestTurnReview.mockReset().mockResolvedValue(null);
    mocks.turnReviews.listTurnReviewHistory.mockReset().mockResolvedValue([]);
    mocks.turnReviews.getTurnReviewById.mockReset().mockResolvedValue(null);
    mocks.turnReviews.getTurnReviewByTurnId.mockReset().mockResolvedValue(null);
    mocks.captured.handle.clear();
    registerGitHandlers();
  });

  it('rejects an invalid session or workspace', async () => {
    await expect(invokeHandler('git:review-turn-history', {}, '', '/tmp/repo')).resolves.toEqual({ isGitRepo: false });
    await expect(invokeHandler('git:review-turn-history', {}, 'session-1', '')).resolves.toEqual({ isGitRepo: false });
  });

  it('reports history unavailable when the main database is not ready', async () => {
    mocks.turnReviewAvailable = false;
    await expect(invokeHandler('git:review-turn-history', {}, 'session-1', '/tmp/repo')).resolves.toEqual({
      isGitRepo: true,
      error: 'Review history is unavailable.',
    });
  });

  it('summarizes persisted turns with a file count per entry', async () => {
    mocks.turnReviews.listTurnReviewHistory.mockResolvedValue([
      {
        id: 'row-2',
        turnId: 'turn-2',
        filesJson: JSON.stringify([
          { path: 'a.ts', status: 'modified', additions: 2, removals: 1 },
          { path: 'b.ts', status: 'added', additions: 5, removals: 0 },
        ]),
        additions: 7,
        removals: 1,
        capturedAt: 200,
      },
      {
        id: 'row-1',
        turnId: 'turn-1',
        filesJson: 'not-json',
        additions: 1,
        removals: 0,
        capturedAt: 100,
      },
    ]);
    await expect(invokeHandler('git:review-turn-history', {}, 'session-1', '/tmp/repo')).resolves.toEqual({
      isGitRepo: true,
      turns: [
        { id: 'row-2', turnId: 'turn-2', additions: 7, removals: 1, fileCount: 2, capturedAt: 200 },
        { id: 'row-1', turnId: 'turn-1', additions: 1, removals: 0, fileCount: 0, capturedAt: 100 },
      ],
    });
  });
});

describe('git:review-turn-detail', () => {
  beforeEach(() => {
    mocks.fs.existsSync.mockReset();
    mocks.fs.existsSync.mockReturnValue(true);
    mocks.fs.readFileSync.mockReset();
    mocks.fs.readFileSync.mockReturnValue('');
    mocks.turnReviewAvailable = true;
    mocks.turnReviews.getLatestTurnReview.mockReset().mockResolvedValue(null);
    mocks.turnReviews.listTurnReviewHistory.mockReset().mockResolvedValue([]);
    mocks.turnReviews.getTurnReviewById.mockReset().mockResolvedValue(null);
    mocks.turnReviews.getTurnReviewByTurnId.mockReset().mockResolvedValue(null);
    mocks.captured.handle.clear();
    registerGitHandlers();
  });

  it('rejects an invalid review id', async () => {
    await expect(invokeHandler('git:review-turn-detail', {}, '/tmp/repo', '')).resolves.toEqual({ isGitRepo: false });
    await expect(invokeHandler('git:review-turn-detail', {}, '/tmp/repo', 'x'.repeat(200))).resolves.toEqual({ isGitRepo: false });
  });

  it('returns one stored turn review by row id', async () => {
    mocks.turnReviews.getTurnReviewById.mockResolvedValue({
      id: 'row-9',
      sessionId: 'session-1',
      turnId: 'turn-9',
      workingDirectory: '/tmp/repo',
      filesJson: JSON.stringify([{ path: 'b.ts', status: 'added', additions: 5, removals: 0 }]),
      patch: 'diff --git',
      additions: 5,
      removals: 0,
      truncated: 0,
      binary: 0,
      capturedAt: 300,
    });
    await expect(invokeHandler('git:review-turn-detail', {}, '/tmp/repo', 'row-9')).resolves.toEqual({
      isGitRepo: true,
      review: {
        id: 'row-9',
        sessionId: 'session-1',
        turnId: 'turn-9',
        workingDirectory: '/tmp/repo',
        files: [{ path: 'b.ts', status: 'added', additions: 5, removals: 0 }],
        totals: { additions: 5, removals: 0, fileCount: 1 },
        patch: 'diff --git',
        truncated: false,
        binary: false,
        capturedAt: 300,
      },
    });
  });

  it('loads the newest stored review for a session turn id', async () => {
    mocks.turnReviews.getTurnReviewByTurnId.mockResolvedValue({
      id: 'row-10',
      sessionId: 'session-1',
      turnId: 'turn-10',
      workingDirectory: '/tmp/repo',
      filesJson: JSON.stringify([{ path: 'c.ts', status: 'modified', additions: 3, removals: 2 }]),
      patch: 'turn patch',
      additions: 3,
      removals: 2,
      truncated: 0,
      binary: 0,
      capturedAt: 400,
    });

    await expect(
      invokeHandler('git:review-turn-by-turn-id', {}, 'session-1', '/tmp/repo', 'turn-10'),
    ).resolves.toMatchObject({
      isGitRepo: true,
      review: {
        id: 'row-10',
        sessionId: 'session-1',
        turnId: 'turn-10',
        totals: { additions: 3, removals: 2, fileCount: 1 },
      },
    });
  });
});
