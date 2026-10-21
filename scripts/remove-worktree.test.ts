import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/remove-worktree.sh');
const roots: string[] = [];
const junctions: string[] = [];

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
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  git(repo, ['worktree', 'add', '-b', 'feature/x', worktree]);
  return { repo, worktree };
}

function removeWt(cwd: string, target: string, extra: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync('bash', [toBashPath(SCRIPT), toBashPath(target), ...extra], {
    cwd,
    encoding: 'utf8',
    env,
    shell: false,
  });
}

afterEach(() => {
  for (const junction of junctions.splice(0)) {
    try {
      lstatSync(junction);
      rmdirSync(junction);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
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

  it.skipIf(process.platform !== 'win32')('unlinks a temporary junction without touching its target', () => {
    const { repo, worktree } = makeRepo();
    const root = roots[roots.length - 1];
    const target = join(root, 'junction-target');
    const marker = join(target, 'keep.txt');
    const junction = join(worktree, 'node_modules');
    mkdirSync(target);
    writeFileSync(marker, 'keep me\n');
    symlinkSync(target, junction, 'junction');
    junctions.push(junction);

    const result = removeWt(repo, worktree);

    expect(result.status).toBe(0);
    expect(existsSync(worktree)).toBe(false);
    expect(readFileSync(marker, 'utf8')).toBe('keep me\n');
  });

  it('removes a clean worktree and keeps the branch', () => {
    const { repo, worktree } = makeRepo();

    const result = removeWt(repo, worktree);

    expect(result.status).toBe(0);
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, ['branch', '--list', 'feature/x'])).toContain('feature/x');
  });

  it('retains a clean detached worktree whose HEAD has no branch, remote, or tag ref', () => {
    const { repo, worktree } = makeRepo();
    git(worktree, ['checkout', '--detach']);
    writeFileSync(join(worktree, 'README.md'), 'detached commit\\n');
    git(worktree, ['add', 'README.md']);
    git(worktree, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'detached-only']);
    const detachedHead = git(worktree, ['rev-parse', 'HEAD']).trim();
    const containingRefs = git(worktree, [
      'for-each-ref', '--contains=HEAD', '--format=%(refname)',
      'refs/heads', 'refs/remotes', 'refs/tags',
    ]).trim();
    expect(containingRefs).toBe('');

    const result = removeWt(repo, worktree);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('detached HEAD is not contained');
    expect(existsSync(worktree)).toBe(true);
    expect(git(worktree, ['rev-parse', 'HEAD']).trim()).toBe(detachedHead);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(toBashPath(worktree));
  });
  it('does not let --force remove a dirty worktree', () => {
    const { repo, worktree } = makeRepo();
    writeFileSync(join(worktree, 'README.md'), 'changed\n');

    const result = removeWt(repo, worktree, ['--force']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown option: --force');
    expect(existsSync(worktree)).toBe(true);
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('changed\n');
  });

  it('does not call git remove when the reparse-point scan fails', () => {
    const { repo, worktree } = makeRepo();
    const shimDir = join(tmpdir(), 'duya-scan-failure-' + process.pid + '-' + roots.length);
    mkdirSync(shimDir, { recursive: true });
    roots.push(shimDir);
    const scanner = join(shimDir, process.platform === 'win32' ? 'powershell.exe' : 'find');
    writeFileSync(scanner, '#!/bin/sh\necho controlled-scan-failure >&2\nexit 23\n');
    chmodSync(scanner, 0o755);
    const env = { ...process.env, PATH: shimDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? '') };

    const result = removeWt(repo, worktree, [], env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('controlled-scan-failure');
    expect(result.stderr).toContain('could not scan reparse points');
    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(toBashPath(worktree));
  });

  it.skipIf(process.platform !== 'win32')('refuses Windows removal when PowerShell is missing instead of using find', () => {
    const { repo, worktree } = makeRepo();
    const shimDir = join(tmpdir(), 'duya-missing-powershell-' + process.pid + '-' + roots.length);
    mkdirSync(shimDir, { recursive: true });
    roots.push(shimDir);
    const scannerMarker = join(shimDir, 'find-called');
    const findShim = join(shimDir, 'find');
    writeFileSync(findShim, [
      '#!/bin/sh',
      ': > "$DUYA_FIND_MARKER"',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(findShim, 0o755);
    const env = {
      ...process.env,
      OS: 'Windows_NT',
      DUYA_FIND_MARKER: scannerMarker,
      PATH: [
        shimDir,
        'C:\\Program Files\\Git\\bin',
        'C:\\Program Files\\Git\\usr\\bin',
        'C:\\Program Files\\Git\\cmd',
      ].join(';'),
    };

    const result = removeWt(repo, worktree, [], env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PowerShell is required');
    expect(existsSync(scannerMarker)).toBe(false);
    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(toBashPath(worktree));
  });

  it('does not call git remove when the post-unlink scan fails', () => {
    const { repo, worktree } = makeRepo();
    const shimDir = join(tmpdir(), 'duya-rescan-failure-' + process.pid + '-' + roots.length);
    mkdirSync(shimDir, { recursive: true });
    roots.push(shimDir);
    const scanner = join(shimDir, process.platform === 'win32' ? 'powershell.exe' : 'find');
    const stateFile = join(shimDir, 'scan-state');
    writeFileSync(scanner, [
      '#!/bin/sh',
      'if [ -e "$DUYA_SCAN_STATE" ]; then echo controlled-rescan-failure >&2; exit 23; fi',
      ': > "$DUYA_SCAN_STATE"',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(scanner, 0o755);
    const env = {
      ...process.env,
      DUYA_SCAN_STATE: stateFile,
      PATH: shimDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? ''),
    };

    const result = removeWt(repo, worktree, [], env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('controlled-rescan-failure');
    expect(result.stderr).toContain('could not verify reparse-point removal');
    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(toBashPath(worktree));
  });

  it('refuses a scanner path that escapes the worktree', () => {
    const { repo, worktree } = makeRepo();
    const shimDir = join(tmpdir(), 'duya-scan-escape-' + process.pid + '-' + roots.length);
    mkdirSync(shimDir, { recursive: true });
    roots.push(shimDir);
    const scanner = join(shimDir, process.platform === 'win32' ? 'powershell.exe' : 'find');
    writeFileSync(scanner, ['#!/bin/sh', 'printf "%s/../outside/link\\n" "$DUYA_REPARSE_SCAN_ROOT"', 'exit 0', ''].join('\n'));
    chmodSync(scanner, 0o755);
    const env = { ...process.env, PATH: shimDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? '') };

    const result = removeWt(repo, worktree, [], env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('non-canonical path');
    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(toBashPath(worktree));
  });

  it('refuses a locked worktree and leaves it registered', () => {
    const { repo, worktree } = makeRepo();
    git(repo, ['worktree', 'lock', worktree]);

    const result = removeWt(repo, worktree);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('git has it locked');
    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(toBashPath(worktree));
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
