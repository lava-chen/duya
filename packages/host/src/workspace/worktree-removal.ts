/**
 * Fail-closed removal of a managed checkout.
 *
 * This is the TypeScript port of `scripts/remove-worktree.sh`'s refusal
 * matrix (plan 621 decision D8): the packaged product cannot ship a repo
 * script, but both must refuse the same states. Every precondition is checked
 * BEFORE anything is mutated; the first unmet precondition returns
 * `{removed:false, reason}` and nothing is deleted. There is no `rm -rf`
 * fallback — `git worktree remove` (never `--force`) is the only thing that
 * deletes the tree.
 *
 * The reparse-point step is the one that matters on Windows: recursive delete
 * walks THROUGH NTFS junctions, and this repository has lost the primary
 * checkout twice that way. Links are unlinked first, the tree is re-scanned,
 * and any survivor aborts the run.
 */

import * as path from 'node:path';
import type { CheckoutRetainReason } from './types.js';
import { CheckoutError } from './errors.js';
import { describeGitFailure, git, gitOrNull } from './git.js';
import { canonicalPath, removeEmptyDirectory, scanReparsePoints, unlinkReparsePoint } from './fs-utils.js';
import { inspectRegistration, sourceRootFromCommonDir } from './registration.js';
import { readOwner } from './checkout-metadata.js';

/**
 * Observable facts the remover needs but cannot derive itself. Both are
 * injected so the provider can wire them to the run store and the worker
 * registry; neither may be a timestamp comparison (decision D4).
 */
export interface ReclaimInputs {
  /** True while the session has a live run or is held by a worker. */
  isSessionAlive: (sessionId: string) => Promise<boolean>;
  /** True while any active run's cwd is inside this checkout. */
  cwdInUse: (root: string) => Promise<boolean>;
}

export type ReclaimVerdict = { ok: true } | { ok: false; reason: CheckoutRetainReason };

async function changedPaths(root: string): Promise<ReclaimVerdict> {
  const status = await gitOrNull(root, ['status', '--porcelain']);
  if (status === null) return { ok: false, reason: 'unreadable' };
  // `??` entries are covered by the untracked probe below; counting them here
  // would make every untracked file report `dirty_tracked` and the two reasons
  // indistinguishable.
  const trackedChanges = status
    .split('\n')
    .some((line) => line.trim().length > 0 && !line.startsWith('??'));
  if (trackedChanges) return { ok: false, reason: 'dirty_tracked' };

  const untracked = await gitOrNull(root, ['ls-files', '--others', '--exclude-standard']);
  if (untracked === null) return { ok: false, reason: 'unreadable' };
  if (untracked.trim().length > 0) return { ok: false, reason: 'untracked' };

  const ignored = await gitOrNull(root, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
  ]);
  if (ignored === null) return { ok: false, reason: 'unreadable' };
  if (ignored.trim().length > 0) return { ok: false, reason: 'ignored' };

  return { ok: true };
}

/**
 * A detached HEAD whose commit is not contained in any ref is the only
 * remaining reference to that work. `git worktree remove` would drop it
 * silently, so keep the checkout until the caller creates a backup ref.
 */
async function detachedHeadIsReferenced(root: string): Promise<ReclaimVerdict> {
  const branch = await gitOrNull(root, ['branch', '--show-current']);
  if (branch === null) return { ok: false, reason: 'unreadable' };
  if (branch.trim().length > 0) return { ok: true };

  const refs = await gitOrNull(root, [
    'for-each-ref',
    '--contains=HEAD',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
    'refs/duya',
  ]);
  if (refs === null) return { ok: false, reason: 'unreadable' };
  if (refs.trim().length === 0) return { ok: false, reason: 'detached_unreferenced' };
  return { ok: true };
}

/**
 * Pure evaluation: no side effects, no `worktree prune`, no unlink. Used by
 * `observe` and by `reclaim` before it touches anything.
 *
 * A reparse point in the tree makes the checkout non-reclaimable *as observed*:
 * the removal path may unlink it, but an observer must not claim the checkout
 * is deletable while a junction still points at the user's primary checkout.
 */
export async function evaluateReclaim(root: string, inputs: ReclaimInputs): Promise<ReclaimVerdict> {
  const registration = await inspectRegistration(root);
  if (!registration.registered) return { ok: false, reason: 'not_registered' };
  if (registration.locked) return { ok: false, reason: 'locked' };

  const owner = await readOwner(root);
  if (owner === 'unreadable') return { ok: false, reason: 'unreadable' };
  if (owner !== null && (await inputs.isSessionAlive(owner.sessionId))) {
    return { ok: false, reason: 'owner_alive' };
  }
  if (await inputs.cwdInUse(canonicalPath(root))) return { ok: false, reason: 'cwd_inside' };

  const changed = await changedPaths(root);
  if (!changed.ok) return changed;

  const detached = await detachedHeadIsReferenced(root);
  if (!detached.ok) return detached;

  const scan = scanReparsePoints(canonicalPath(root));
  if (!scan.complete) return { ok: false, reason: 'unreadable' };
  if (scan.links.length > 0) return { ok: false, reason: 'reparse_point' };

  return { ok: true };
}

/**
 * The only deletion entry point. Refusal is a normal result; only git or IO
 * failure to remove a checkout that passed every check throws.
 */
export async function reclaimCheckout(
  root: string,
  inputs: ReclaimInputs,
): Promise<{ removed: true } | { removed: false; reason: CheckoutRetainReason }> {
  const registration = await inspectRegistration(root);
  if (!registration.registered) return { removed: false, reason: 'not_registered' };
  if (registration.locked) return { removed: false, reason: 'locked' };

  const owner = await readOwner(root);
  if (owner === 'unreadable') return { removed: false, reason: 'unreadable' };
  if (owner !== null && (await inputs.isSessionAlive(owner.sessionId))) {
    return { removed: false, reason: 'owner_alive' };
  }

  const checkout = canonicalPath(root);
  if (await inputs.cwdInUse(checkout)) return { removed: false, reason: 'cwd_inside' };

  const changed = await changedPaths(checkout);
  if (!changed.ok) return { removed: false, reason: changed.reason };

  const detached = await detachedHeadIsReferenced(checkout);
  if (!detached.ok) return { removed: false, reason: detached.reason };

  // Every non-destructive gate passed; only now may we unlink anything. A
  // junction is removed as a link (rmdir / unlink), never recursed through.
  const scan = scanReparsePoints(checkout);
  if (!scan.complete) return { removed: false, reason: 'unreadable' };
  for (const link of scan.links) {
    try {
      unlinkReparsePoint(link);
    } catch {
      return { removed: false, reason: 'reparse_point' };
    }
  }
  const leftover = scanReparsePoints(checkout);
  if (!leftover.complete) return { removed: false, reason: 'unreadable' };
  if (leftover.links.length > 0) return { removed: false, reason: 'reparse_point' };

  if (!registration.commonDir) throw new CheckoutError('worktree_remove_failed', 'checkout has no git common dir');
  const sourceRoot = sourceRootFromCommonDir(registration.commonDir);
  const parent = path.dirname(checkout);

  try {
    // No --force: git must refuse a state we failed to notice.
    await git(sourceRoot, ['worktree', 'remove', checkout]);
  } catch (err) {
    throw new CheckoutError(
      'worktree_remove_failed',
      `git worktree remove refused ${checkout}: ${describeGitFailure(err) || 'unknown failure'}`,
    );
  }

  removeEmptyDirectory(checkout);
  removeEmptyDirectory(parent);
  return { removed: true };
}
