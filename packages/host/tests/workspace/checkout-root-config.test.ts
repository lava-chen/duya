/**
 * `desktop.git-worktree-root` against real repositories.
 *
 * The provider must honour the configured root for new checkouts while still
 * listing checkouts created under an earlier root — the marker in the
 * checkout's git directory is what survives the configuration change.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { git, makeRepo, tempDir, useIsolatedDataRoot } from './fixtures.js';
import { GitCheckoutProvider } from '../../src/workspace/checkout-provider.js';

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

function writeConfig(root: string | null): void {
  const file = path.join(dataRoot, 'config.toml');
  if (root === null) {
    try {
      unlinkSync(file);
    } catch {
      // Already absent.
    }
    return;
  }
  writeFileSync(file, `[desktop]\ngit-worktree-root = ${JSON.stringify(root)}\n`);
}

function provider(warn?: (message: string, fields?: Record<string, unknown>) => void): GitCheckoutProvider {
  return new GitCheckoutProvider({
    isSessionAlive: async () => false,
    cwdInUse: async () => false,
    ...(warn ? { warn } : {}),
  });
}

describe('configured worktree root', () => {
  it('creates checkouts under the configured root with the duya layout', async () => {
    const repo = makeRepo();
    const customRoot = tempDir('duya-custom-root-');
    writeConfig(customRoot);

    const checkout = await provider().create({
      sourceCwd: repo,
      ownerSessionId: '',
      label: 'custom root case',
    });

    const relative = path.relative(customRoot, checkout.root);
    expect(relative.startsWith('..')).toBe(false);
    const [repoKey, checkoutName] = relative.split(path.sep);
    expect(repoKey).toMatch(/-[0-9a-f]{12}$/);
    expect(checkoutName).toMatch(/^custom-root-case-[0-9a-f]{6}$/);

    const origin = JSON.parse(
      readFileSync(
        git(checkout.root, 'rev-parse', '--path-format=absolute', '--git-path', 'duya-checkout.json'),
        'utf8',
      ),
    );
    expect(origin.baseSha).toBe(checkout.baseSha);
    expect(Number.isFinite(origin.createdAt)).toBe(true);

    await provider().reclaim(checkout.root);
  }, 60_000);

  it('keeps listing a checkout after the configured root changes', async () => {
    const repo = makeRepo();
    const firstRoot = tempDir('duya-first-root-');
    const secondRoot = tempDir('duya-second-root-');

    writeConfig(firstRoot);
    const first = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'before change' });

    writeConfig(secondRoot);
    const second = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'after change' });
    expect(path.relative(firstRoot, first.root).startsWith('..')).toBe(false);
    expect(path.relative(secondRoot, second.root).startsWith('..')).toBe(false);

    const listed = (await provider().list(repo)).map((entry) => entry.root).sort();
    expect(listed).toEqual([first.root, second.root].sort());

    // The marker, not the configuration, is what keeps the old checkout visible.
    writeConfig(null);
    const afterReset = (await provider().list(repo)).map((entry) => entry.root).sort();
    expect(afterReset).toEqual([first.root, second.root].sort());

    await provider().reclaim(first.root);
    await provider().reclaim(second.root);
  }, 60_000);

  it('does not present a hand-made worktree as managed', async () => {
    const repo = makeRepo();
    const customRoot = tempDir('duya-custom-root-');
    writeConfig(customRoot);
    const managed = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'managed' });

    const outsider = path.join(tempDir('duya-outsider-'), 'manual-checkout');
    git(repo, 'worktree', 'add', '--detach', outsider, 'HEAD');

    const listed = await provider().list(repo);
    expect(listed.map((entry) => entry.root)).toEqual([managed.root]);

    await provider().reclaim(managed.root);
  }, 60_000);

  it('warns about an invalid root and falls back to the default root', async () => {
    const repo = makeRepo();
    writeConfig('relative/worktrees');
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];

    const checkout = await provider((message, fields) => warnings.push({ message, fields })).create({
      sourceCwd: repo,
      ownerSessionId: '',
      label: 'fallback case',
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields?.problem).toBe('desktop.git-worktree-root must be an absolute path');
    expect(path.relative(path.join(dataRoot, 'worktrees'), checkout.root).startsWith('..')).toBe(false);

    await provider().reclaim(checkout.root);
  }, 60_000);
});
