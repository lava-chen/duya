/**
 * Goal repo-changes tests (grok repo_changes/, duya-ized light).
 *
 * Uses a real throwaway git repo to verify baseline capture and diff
 * serialization, plus the no-git / no-baseline degraded paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { captureBaselineCommit, serializeRepoChanges, MAX_DIFF_BYTES } from '../goal-changes.js';

let repo = '';

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-changes-'));
  git('init', '-q');
  git('config', 'user.email', 't@t.co');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n', 'utf-8');
  git('add', 'a.txt');
  git('commit', '-qm', 'base');
});

afterEach(() => {
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('captureBaselineCommit', () => {
  it('captures HEAD in a real repo', () => {
    const commit = captureBaselineCommit(repo);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns undefined outside a repo / with no dir', () => {
    expect(captureBaselineCommit(undefined)).toBeUndefined();
    expect(captureBaselineCommit(path.join(repo, 'missing'))).toBeUndefined();
  });
});

describe('serializeRepoChanges', () => {
  it('serializes a stat + patch for changed files', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n', 'utf-8');
    const base = captureBaselineCommit(repo)!;
    const out = serializeRepoChanges(repo, base);
    expect(out).toBeTruthy();
    expect(out).toContain('## Changed files (vs baseline)');
    expect(out).toContain('a.txt');
    expect(out).toContain('## Diff (bounded)');
    expect(out).toContain('+two');
  });

  it('returns undefined when nothing changed', () => {
    const base = captureBaselineCommit(repo)!;
    expect(serializeRepoChanges(repo, base)).toBeUndefined();
  });

  it('returns undefined without a baseline or git', () => {
    expect(serializeRepoChanges(repo, '')).toBeUndefined();
    expect(serializeRepoChanges(repo, 'deadbeef')).toBeUndefined(); // bad ref
    expect(serializeRepoChanges(path.join(repo, 'missing'), 'abc1234')).toBeUndefined();
  });

  it('caps the diff body at MAX_DIFF_BYTES with a truncation marker', () => {
    const big = 'x'.repeat(20_000) + '\n';
    fs.writeFileSync(path.join(repo, 'big.txt'), big, 'utf-8');
    git('add', 'big.txt'); // track it so `git diff <base>` sees the change
    const base = captureBaselineCommit(repo)!;
    const out = serializeRepoChanges(repo, base);
    expect(out).toBeTruthy();
    expect(out!.length).toBeLessThan(MAX_DIFF_BYTES + 2048);
  });
});
