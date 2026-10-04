import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIsolatedWorktree, slugifyWorktreeName, WorktreeError } from '../worktree.js';

/**
 * `isolation: 'worktree'` against a real git repository. These tests create
 * throwaway repos under the OS temp dir and point DUYA_APP_DATA_PATH at a
 * throwaway duya root so nothing lands in the developer's real `~/.duya` or
 * in the checkout this suite runs from.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Create a throwaway repo under the OS temp dir, returned as a CANONICAL path.
 *
 * `createIsolatedWorktree` derives `repoRoot` from `git rev-parse
 * --show-toplevel`, which reports the fully resolved path. On Windows the
 * temp dir is frequently reached through an 8.3 short name
 * (`C:\Users\RUNNER~1\AppData\Local\Temp`), so the raw `mkdtempSync` result
 * and git's answer are the same directory spelled two different ways. Resolve
 * the fixture up front so both sides are canonical. This is a no-op on POSIX
 * apart from following a `/tmp` symlink, which git also resolves.
 */
function makeRepo(): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'duya-wt-repo-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@duya.local');
  git(dir, 'config', 'user.name', 'duya test');
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

describe('slugifyWorktreeName', () => {
  it('produces a branch-safe fragment from arbitrary model input', () => {
    expect(slugifyWorktreeName('Fix The Failing Tests!')).toBe('fix-the-failing-tests');
    expect(slugifyWorktreeName('a/b:c*d')).toBe('a-b-c-d');
    expect(slugifyWorktreeName('  --  ')).toBe('task');
    expect(slugifyWorktreeName('')).toBe('task');
  });

  it('caps the length so the generated branch name stays usable', () => {
    expect(slugifyWorktreeName('x'.repeat(200)).length).toBeLessThanOrEqual(32);
  });
});

describe('createIsolatedWorktree', () => {
  // Canonical for the same reason as makeRepo(): the containment assertion
  // below compares this prefix against the worktree path git reports.
  const duyaRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'duya-wt-root-')));
  const previousDuyaPath = process.env.DUYA_APP_DATA_PATH;
  process.env.DUYA_APP_DATA_PATH = duyaRoot;

  afterAll(() => {
    if (previousDuyaPath === undefined) delete process.env.DUYA_APP_DATA_PATH;
    else process.env.DUYA_APP_DATA_PATH = previousDuyaPath;
    rmSync(duyaRoot, { recursive: true, force: true });
  });

  it('creates a worktree outside the repository and reports its branch', async () => {
    const repo = makeRepo();
    try {
      const worktree = await createIsolatedWorktree(repo, 'fix tests');

      expect(worktree.repoRoot).toBe(path.resolve(repo));
      expect(worktree.branch).toMatch(/^duya\/subagent\/fix-tests-[0-9a-f]{6}$/);
      // Not inside the user's checkout: this is the whole point.
      expect(path.resolve(worktree.path).startsWith(path.resolve(repo) + path.sep)).toBe(false);
      // Under the duya-owned root.
      expect(path.resolve(worktree.path).startsWith(path.resolve(duyaRoot) + path.sep)).toBe(true);

      // The worktree is a real checkout of the same commit.
      expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'));
      expect(git(worktree.path, 'branch', '--show-current')).toBe(worktree.branch);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses a directory that is not inside a git repository', async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'duya-plain-'));
    try {
      await expect(createIsolatedWorktree(plain, 'x')).rejects.toThrow(WorktreeError);
      await expect(createIsolatedWorktree(plain, 'x')).rejects.toMatchObject({
        code: 'not_a_git_repo',
      });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('refuses a repository with no HEAD commit', async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'duya-empty-repo-'));
    try {
      git(empty, 'init', '-q', '-b', 'main');
      await expect(createIsolatedWorktree(empty, 'x')).rejects.toMatchObject({ code: 'no_head' });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('refuses a dirty working tree instead of half-applying anything', async () => {
    const repo = makeRepo();
    try {
      mkdirSync(path.join(repo, 'src'), { recursive: true });
      writeFileSync(path.join(repo, 'src', 'dirty.ts'), 'export const x = 1;\n');

      await expect(createIsolatedWorktree(repo, 'x')).rejects.toMatchObject({
        code: 'dirty_worktree',
      });
      // No worktree was registered with git.
      expect(git(repo, 'worktree', 'list')).not.toContain('duya/subagent/');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
