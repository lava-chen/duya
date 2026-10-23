/**
 * Owner file semantics — the one acceptance criterion this slice exists for:
 * two concurrent binds to the same checkout must not both succeed.
 *
 * The test is in-process, but the exclusion it proves is the filesystem's
 * (`linkSync` → EEXIST), not a JavaScript flag. That is the property codex's
 * `persist_noclobber` provides and the one a `existsSync` + `writeFile` pair
 * cannot provide.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { git, makeRepo, tempDir, withCeiling } from './fixtures.js';
import { bindOwner, clearOwner, ownerPath, readOwner } from '../../src/workspace/checkout-metadata.js';
import { CheckoutOwnerError } from '../../src/workspace/errors.js';
import { samePath } from '../../src/workspace/fs-utils.js';

describe('checkout owner file', () => {
  let repo = '';
  let checkout = '';

  beforeAll(() => {
    repo = makeRepo();
    // A raw detached worktree keeps this suite independent of the provider:
    // the owner file is a property of any linked checkout, whoever created it.
    checkout = path.join(tempDir('duya-owner-wt-'), 'checkout');
    git(repo, 'worktree', 'add', '--detach', checkout, 'HEAD');
  }, 60_000);

  afterAll(() => {
    git(repo, 'worktree', 'remove', '--force', checkout);
  });

  it('lives in the checkout git dir and uses the codex-compatible shape', async () => {
    const target = await ownerPath(checkout);
    expect(samePath(path.dirname(target), git(checkout, 'rev-parse', '--absolute-git-dir'))).toBe(true);

    await bindOwner(checkout, 'session-a');
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({
      version: 1,
      ownerThreadId: 'session-a',
    });
    expect(await readOwner(checkout)).toMatchObject({ sessionId: 'session-a' });
  });

  it('lets exactly one of two concurrent binds win', async () => {
    await clearOwner(checkout);

    const results = await Promise.allSettled([
      bindOwner(checkout, 'session-left'),
      bindOwner(checkout, 'session-right'),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const loser = rejected[0];
    expect(loser?.status).toBe('rejected');
    if (loser?.status === 'rejected') {
      expect(loser.reason).toBeInstanceOf(CheckoutOwnerError);
      expect((loser.reason as CheckoutOwnerError).code).toBe('owner_conflict');
    }

    const owner = await readOwner(checkout);
    expect(owner).not.toBe('unreadable');
    expect(owner).not.toBeNull();
    const winner = owner === null || owner === 'unreadable' ? '' : owner.sessionId;
    expect(['session-left', 'session-right']).toContain(winner);

    // The file content must agree with the owner the winner reports.
    expect(JSON.parse(readFileSync(await ownerPath(checkout), 'utf8'))).toEqual({
      version: 1,
      ownerThreadId: winner,
    });
  }, 30_000);

  it('treats rebinding the same session as success', async () => {
    await clearOwner(checkout);
    await bindOwner(checkout, 'session-idempotent');
    await expect(bindOwner(checkout, 'session-idempotent')).resolves.toBeUndefined();
    expect(await readOwner(checkout)).toMatchObject({ sessionId: 'session-idempotent' });
  });

  it.each([
    ['a future version', { version: 2, ownerThreadId: 'x' }],
    ['an empty id', { version: 1, ownerThreadId: '  ' }],
    ['an extra field', { version: 1, ownerThreadId: 'x', extra: true }],
    ['a missing id', { version: 1 }],
  ])('reports %s as unreadable rather than unowned', async (_label, record) => {
    const target = await ownerPath(checkout);
    writeFileSync(target, JSON.stringify(record));
    expect(await readOwner(checkout)).toBe('unreadable');
    // Refusing to bind is what prevents an unreadable owner from becoming two writers.
    await expect(bindOwner(checkout, 'someone')).rejects.toMatchObject({ code: 'owner_unreadable' });
  });

  it('clears the owner idempotently and reports no owner afterwards', async () => {
    // Previous case left a deliberately malformed record behind.
    await clearOwner(checkout);
    await bindOwner(checkout, 'session-release');
    await clearOwner(checkout);
    expect(await readOwner(checkout)).toBeNull();
    await expect(clearOwner(checkout)).resolves.toBeUndefined();
  });
});

describe('owner file on a plain directory', () => {
  it('cannot be read or written when there is no git dir', async () => {
    const plain = tempDir('duya-plain-owner-');
    await withCeiling(plain, async () => {
      expect(await readOwner(plain)).toBe('unreadable');
      await expect(bindOwner(plain, 'session')).rejects.toBeInstanceOf(CheckoutOwnerError);
    });
  });
});
