import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/remove-worktree.sh');
const roots: string[] = [];

/**
 * bash (MSYS) treats a backslash in an argument as an escape character and
 * cannot open a `C:\...` path, so every path handed to it goes in with
 * forward slashes.
 */
function toBashPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function haveBash(): boolean {
  try {
    execFileSync('bash', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const BASH = haveBash();

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A repo with one commit on `master` and one linked worktree on `feature/x`. */
function makeRepo(): { repo: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), 'duya-remove-wt-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const worktree = join(root, 'wt');
  execFileSync('git', ['init', '-b', 'master', repo], { stdio: 'ignore' });
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'test']);
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  git(repo, ['worktree', 'add', '-b', 'feature/x', worktree]);
  return { repo, worktree };
}

function removeWt(cwd: string, target: string, extra: string[] = []) {
  return spawnSync('bash', [toBashPath(SCRIPT), toBashPath(target), ...extra], {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!BASH)('remove-worktree.sh is fail-closed', () => {
  it('refuses a directory that is not a registered worktree and leaves it untouched', () => {
    const { repo } = makeRepo();
    const plain = join(repo, 'packages');
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, 'keep.ts'), 'export const keep = true;\n');
    const result = removeWt(repo, plain);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not a linked git worktree');
    expect(existsSync(join(plain, 'keep.ts'))).toBe(true);
  });

  it('refuses the primary checkout', () => {
    const { repo } = makeRepo();
    const result = removeWt(repo, repo);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('primary checkout');
    expect(existsSync(join(repo, 'README.md'))).toBe(true);
  });

  it('refuses a dirty worktree and keeps the uncommitted changes', () => {
    const { repo, worktree } = makeRepo();
    writeFileSync(join(worktree, 'README.md'), 'changed\n');

    const result = removeWt(repo, worktree);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('uncommitted changes');
    expect(existsSync(worktree)).toBe(true);
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('changed\n');
  });

  it('removes a clean worktree and keeps the branch', () => {
    const { repo, worktree } = makeRepo();

    const result = removeWt(repo, worktree);

    expect(result.status).toBe(0);
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, ['branch', '--list', 'feature/x'])).toContain('feature/x');
  });

  it('preserves dirty work under a snapshot when --force is given', () => {
    const { repo, worktree } = makeRepo();
    writeFileSync(join(worktree, 'README.md'), 'forced\n');

    const result = removeWt(repo, worktree, ['--force']);

    expect(result.status).toBe(0);
    expect(existsSync(worktree)).toBe(false);
    const snapshots = join(repo, '.claude', 'worktree-snapshots');
    expect(existsSync(snapshots)).toBe(true);
    const entries = execFileSync('bash', ['-c', `ls "${toBashPath(snapshots)}"`], { encoding: 'utf8' });
    expect(entries.trim().length).toBeGreaterThan(0);
    const patch = execFileSync(
      'bash',
      ['-c', `cat "${toBashPath(snapshots)}"/*/worktree.patch`],
      { encoding: 'utf8' },
    );
    expect(patch).toContain('forced');
  });

  it('changes nothing in --dry-run mode', () => {
    const { repo, worktree } = makeRepo();

    const result = removeWt(repo, worktree, ['--dry-run']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[dry-run]');
    expect(existsSync(worktree)).toBe(true);
  });

  it('deletes a merged branch only with --delete-branch', () => {
    const { repo, worktree } = makeRepo();
    git(repo, ['checkout', 'master']);
    git(repo, ['merge', '--no-ff', '-m', 'merge feature', 'feature/x']);

    const result = removeWt(repo, worktree, ['--delete-branch']);

    expect(result.status).toBe(0);
    expect(git(repo, ['branch', '--list', 'feature/x'])).not.toContain('feature/x');
  });
});
