/**
 * Plan 621, scenario 3 — the four terminal paths of a checkout-owned run.
 *
 * A sub-agent that ran isolated owns a checkout. When that run ends — however
 * it ends — the checkout must not stay owned by a session that will never
 * surrender it. The four paths are:
 *
 *   completed  → checkpoint the HEAD, release, record `completed`
 *   failed     → release, record `failed`   (no checkpoint: a failed run's
 *                                              commits are not worth preserving)
 *   cancelled  → release, record `cancelled`
 *   cwd_mismatch → release, record `cwd_mismatch`, and the checkout is KEPT
 *                                              on disk for inspection
 *
 * ## Why the git side is real
 *
 * The checkpoint ref is the only thing keeping a detached HEAD's commits
 * alive after the directory goes, and the owner file is the authority on who
 * may write. Both are git facts, so both are read back from git here. A stub
 * would assert the code's own beliefs instead of the behaviour.
 *
 * The session record is a separate matter: it is the temporary carrier for
 * ownership history (plan 620 owns the rollout taxonomy), so the DB bridge is
 * stubbed to observe what was written. The stub is at the PROCESS boundary
 * (the worker talks to the Host over a DB request), not at the logic under
 * test.
 */

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { git, makeRepo, tempDir, useIsolatedDataRoot } from './fixtures.js';

const setExtension = vi.fn(async () => undefined);

vi.mock('../../src/worker-db-client.js', () => ({
  sessionDb: {
    setExtension: (id: string, key: string, value: unknown) => setExtension(id, key, value),
  },
}));

const { finalizeCheckoutRun } = await import('../../src/worker-subagents/worktree.js');
const { createCheckoutProvider } = await import('../../src/workspace/index.js');

let restoreDataRoot: () => void = () => undefined;
const provider = createCheckoutProvider();

beforeAll(() => {
  restoreDataRoot = useIsolatedDataRoot();
});

afterAll(() => {
  restoreDataRoot();
});

afterEach(() => {
  setExtension.mockClear();
});

interface TerminalCase {
  readonly outcome: 'completed' | 'failed' | 'cancelled' | 'cwd_mismatch';
  /** Whether the run's commits must survive the checkout's removal. */
  readonly expectCheckpoint: boolean;
}

const TERMINAL_CASES: readonly TerminalCase[] = [
  { outcome: 'completed', expectCheckpoint: true },
  { outcome: 'failed', expectCheckpoint: false },
  { outcome: 'cancelled', expectCheckpoint: false },
  { outcome: 'cwd_mismatch', expectCheckpoint: false },
];

describe('plan 621 scenario 3: the four terminal paths close the checkout out', () => {
  for (const testCase of TERMINAL_CASES) {
    it(`${testCase.outcome} releases the checkout and records the outcome`, async () => {
      const repo = makeRepo();
      const created = await provider.create({
        sourceCwd: repo,
        ownerSessionId: 'session-1',
        label: `terminal ${testCase.outcome}`,
      });

      // The session owns it — a second session must not be able to take it.
      await expect(provider.bind(created.root, 'session-2', 'fresh')).rejects.toThrow();

      await finalizeCheckoutRun({
        sessionId: 'session-1',
        record: {
          root: created.root,
          cwd: created.cwd,
          baseSha: created.baseSha,
          enteredAt: Date.now(),
        },
        outcome: testCase.outcome,
      });

      // 1. The ownership is released, so the checkout is no longer held by a
      //    session that will never surrender it.
      const after = await provider.observe(created.root);
      expect(after.owner).toBeNull();

      // 2. The outcome is recorded on the session's checkout record, with
      //    the time it left.
      expect(setExtension).toHaveBeenCalledTimes(1);
      const [sessionId, key, value] = setExtension.mock.calls[0] as [string, string, Record<string, unknown>];
      expect(sessionId).toBe('session-1');
      expect(key).toBe('checkout');
      expect(value.root).toBe(created.root);
      expect(value.lastOutcome).toBe(testCase.outcome);
      expect(typeof value.leftAt).toBe('number');

      // 3. Only a completed run's commits are preserved. A failed or
      //    cancelled run's commits are the user's to keep or drop, and
      //    preserving them would fill the ref namespace with garbage.
      const refs = git(repo, 'for-each-ref', '--format=%(refname)', 'refs/duya/checkpoint/');
      const expected = testCase.expectCheckpoint ? 1 : 0;
      expect(refs.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(expected);
    });
  }

  it('keeps the checkout on disk after a cwd mismatch, so the work is not lost', async () => {
    const repo = makeRepo();
    const created = await provider.create({
      sourceCwd: repo,
      ownerSessionId: 'session-1',
      label: 'cwd mismatch',
    });
    // A commit in the checkout: the user may want to recover it by hand.
    execFileSync('git', ['commit', '--allow-empty', '-m', 'work in progress'], {
      cwd: created.cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: 'duya test', GIT_AUTHOR_EMAIL: 'test@duya.local' },
    });

    await finalizeCheckoutRun({
      sessionId: 'session-1',
      record: {
        root: created.root,
        cwd: created.cwd,
        baseSha: created.baseSha,
        enteredAt: Date.now(),
      },
      outcome: 'cwd_mismatch',
    });

    // The directory is still there — a mismatch refuses the RUN, it does not
    // delete the user's work.
    const observed = await provider.observe(created.root);
    expect(observed.registered).toBe(true);
    expect(observed.owner).toBeNull();
    expect(observed.reclaim.reason).not.toBeNull();
  });

  it('releases the ownership even when the checkpoint ref cannot be written', async () => {
    const repo = makeRepo();
    const created = await provider.create({
      sourceCwd: repo,
      ownerSessionId: 'session-1',
      label: 'checkpoint failure',
    });

    // Break the checkout's HEAD without touching its owner file: the
    // checkpoint command needs a HEAD to pin, and the owner file lives in the
    // git dir beside it. A checkout whose HEAD names a commit that does not
    // exist is the state where the checkpoint fails but the owner file stays
    // readable — a lost ref, not a lost authority.
    const { ownerPath } = await import('../../src/workspace/index.js');
    const owner = await ownerPath(created.root);
    const { existsSync, writeFileSync, readFileSync } = await import('node:fs');
    expect(existsSync(owner)).toBe(true);
    // The git dir of a linked worktree holds HEAD; the owner file sits beside
    // it. Corrupting HEAD leaves the owner file untouched.
    const headFile = path.join(path.dirname(owner), 'HEAD');
    const originalHead = readFileSync(headFile, 'utf8');
    writeFileSync(headFile, 'ref: refs/heads/duya-missing-branch\n', 'utf8');
    expect(readFileSync(headFile, 'utf8')).not.toBe(originalHead);

    await finalizeCheckoutRun({
      sessionId: 'session-1',
      record: {
        root: created.root,
        cwd: created.cwd,
        baseSha: created.baseSha,
        enteredAt: Date.now(),
      },
      outcome: 'completed',
    });

    // The owner file is gone: the release DID run, and the checkout is no
    // longer held by a session that will never surrender it. A failed
    // checkpoint is a lost ref; a held owner is a stuck checkout.
    expect(existsSync(owner)).toBe(false);

    // The record was still written — the outcome is not lost either.
    expect(setExtension).toHaveBeenCalledTimes(1);
    const [, , value] = setExtension.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(value.lastOutcome).toBe('completed');
  });
});
