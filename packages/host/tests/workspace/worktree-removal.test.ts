/**
 * Fail-closed reclamation (plan 621 §4.5).
 *
 * Each case mutates exactly one precondition and asserts two things: the
 * verdict names that precondition, and the checkout is still on disk. The
 * second assertion is the one that matters — a correct reason with a deleted
 * directory is still data loss.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { git, makeRepo, tempDir, useIsolatedDataRoot } from './fixtures.js';
import { GitCheckoutProvider } from '../../src/workspace/checkout-provider.js';
import { scanReparsePoints, unlinkReparsePoint } from '../../src/workspace/fs-utils.js';

let restoreDataRoot: () => void = () => undefined;

beforeAll(() => {
  restoreDataRoot = useIsolatedDataRoot();
});

afterAll(() => {
  restoreDataRoot();
});

function provider(): GitCheckoutProvider {
  // Both facts are injected as "nothing is alive / nothing is using it", so a
  // refusal can only come from the checkout's own state.
  return new GitCheckoutProvider({
    isSessionAlive: async () => false,
    cwdInUse: async () => false,
  });
}

async function freshCheckout(options: { gitignore?: string } = {}) {
  const repo = makeRepo(options);
  const api = provider();
  const checkout = await api.create({ sourceCwd: repo, ownerSessionId: '', label: 'reclaim case' });
  return { repo, api, checkout };
}

describe('reclaim refusal matrix', () => {
  it('retains a checkout with tracked modifications', async () => {
    const { repo, api, checkout } = await freshCheckout();
    writeFileSync(path.join(checkout.root, 'README.md'), '# edited\n');

    const verdict = await api.reclaim(checkout.root);
    expect(verdict).toEqual({ removed: false, reason: 'dirty_tracked' });
    expect(existsSync(checkout.root)).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(checkout.root.replace(/\\/g, '/'));
  }, 60_000);

  it('retains a checkout with untracked files', async () => {
    const { api, checkout } = await freshCheckout();
    writeFileSync(path.join(checkout.root, 'notes.txt'), 'scratch\n');

    expect(await api.reclaim(checkout.root)).toEqual({ removed: false, reason: 'untracked' });
    expect(existsSync(path.join(checkout.root, 'notes.txt'))).toBe(true);
  }, 60_000);

  it('retains a checkout with ignored files', async () => {
    const { api, checkout } = await freshCheckout({ gitignore: '*.log\n' });
    writeFileSync(path.join(checkout.root, 'debug.log'), 'noise\n');

    expect(await api.reclaim(checkout.root)).toEqual({ removed: false, reason: 'ignored' });
    expect(existsSync(path.join(checkout.root, 'debug.log'))).toBe(true);
  }, 60_000);

  it('retains a locked checkout', async () => {
    const { repo, api, checkout } = await freshCheckout();
    git(repo, 'worktree', 'lock', checkout.root);
    try {
      expect(await api.reclaim(checkout.root)).toEqual({ removed: false, reason: 'locked' });
      expect(existsSync(checkout.root)).toBe(true);
    } finally {
      git(repo, 'worktree', 'unlock', checkout.root);
    }
  }, 60_000);

  it('retains a detached HEAD that no ref contains', async () => {
    const { api, checkout } = await freshCheckout();
    git(
      checkout.root,
      '-c',
      'user.email=test@duya.local',
      '-c',
      'user.name=duya test',
      'commit',
      '--allow-empty',
      '-m',
      'unreferenced work',
    );

    expect(await api.reclaim(checkout.root)).toEqual({
      removed: false,
      reason: 'detached_unreferenced',
    });
    expect(existsSync(checkout.root)).toBe(true);
  }, 60_000);

  it('retains a directory that is no longer registered with git', async () => {
    const { api, checkout } = await freshCheckout();
    const adminDir = git(checkout.root, 'rev-parse', '--absolute-git-dir');
    rmSync(adminDir, { recursive: true, force: true });

    expect(await api.reclaim(checkout.root)).toEqual({ removed: false, reason: 'not_registered' });
    expect(existsSync(checkout.root)).toBe(true);
  }, 60_000);

  it('retains a checkout whose owner is still alive', async () => {
    const repo = makeRepo();
    const checkout = await new GitCheckoutProvider({ isSessionAlive: async () => false }).create({
      sourceCwd: repo,
      ownerSessionId: 'session-owner',
      label: 'owned retain',
    });

    const alive = new GitCheckoutProvider({ isSessionAlive: async () => true });
    expect(await alive.reclaim(checkout.root)).toEqual({ removed: false, reason: 'owner_alive' });
    expect(existsSync(checkout.root)).toBe(true);
  }, 60_000);

  it('retains a checkout that hosts an active run cwd', async () => {
    const { checkout } = await freshCheckout();
    const inUse = new GitCheckoutProvider({
      isSessionAlive: async () => false,
      cwdInUse: async () => true,
    });

    expect(await inUse.reclaim(checkout.root)).toEqual({ removed: false, reason: 'cwd_inside' });
    expect(existsSync(checkout.root)).toBe(true);
  }, 60_000);
});

describe('reclaim success', () => {
  it('removes a clean, unowned, referenced checkout and its empty bucket', async () => {
    const { repo, api, checkout } = await freshCheckout();
    const bucket = path.dirname(checkout.root);

    expect(await api.reclaim(checkout.root)).toEqual({ removed: true });
    expect(existsSync(checkout.root)).toBe(false);
    expect(existsSync(bucket)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(checkout.root.replace(/\\/g, '/'));
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/duya-checkout-data/g) ?? []).toHaveLength(0);
  }, 60_000);
});

describe('reparse points', () => {
  it('scans without following links and unlinks only the link itself', async () => {
    const root = tempDir('duya-reparse-root-');
    const target = tempDir('duya-reparse-target-');
    writeFileSync(path.join(target, 'keep.txt'), 'must survive\n');
    const link = path.join(root, 'node_modules');
    symlinkSync(target, link, 'junction');

    const scan = scanReparsePoints(root);
    expect(scan.complete).toBe(true);
    expect(scan.links).toEqual([link]);

    unlinkReparsePoint(link);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(path.join(target, 'keep.txt'))).toBe(true);
  });

  it('reports a junction as reparse_point and still removes the checkout safely', async () => {
    const { api, checkout } = await freshCheckout();
    // An EMPTY target directory: git does not track empty directories, so the
    // link is invisible to `status`, `ls-files --others` and `--ignored`. That
    // is exactly the case the unlink-then-rescan step exists for.
    const target = tempDir('duya-junction-target-');
    const link = path.join(checkout.root, 'linked');
    symlinkSync(target, link, 'junction');
    expect(git(checkout.root, 'status', '--porcelain')).toBe('');

    const observed = await api.observe(checkout.root);
    expect(observed.reclaim).toEqual({ ok: false, reason: 'reparse_point' });

    expect(await api.reclaim(checkout.root)).toEqual({ removed: true });
    expect(existsSync(checkout.root)).toBe(false);
    expect(existsSync(target)).toBe(true);
  }, 60_000);

  it('retains the checkout when a link survives the unlink attempt', async () => {
    const { api, checkout } = await freshCheckout();
    const target = tempDir('duya-junction-target-');
    // A directory link that git DOES see: this time the tree is untracked, so
    // the refusal happens before any unlink, and the target is untouched.
    mkdirSync(path.join(target, 'nested'), { recursive: true });
    writeFileSync(path.join(target, 'nested', 'keep.txt'), 'must survive\n');
    symlinkSync(target, path.join(checkout.root, 'linked'), 'junction');

    const verdict = await api.reclaim(checkout.root);
    expect(verdict.removed).toBe(false);
    expect(existsSync(path.join(target, 'nested', 'keep.txt'))).toBe(true);
    expect(existsSync(checkout.root)).toBe(true);
  }, 60_000);
});
