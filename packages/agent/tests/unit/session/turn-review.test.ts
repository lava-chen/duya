import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureTurnReviewBaseline, completeTurnReview } from '../../../src/session/turn-review';

const workspaces: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function createRepository(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'duya-turn-review-test-'));
  workspaces.push(cwd);
  git(cwd, ['init']);
  git(cwd, ['config', 'user.email', 'turn-review@example.test']);
  git(cwd, ['config', 'user.name', 'Turn Review Test']);
  writeFileSync(join(cwd, 'tracked.txt'), 'before\n');
  git(cwd, ['add', 'tracked.txt']);
  git(cwd, ['commit', '-m', 'initial']);
  return cwd;
}

afterEach(() => {
  while (workspaces.length > 0) {
    rmSync(workspaces.pop()!, { recursive: true, force: true });
  }
});

describe('turn review snapshots', () => {
  it('captures only the worktree delta made during the turn without touching the real index', () => {
    const cwd = createRepository();
    writeFileSync(join(cwd, 'pre-existing.txt'), 'already staged\n');
    git(cwd, ['add', 'pre-existing.txt']);

    const baseline = captureTurnReviewBaseline(cwd);
    expect(baseline).not.toBeNull();

    writeFileSync(join(cwd, 'tracked.txt'), 'after\n');
    writeFileSync(join(cwd, 'new-file.txt'), 'new\n');

    const review = completeTurnReview(baseline!);
    expect(review?.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt', status: 'modified', additions: 1, removals: 1 }),
      expect.objectContaining({ path: 'new-file.txt', status: 'added', additions: 1, removals: 0 }),
    ]));
    expect(review?.files.some((file) => file.path === 'pre-existing.txt')).toBe(false);
    expect(review?.patch).toContain('diff --git a/tracked.txt b/tracked.txt');
    expect(git(cwd, ['diff', '--cached', '--name-only']).trim()).toBe('pre-existing.txt');
  });
});
