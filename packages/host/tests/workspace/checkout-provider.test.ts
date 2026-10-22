/**
 * `GitCheckoutProvider` behaviour against real repositories.
 *
 * Everything here is a real `git` invocation — no stubs — because the whole
 * point of the provider is that git is the authority. The only injected
 * ports are the two observable facts the provider cannot see by itself
 * (`isSessionAlive`, `cwdInUse`), and they are injected so tests can assert
 * both the alive and the dead branch without a run table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { git, makeRepo, tempDir, useIsolatedDataRoot, withCeiling } from './fixtures.js';
import { createCheckoutProvider, GitCheckoutProvider } from '../../src/workspace/checkout-provider.js';
import { CheckoutError, CheckoutOwnerError } from '../../src/workspace/errors.js';

let restoreDataRoot: () => void = () => undefined;

beforeAll(() => {
  restoreDataRoot = useIsolatedDataRoot();
});

afterAll(() => {
  restoreDataRoot();
});

function provider(overrides: { alive?: boolean; cwdInUse?: boolean } = {}): GitCheckoutProvider {
  return new GitCheckoutProvider({
    isSessionAlive: async () => overrides.alive ?? false,
    cwdInUse: async () => overrides.cwdInUse ?? false,
  });
}

describe('create', () => {
  it('materialises a detached checkout at the base commit with a clean tree', async () => {
    const repo = makeRepo();
    const checkout = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'clean case' });

    expect(git(checkout.cwd, 'rev-parse', 'HEAD')).toBe(checkout.baseSha);
    expect(checkout.baseSha).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(git(checkout.cwd, 'status', '--porcelain')).toBe('');
    expect(git(checkout.cwd, 'branch', '--show-current')).toBe('');

    // Outside the user's checkout, and reported as a detached worktree.
    expect(path.resolve(checkout.root).startsWith(path.resolve(repo) + path.sep)).toBe(false);
    const list = git(repo, 'worktree', 'list', '--porcelain');
    expect(list).toContain(checkout.root.replace(/\\/g, '/'));
    expect(list).toContain('detached');

    // `cwd` is the caller's landing directory, not the checkout root by accident.
    expect(checkout.cwd).toBe(checkout.root);
    expect(checkout.sourceRoot).toBe(path.resolve(repo));
    expect(checkout.sourceCwd).toBe(path.resolve(repo));

    await provider().reclaim(checkout.root);
  }, 60_000);

  it('preserves the source subdirectory in cwd', async () => {
    const repo = makeRepo({ subdirectory: 'packages/host' });
    const sourceCwd = path.join(repo, 'packages', 'host');
    const checkout = await provider().create({ sourceCwd, ownerSessionId: '', label: 'nested case' });

    expect(checkout.root).not.toBe(checkout.cwd);
    expect(checkout.cwd).toBe(path.join(checkout.root, 'packages', 'host'));
    expect(existsSync(path.join(checkout.cwd, 'README.md'))).toBe(true);
    expect(checkout.sourceCwd).toBe(path.resolve(sourceCwd));

    await provider().reclaim(checkout.root);
  }, 60_000);

  it('pins core.worktree so the checkout does not resolve back to the source repo', async () => {
    const repo = makeRepo();
    const checkout = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'config case' });

    const gitDir = git(checkout.root, 'rev-parse', '--absolute-git-dir');
    const commonDir = git(checkout.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    expect(path.resolve(gitDir)).not.toBe(path.resolve(commonDir));

    await provider().reclaim(checkout.root);
  }, 60_000);

  it('refuses a plain directory without leaving a registration behind', async () => {
    const plain = tempDir('duya-plain-create-');
    await withCeiling(plain, async () => {
      await expect(
        provider().create({ sourceCwd: plain, ownerSessionId: '', label: 'x' }),
      ).rejects.toMatchObject({ code: 'not_a_git_repo' });
    });
  });

  it('refuses a repository with no HEAD', async () => {
    const empty = tempDir('duya-empty-create-');
    git(empty, 'init', '-q', '-b', 'main');
    await expect(
      provider().create({ sourceCwd: empty, ownerSessionId: '', label: 'x' }),
    ).rejects.toMatchObject({ code: 'no_head' });
  });

  it('refuses an uncommitted working tree and registers no worktree', async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, 'README.md'), '# changed\n');

    await expect(
      provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'x' }),
    ).rejects.toMatchObject({ code: 'dirty_worktree' });
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('duya-checkout-data');
  });

  it('binds the owner at creation when a session is supplied', async () => {
    const repo = makeRepo();
    const checkout = await provider().create({
      sourceCwd: repo,
      ownerSessionId: 'session-owner',
      label: 'owned case',
    });

    const observed = await provider({ alive: false }).observe(checkout.root);
    expect(observed.owner).toMatchObject({ sessionId: 'session-owner' });

    await provider().reclaim(checkout.root);
  }, 60_000);
});

describe('list', () => {
  it('returns only managed checkouts of this repository', async () => {
    const repo = makeRepo();
    const managed = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'listed' });

    const outsider = path.join(tempDir('duya-outsider-'), 'manual-checkout');
    git(repo, 'worktree', 'add', '--detach', outsider, 'HEAD');

    const listed = await provider().list(repo);
    expect(listed.map((entry) => entry.root)).toEqual([managed.root]);
    expect(listed[0]?.cwd).toBe(managed.cwd);

    // Another repository's managed checkouts are not listed either.
    const other = makeRepo();
    const otherCheckout = await provider().create({ sourceCwd: other, ownerSessionId: '', label: 'other' });
    expect((await provider().list(repo)).map((entry) => entry.root)).toEqual([managed.root]);

    git(repo, 'worktree', 'remove', '--force', outsider);
    await provider().reclaim(managed.root);
    await provider().reclaim(otherCheckout.root);
  }, 90_000);

  it('returns an empty list outside a repository', async () => {
    const plain = tempDir('duya-plain-list-');
    await withCeiling(plain, async () => {
      expect(await provider().list(plain)).toEqual([]);
    });
  });
});

describe('bind and release', () => {
  it('requires a takeover declaration when another session owns the checkout', async () => {
    const repo = makeRepo();
    const checkout = await createCheckoutProvider({
      isSessionAlive: async () => false,
    }).create({ sourceCwd: repo, ownerSessionId: 'session-a', label: 'conflict case' });

    const first = provider();
    await expect(first.bind(checkout.root, 'session-b', 'fresh')).rejects.toMatchObject({
      code: 'owner_conflict',
    });
    await expect(first.bind(checkout.root, 'session-b', 'explicit-release')).rejects.toMatchObject({
      code: 'owner_conflict',
    });
  }, 60_000);

  it('refuses prove-dead while the current owner is alive', async () => {
    const repo = makeRepo();
    const checkout = await provider({ alive: false }).create({
      sourceCwd: repo,
      ownerSessionId: 'session-alive',
      label: 'alive case',
    });

    const live = provider({ alive: true });
    await expect(live.bind(checkout.root, 'session-new', 'prove-dead')).rejects.toBeInstanceOf(
      CheckoutOwnerError,
    );
    await expect(live.bind(checkout.root, 'session-new', 'prove-dead')).rejects.toMatchObject({
      code: 'owner_alive',
    });

    const observed = await live.observe(checkout.root);
    expect(observed.owner).toMatchObject({ sessionId: 'session-alive' });
  }, 60_000);

  it('transfers ownership when the old owner is provably dead', async () => {
    const repo = makeRepo();
    const checkout = await provider({ alive: false }).create({
      sourceCwd: repo,
      ownerSessionId: 'session-dead',
      label: 'dead case',
    });

    await provider({ alive: false }).bind(checkout.root, 'session-heir', 'prove-dead');
    expect((await provider().observe(checkout.root)).owner).toMatchObject({
      sessionId: 'session-heir',
    });
  }, 60_000);

  it('releases only for the current owner', async () => {
    const repo = makeRepo();
    const checkout = await provider().create({
      sourceCwd: repo,
      ownerSessionId: 'session-owner',
      label: 'release case',
    });

    await expect(provider().release(checkout.root, 'session-intruder')).rejects.toMatchObject({
      code: 'not_current_owner',
    });
    await provider().release(checkout.root, 'session-owner');
    expect((await provider().observe(checkout.root)).owner).toBeNull();
    // Releasing twice is not an error: termination paths retry.
    await expect(provider().release(checkout.root, 'session-owner')).resolves.toBeUndefined();
  }, 60_000);

  it('refuses to bind a directory that is not a registered checkout', async () => {
    const repo = makeRepo();
    await expect(provider().bind(repo, 'session', 'fresh')).rejects.toBeInstanceOf(CheckoutError);
    await expect(provider().bind(repo, 'session', 'fresh')).rejects.toMatchObject({
      code: 'not_a_checkout',
    });
  });
});

describe('checkpoint', () => {
  it('numbers refs per session and keeps only the newest 20', async () => {
    const repo = makeRepo();
    const checkout = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'checkpoint case' });
    const api = provider();

    const created: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      created.push(await api.checkpoint(checkout.root, 'session-cp'));
    }
    expect(created[0]).toMatch(/refs\/duya\/checkpoint\/session-cp\/1$/);
    expect(created[24]).toMatch(/refs\/duya\/checkpoint\/session-cp\/25$/);

    const refs = git(checkout.root, 'for-each-ref', '--format=%(refname)', 'refs/duya/checkpoint/session-cp/')
      .split('\n')
      .map((line) => Number(line.trim().split('/').pop()))
      .sort((left, right) => left - right);
    expect(refs).toHaveLength(20);
    expect(refs[0]).toBe(6);
    expect(refs[19]).toBe(25);

    // A different session has its own sequence.
    const other = await api.checkpoint(checkout.root, 'session-other');
    expect(other).toMatch(/refs\/duya\/checkpoint\/session-other\/1$/);

    await api.reclaim(checkout.root);
  }, 120_000);

  it('rejects session ids that cannot appear in a ref', async () => {
    const repo = makeRepo();
    const checkout = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'bad id case' });
    await expect(provider().checkpoint(checkout.root, 'bad/id')).rejects.toBeInstanceOf(CheckoutError);
    await expect(provider().checkpoint(checkout.root, 'bad/id')).rejects.toMatchObject({
      code: 'resolve_failed',
    });
    await provider().reclaim(checkout.root);
  }, 60_000);
});

describe('assertWritable', () => {
  it('reports not_a_checkout for a primary checkout and for a plain directory', async () => {
    const repo = makeRepo();
    expect(await provider().assertWritable(repo, 'session-a')).toEqual({
      ok: false,
      reason: 'not_a_checkout',
    });

    const plain = tempDir('duya-plain-writable-');
    await withCeiling(plain, async () => {
      expect(await provider().assertWritable(plain, 'session-a')).toEqual({
        ok: false,
        reason: 'not_a_checkout',
      });
    });
  }, 60_000);

  it('distinguishes unowned, not_owner and ok from a nested cwd', async () => {
    const repo = makeRepo({ subdirectory: 'packages/host' });
    const checkout = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'writable case' });
    const nested = path.join(checkout.root, 'packages', 'host');
    const api = provider();

    expect(await api.assertWritable(nested, 'session-a')).toEqual({ ok: false, reason: 'unowned' });

    await api.bind(checkout.root, 'session-a', 'fresh');
    expect(await api.assertWritable(nested, 'session-b')).toEqual({ ok: false, reason: 'not_owner' });
    expect(await api.assertWritable(nested, 'session-a')).toEqual({ ok: true, root: checkout.root });

    await api.reclaim(checkout.root);
  }, 60_000);
});

describe('observe', () => {
  it('combines the five dimensions without side effects', async () => {
    const repo = makeRepo();
    const checkout = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'observe case' });

    const observed = await provider({ alive: false }).observe(checkout.root);
    expect(observed).toMatchObject({
      registered: true,
      worktree: 'clean',
      owner: null,
      locked: false,
      reclaim: { ok: true },
    });
    expect(typeof observed.observedAt).toBe('number');

    // Observing is pure: it must not prune or delete anything.
    expect(existsSync(checkout.root)).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(checkout.root.replace(/\\/g, '/'));

    await provider().reclaim(checkout.root);
  }, 60_000);

  it('reports owner_alive, cwd_inside and locked as retention reasons', async () => {
    const repo = makeRepo();
    const checkout = await provider({ alive: false }).create({
      sourceCwd: repo,
      ownerSessionId: 'session-live',
      label: 'retain case',
    });

    expect((await provider({ alive: true }).observe(checkout.root)).reclaim).toEqual({
      ok: false,
      reason: 'owner_alive',
    });
    expect((await provider({ alive: false, cwdInUse: true }).observe(checkout.root)).reclaim).toEqual({
      ok: false,
      reason: 'cwd_inside',
    });

    git(repo, 'worktree', 'lock', checkout.root);
    const locked = await provider({ alive: false }).observe(checkout.root);
    expect(locked.locked).toBe(true);
    expect(locked.reclaim).toEqual({ ok: false, reason: 'locked' });
    git(repo, 'worktree', 'unlock', checkout.root);

    await provider().release(checkout.root, 'session-live');
    await provider().reclaim(checkout.root);
  }, 60_000);

  it('reports a missing checkout as not_registered', async () => {
    const repo = makeRepo();
    const checkout = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'gone case' });
    git(repo, 'worktree', 'remove', '--force', checkout.root);

    const observed = await provider({ alive: false }).observe(checkout.root);
    expect(observed.registered).toBe(false);
    expect(observed.reclaim).toEqual({ ok: false, reason: 'not_registered' });
  }, 60_000);
});

describe('checkout layout', () => {
  it('keeps the historical <repo>-<hash>/<slug>-<6hex> layout', async () => {
    const repo = makeRepo();
    const checkout = await provider().create({ sourceCwd: repo, ownerSessionId: '', label: 'Layout Case' });

    const parent = path.dirname(checkout.root);
    expect(path.basename(parent)).toMatch(new RegExp(`^${path.basename(repo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{12}$`));
    expect(path.basename(checkout.root)).toMatch(/^layout-case-[0-9a-f]{6}$/);
    expect(path.basename(path.dirname(parent))).toBe('worktrees');

    await provider().reclaim(checkout.root);
  }, 60_000);
});
