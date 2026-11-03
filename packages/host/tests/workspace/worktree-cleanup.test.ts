/**
 * Retention-based cleanup against real repositories.
 *
 * The selection is tested here; the refusal matrix itself is owned by
 * `worktree-removal.test.ts`. What matters at this level is that cleanup never
 * softens a refusal: a dirty, untracked, ignored, owned or locked checkout must
 * survive a run even when it is the oldest candidate.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { git, makeRepo, tempDir, useIsolatedDataRoot } from './fixtures.js';
import { GitCheckoutProvider } from '../../src/workspace/checkout-provider.js';
import type { CheckoutRoot } from '../../src/workspace/types.js';

let restoreDataRoot: () => void = () => undefined;
let dataRoot = '';

beforeAll(() => {
  restoreDataRoot = useIsolatedDataRoot();
  dataRoot = process.env.DUYA_APP_DATA_PATH ?? '';
});

beforeEach(() => {
  writeConfig(null);
});

afterAll(() => {
  writeConfig(null);
  restoreDataRoot();
});

function writeConfig(desktop: Record<string, string> | null): void {
  const file = path.join(dataRoot, 'config.toml');
  if (desktop === null) {
    try {
      unlinkSync(file);
    } catch {
      // Already absent.
    }
    return;
  }
  const lines = Object.entries(desktop).map(([key, value]) => `${key} = ${value}`);
  writeFileSync(file, `[desktop]\n${lines.join('\n')}\n`);
}

function provider(alive: readonly string[] = []): GitCheckoutProvider {
  return new GitCheckoutProvider({
    isSessionAlive: async (sessionId) => alive.includes(sessionId),
    cwdInUse: async () => false,
  });
}

function setCreatedAt(checkout: CheckoutRoot, createdAt: number): void {
  const file = git(checkout.root, 'rev-parse', '--path-format=absolute', '--git-path', 'duya-checkout.json');
  const origin = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...origin, createdAt }));
}

async function makeCheckouts(repo: string, count: number, owner = ''): Promise<CheckoutRoot[]> {
  const api = provider();
  const checkouts: CheckoutRoot[] = [];
  for (let index = 0; index < count; index += 1) {
    checkouts.push(await api.create({ sourceCwd: repo, ownerSessionId: owner, label: `checkout ${index}` }));
  }
  return checkouts;
}

describe('runWorktreeCleanup', () => {
  it('reclaims all but the newest keepCount checkouts of one repository', async () => {
    const repo = makeRepo();
    writeConfig({ 'worktree-keep-count': '2' });
    const checkouts = await makeCheckouts(repo, 3);
    checkouts.forEach((checkout, index) => setCreatedAt(checkout, (index + 1) * 1000));

    const result = await provider().cleanup({ sourceCwd: repo });

    expect(result.keepCount).toBe(2);
    expect(result.examined).toBe(3);
    expect(result.removed).toEqual([checkouts[0]!.root]);
    expect(result.retained).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(existsSync(checkouts[0]!.root)).toBe(false);
    expect(existsSync(checkouts[1]!.root)).toBe(true);
    expect(existsSync(checkouts[2]!.root)).toBe(true);
    // The source checkout and its registration are untouched.
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(checkouts[0]!.root.replace(/\\/g, '/'));
  }, 120_000);

  it('reports candidates without deleting anything on a dry run', async () => {
    const repo = makeRepo();
    writeConfig({ 'worktree-keep-count': '1' });
    const checkouts = await makeCheckouts(repo, 2);
    checkouts.forEach((checkout, index) => setCreatedAt(checkout, (index + 1) * 1000));

    const result = await provider().cleanup({ sourceCwd: repo, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.removed).toEqual([checkouts[0]!.root]);
    expect(existsSync(checkouts[0]!.root)).toBe(true);
    expect(existsSync(checkouts[1]!.root)).toBe(true);
  }, 120_000);

  it('keeps dirty, untracked, ignored and live-owned checkouts', async () => {
    const repo = makeRepo({ gitignore: 'cache/\n' });
    writeConfig({ 'worktree-keep-count': '1' });
    const checkouts = await makeCheckouts(repo, 4);
    const owned = await provider().create({ sourceCwd: repo, ownerSessionId: 'live-owner', label: 'owned' });
    const [dirty, untracked, ignored, kept] = checkouts as [CheckoutRoot, CheckoutRoot, CheckoutRoot, CheckoutRoot];

    setCreatedAt(dirty, 1000);
    setCreatedAt(untracked, 2000);
    setCreatedAt(ignored, 3000);
    setCreatedAt(kept, 4000);
    setCreatedAt(owned, 500);

    writeFileSync(path.join(dirty.root, 'README.md'), '# dirty\n');
    writeFileSync(path.join(untracked.root, 'untracked.txt'), 'keep me\n');
    mkdirSync(path.join(ignored.root, 'cache'), { recursive: true });
    writeFileSync(path.join(ignored.root, 'cache', 'ignored.txt'), 'keep me too\n');

    const result = await provider(['live-owner']).cleanup({ sourceCwd: repo });

    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual([
      { root: ignored.root, reason: 'ignored' },
      { root: untracked.root, reason: 'untracked' },
      { root: dirty.root, reason: 'dirty_tracked' },
      { root: owned.root, reason: 'owner_alive' },
    ]);
    for (const checkout of [...checkouts, owned]) expect(existsSync(checkout.root)).toBe(true);
  }, 180_000);

  it('keeps a locked checkout even when it is the oldest candidate', async () => {
    const repo = makeRepo();
    writeConfig({ 'worktree-keep-count': '1' });
    const checkouts = await makeCheckouts(repo, 2);
    checkouts.forEach((checkout, index) => setCreatedAt(checkout, (index + 1) * 1000));
    git(repo, 'worktree', 'lock', checkouts[0]!.root);

    const result = await provider().cleanup({ sourceCwd: repo });

    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual([{ root: checkouts[0]!.root, reason: 'locked' }]);
    expect(existsSync(checkouts[0]!.root)).toBe(true);
  }, 120_000);

  it('returns nothing for a directory that is not a repository', async () => {
    const plain = tempDir('duya-plain-cleanup-');
    const result = await provider().cleanup({ sourceCwd: plain });
    expect(result).toMatchObject({ examined: 0, removed: [], retained: [], failed: [] });
  });
});

describe('automatic cleanup on create', () => {
  it('does nothing when the switch is off', async () => {
    const repo = makeRepo();
    writeConfig({ 'worktree-keep-count': '1' });
    const checkouts = await makeCheckouts(repo, 2);
    for (const checkout of checkouts) expect(existsSync(checkout.root)).toBe(true);
  }, 120_000);

  it('never removes the checkout it just created', async () => {
    const repo = makeRepo();
    writeConfig({
      'worktree-auto-cleanup-enabled': 'true',
      'worktree-keep-count': '1',
    });
    const first = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'first' });
    setCreatedAt(first, 1000);
    const second = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'second' });

    expect(existsSync(second.root)).toBe(true);
    // The retention pass kept the newest, i.e. the one created by this call.
    expect(existsSync(first.root)).toBe(false);
  }, 120_000);
});

describe('discoverManagedRepos', () => {
  it('finds the repository behind a checkout under the configured root', async () => {
    const repo = makeRepo();
    const customRoot = tempDir('duya-discovered-root-');
    writeConfig({ 'git-worktree-root': JSON.stringify(customRoot) });
    await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'discoverable' });

    expect(await provider().discoverManagedRepos()).toContain(path.resolve(repo));
  }, 120_000);
});
