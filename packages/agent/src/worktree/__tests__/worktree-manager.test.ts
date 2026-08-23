/**
 * Integration tests for WorktreeManager (plan 439).
 *
 * These run against real throwaway git repositories created in the OS temp
 * directory — the git surface (`worktree add`, porcelain status, branch
 * lifecycle, info/exclude) is exactly what must not be mocked.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  WORKTREE_BRANCH_PREFIX,
  WORKTREE_DIR_NAME,
  cleanupIfUnchanged,
  createAgentWorktree,
  isAgentWorktreeDirty,
  removeAgentWorktree,
  sanitizeWorktreeName,
} from '../worktree-manager.js';

const createdRepos: string[] = [];

afterEach(() => {
  // Force-remove any worktrees still registered under the test repos so a
  // failing assertion does not leak locked directories into the next run.
  while (createdRepos.length) {
    const dir = createdRepos.pop() as string;
    try {
      const listing = git(dir, 'worktree', 'list', '--porcelain');
      for (const line of listing.split('\n')) {
        if (line.startsWith('worktree ') && !line.startsWith(`worktree ${dir}`)) {
          try {
            git(dir, 'worktree', 'remove', '--force', line.slice('worktree '.length).trim());
          } catch {
            // Already gone or locked by another process — best effort.
          }
        }
      }
    } catch {
      // Not a repo anymore / never was — nothing to clean.
    }
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

/** Create a minimal repo with one commit on main; registers it for cleanup. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'duya-wt-test-'));
  createdRepos.push(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@duya.local');
  git(dir, 'config', 'user.name', 'Duya Test');
  // Byte-exact file contents regardless of the machine's global autocrlf.
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(dir, 'a.txt'), 'init\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

function commitFile(repoDir: string, file: string, content: string): string {
  writeFileSync(path.join(repoDir, file), content);
  git(repoDir, 'add', '.');
  git(repoDir, 'commit', '-m', `update ${file}`);
  return git(repoDir, 'rev-parse', 'HEAD').trim();
}

function branchExists(repoDir: string, branch: string): boolean {
  return gitOk(repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
}

function readTreeFile(treePath: string, file: string): string {
  return readFileSync(path.join(treePath, file), 'utf8');
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

describe('sanitizeWorktreeName', () => {
  it('keeps already-valid names untouched', () => {
    expect(sanitizeWorktreeName('fix-parser')).toBe('fix-parser');
    expect(sanitizeWorktreeName('Fix.Parser_2')).toBe('Fix.Parser_2');
  });

  it('replaces invalid runs with dashes and trims edge punctuation', () => {
    expect(sanitizeWorktreeName('my weird name!!')).toBe('my-weird-name');
    expect(sanitizeWorktreeName('--lead--trail--')).toBe('lead-trail');
  });

  it('falls back to a random valid name when nothing survives', () => {
    expect(sanitizeWorktreeName('///')).toMatch(NAME_PATTERN);
    expect(sanitizeWorktreeName(undefined)).toMatch(NAME_PATTERN);
  });
});

describe('createAgentWorktree', () => {
  it('creates a worktree with a dedicated branch at HEAD when no remote exists', async () => {
    const repoDir = makeRepo();
    const head = git(repoDir, 'rev-parse', 'HEAD').trim();

    const handle = await createAgentWorktree({ repoDir, name: 'parallel-fix' });

    expect(existsSync(handle.path)).toBe(true);
    expect(path.dirname(handle.path)).toBe(path.join(repoDir, ...WORKTREE_DIR_NAME.split('/')));
    expect(handle.branch).toBe(`${WORKTREE_BRANCH_PREFIX}/parallel-fix`);
    expect(branchExists(repoDir, handle.branch)).toBe(true);
    // The tree materialized at the base commit.
    expect(git(handle.path, 'rev-parse', 'HEAD').trim()).toBe(head);
  });

  it("respects baseRef 'head' over newer remote-tracking refs", async () => {
    const repoDir = makeRepo();
    const oldSha = commitFile(repoDir, 'a.txt', 'one\n');
    const newSha = commitFile(repoDir, 'a.txt', 'two\n');
    // Pretend origin/main was last fetched at the older commit.
    git(repoDir, 'update-ref', 'refs/remotes/origin/main', oldSha);

    const headTree = await createAgentWorktree({ repoDir, name: 'head-based', baseRef: 'head' });
    expect(headTree.baseCommit).toBe(newSha);
    expect(readTreeFile(headTree.path, 'a.txt')).toBe('two\n');
  });

  it("'fresh' resolves to the origin ref even when local HEAD moved on", async () => {
    const repoDir = makeRepo();
    const oldSha = commitFile(repoDir, 'a.txt', 'one\n');
    commitFile(repoDir, 'a.txt', 'two\n');
    git(repoDir, 'update-ref', 'refs/remotes/origin/main', oldSha);

    const fresh = await createAgentWorktree({ repoDir, name: 'fresh-based', baseRef: 'fresh' });
    expect(fresh.baseCommit).toBe(oldSha);
    expect(readTreeFile(fresh.path, 'a.txt')).toBe('one\n');
  });

  it('auto-suffixes colliding names so parallel spawns never clash', async () => {
    const repoDir = makeRepo();
    const first = await createAgentWorktree({ repoDir, name: 'worker' });
    const second = await createAgentWorktree({ repoDir, name: 'worker' });

    expect(first.path).not.toBe(second.path);
    expect(first.branch).not.toBe(second.branch);
    expect(second.name).toBe('worker-2');
    expect(second.branch).toBe(`${WORKTREE_BRANCH_PREFIX}/worker-2`);
    expect(existsSync(second.path)).toBe(true);
  });

  it('appends the hosting directory to .git/info/exclude idempotently', async () => {
    const repoDir = makeRepo();
    await createAgentWorktree({ repoDir, name: 'exclude-a' });
    const excludePath = path.join(repoDir, '.git', 'info', 'exclude');
    const once = readFileSync(excludePath, 'utf8');

    await createAgentWorktree({ repoDir, name: 'exclude-b' });
    const twice = readFileSync(excludePath, 'utf8');

    expect(once).toContain(`${WORKTREE_DIR_NAME}/`);
    expect(twice.split(WORKTREE_DIR_NAME).length).toBe(once.split(WORKTREE_DIR_NAME).length);
    // The hosting directory really is ignored now.
    expect(gitOk(repoDir, 'check-ignore', '-q', `${WORKTREE_DIR_NAME}/probe`)).toBe(true);
  });

  it('rejects directories that are not git repositories', async () => {
    const notARepo = mkdtempSync(path.join(tmpdir(), 'duya-not-repo-'));
    await expect(createAgentWorktree({ repoDir: notARepo, name: 'x' })).rejects.toThrow(/git/i);
  });
});

describe('isAgentWorktreeDirty', () => {
  it('reports clean for a freshly created tree', async () => {
    const repoDir = makeRepo();
    const handle = await createAgentWorktree({ repoDir, name: 'clean-tree' });
    expect(await isAgentWorktreeDirty(handle.path)).toBe(false);
  });

  it('reports dirty for modified and untracked files alike', async () => {
    const repoDir = makeRepo();
    const handle = await createAgentWorktree({ repoDir, name: 'dirty-tree' });

    writeFileSync(path.join(handle.path, 'a.txt'), 'changed\n');
    expect(await isAgentWorktreeDirty(handle.path)).toBe(true);

    git(handle.path, 'checkout', '--', 'a.txt');
    writeFileSync(path.join(handle.path, 'stray.txt'), 'untracked\n');
    expect(await isAgentWorktreeDirty(handle.path)).toBe(true);
  });
});

describe('cleanupIfUnchanged', () => {
  it('removes a zero-change tree together with its branch', async () => {
    const repoDir = makeRepo();
    const handle = await createAgentWorktree({ repoDir, name: 'disposable' });
    const { branch, path: treePath } = handle;

    const outcome = await cleanupIfUnchanged(handle);

    expect(outcome.removed).toBe(true);
    expect(outcome.reason).toBeUndefined();
    expect(existsSync(treePath)).toBe(false);
    expect(branchExists(repoDir, branch)).toBe(false);
  });

  it('keeps a dirty tree and reports why', async () => {
    const repoDir = makeRepo();
    const handle = await createAgentWorktree({ repoDir, name: 'precious' });
    writeFileSync(path.join(handle.path, 'a.txt'), 'real work\n');

    const outcome = await cleanupIfUnchanged(handle);

    expect(outcome.removed).toBe(false);
    expect(outcome.reason).toBe('dirty');
    expect(existsSync(handle.path)).toBe(true);
    expect(branchExists(repoDir, handle.branch)).toBe(true);
  });
});

describe('removeAgentWorktree', () => {
  it('refuses to discard a dirty tree unless forced', async () => {
    const repoDir = makeRepo();
    const handle = await createAgentWorktree({ repoDir, name: 'guarded' });
    writeFileSync(path.join(handle.path, 'a.txt'), 'uncommitted\n');

    const refused = await removeAgentWorktree(handle);
    expect(refused.removed).toBe(false);
    expect(refused.reason).toBeTruthy();
    expect(existsSync(handle.path)).toBe(true);

    const forced = await removeAgentWorktree(handle, { force: true });
    expect(forced.removed).toBe(true);
    expect(existsSync(handle.path)).toBe(false);
    expect(branchExists(repoDir, handle.branch)).toBe(false);
  });
});
