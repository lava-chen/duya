/**
 * `CheckoutProvider` implementation (plan 621, appendix A).
 *
 * Creation follows codex (`worktree/src/lib.rs`): `add --detach --no-checkout`,
 * pin `core.worktree` on the new checkout only, then `reset --hard` so the
 * working tree materialises exactly at the base commit. Detached is
 * deliberate (decision D3): a checkout is not a branch, and
 * `refs/duya/checkpoint/*` is what keeps its commits alive.
 *
 * Failure is all-or-nothing: any step after `worktree add` rolls the checkout
 * back, so a caller never gets a registered-but-empty directory.
 */

import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type {
  CheckoutObserved,
  CheckoutProvider,
  CheckoutRetainReason,
  CheckoutRoot,
} from './types.js';
import { CheckoutError, CheckoutOwnerError } from './errors.js';
import { describeGitFailure, git, gitOrNull, gitPathAbsolute } from './git.js';
import { canonicalPath, isDirectory, removeEmptyDirectory, samePath } from './fs-utils.js';
import { allocateCheckoutName, managedRootFor, slugifyWorktreeName } from './paths.js';
import { bindOwner, clearOwner, readOwner } from './checkout-metadata.js';
import { inspectRegistration, worktreeEntries } from './registration.js';
import { evaluateReclaim, reclaimCheckout, type ReclaimInputs } from './worktree-removal.js';

/** How many checkpoint refs one session keeps. Older ones are deleted. */
const CHECKPOINT_KEEP = 20;

const CHECKPOINT_PREFIX = 'refs/duya/checkpoint';

/** A git ref component may not contain these; session ids are UUIDs today. */
const SAFE_REF_COMPONENT = /^[A-Za-z0-9._-]+$/;

export interface CheckoutProviderPorts extends Partial<ReclaimInputs> {
  /** Overridable clock, for tests that must not depend on wall time. */
  now?: () => number;
}

/**
 * Injection defaults are fail-closed:
 *   - an owner is assumed ALIVE unless proven otherwise, so `prove-dead`
 *     cannot take a checkout from a session nobody checked;
 *   - `cwdInUse` is assumed false because only the caller can see the run
 *     table; callers that have it must inject it.
 */
const DEFAULT_PORTS: Required<CheckoutProviderPorts> = {
  isSessionAlive: async () => true,
  cwdInUse: async () => false,
  now: () => Date.now(),
};

export class GitCheckoutProvider implements CheckoutProvider {
  private readonly ports: Required<CheckoutProviderPorts>;

  constructor(ports: CheckoutProviderPorts = {}) {
    this.ports = {
      isSessionAlive: ports.isSessionAlive ?? DEFAULT_PORTS.isSessionAlive,
      cwdInUse: ports.cwdInUse ?? DEFAULT_PORTS.cwdInUse,
      now: ports.now ?? DEFAULT_PORTS.now,
    };
  }

  private reclaimInputs(): ReclaimInputs {
    return { isSessionAlive: this.ports.isSessionAlive, cwdInUse: this.ports.cwdInUse };
  }

  async create(input: {
    sourceCwd: string;
    base?: string;
    ownerSessionId: string;
    label: string;
  }): Promise<CheckoutRoot> {
    const sourceCwd = canonicalPath(input.sourceCwd);
    const toplevel = await gitOrNull(sourceCwd, ['rev-parse', '--show-toplevel']);
    const trimmedRoot = toplevel?.trim();
    if (!trimmedRoot) {
      throw new CheckoutError(
        'not_a_git_repo',
        `checkout creation requires a git repository, but ${input.sourceCwd} is not inside one`,
      );
    }
    const sourceRoot = canonicalPath(trimmedRoot);

    const base = input.base?.trim() || 'HEAD';
    const baseShaRaw = await gitOrNull(sourceRoot, ['rev-parse', '--verify', `${base}^{commit}`]);
    const baseSha = baseShaRaw?.trim();
    if (!baseSha) {
      throw new CheckoutError(
        base === 'HEAD' ? 'no_head' : 'invalid_base',
        base === 'HEAD'
          ? `checkout creation requires at least one commit, but ${sourceRoot} has no HEAD yet`
          : `checkout base ${base} does not resolve to a commit`,
      );
    }

    const status = await gitOrNull(sourceRoot, ['status', '--porcelain']);
    if (status === null) {
      throw new CheckoutError('resolve_failed', `cannot read the git status of ${sourceRoot}`);
    }
    if (status.trim().length > 0) {
      throw new CheckoutError(
        'dirty_worktree',
        `checkout creation requires a clean source worktree, but ${sourceRoot} has uncommitted changes`,
      );
    }

    const relativeCwd = path.relative(sourceRoot, sourceCwd);
    if (relativeCwd.startsWith('..') || path.isAbsolute(relativeCwd)) {
      throw new CheckoutError('resolve_failed', `${sourceCwd} is outside ${sourceRoot}`);
    }

    const slug = slugifyWorktreeName(input.label);
    const root = path.join(managedRootFor(sourceRoot), allocateCheckoutName(slug, sourceRoot));
    mkdirSync(path.dirname(root), { recursive: true });

    try {
      await git(sourceRoot, ['worktree', 'add', '--detach', '--no-checkout', root, baseSha]);
    } catch (err) {
      await this.rollback(sourceRoot, root);
      throw new CheckoutError(
        'worktree_add_failed',
        `cannot create checkout: ${describeGitFailure(err) || 'git worktree add failed'}`,
      );
    }

    try {
      await this.populate(root, baseSha);
      const cwd = path.join(root, relativeCwd);
      if (!this.isSafeCwd(root, cwd)) {
        throw new CheckoutError(
          'resolve_failed',
          `base ${baseSha} does not contain a working directory for ${relativeCwd}`,
        );
      }
      const owner = input.ownerSessionId.trim();
      if (owner) await bindOwner(root, owner);
      return { root, cwd, sourceRoot, sourceCwd, baseSha };
    } catch (err) {
      await this.rollback(sourceRoot, root);
      if (err instanceof CheckoutError || err instanceof CheckoutOwnerError) throw err;
      throw new CheckoutError(
        'worktree_add_failed',
        `cannot populate checkout: ${describeGitFailure(err) || 'unknown failure'}`,
      );
    }
  }

  /** Pin the checkout's own config, then materialise the tree at `baseSha`. */
  private async populate(root: string, baseSha: string): Promise<void> {
    const configPath = await gitPathAbsolute(root, ['--git-path', 'config.worktree']);
    if (!configPath) {
      throw new CheckoutError('worktree_add_failed', `cannot resolve config.worktree for ${root}`);
    }
    // Writing with `--file` touches only this checkout's config; enabling
    // `extensions.worktreeConfig` would mutate the shared repository config.
    await git(root, ['config', '--file', configPath, 'core.worktree', root]);
    await git(root, ['--work-tree=.', 'reset', '--hard', '--no-recurse-submodules', baseSha]);
  }

  /** A cwd is only usable when it exists and its real path is inside the checkout. */
  private isSafeCwd(root: string, cwd: string): boolean {
    if (!isDirectory(cwd)) return false;
    const realRoot = canonicalPath(root);
    const realCwd = canonicalPath(cwd);
    return samePath(realCwd, realRoot) || realCwd.startsWith(realRoot + path.sep);
  }

  /**
   * Remove every trace of a checkout we created but could not finish.
   *
   * `worktree remove --force` is the only delete: a recursive delete here
   * could follow a junction out of the checkout. If it fails, the directory
   * stays and the error is reported rather than escalated.
   */
  private async rollback(sourceRoot: string, root: string): Promise<void> {
    await gitOrNull(sourceRoot, ['worktree', 'remove', '--force', root]);
    await gitOrNull(sourceRoot, ['worktree', 'prune']);
    removeEmptyDirectory(root);
    removeEmptyDirectory(path.dirname(root));
  }

  async observe(root: string): Promise<CheckoutObserved> {
    const registration = await inspectRegistration(root);
    const owner = await readOwner(root);
    const worktree = registration.registered ? await this.worktreeState(root) : 'clean';
    const reclaim = await evaluateReclaim(root, this.reclaimInputs());

    return {
      registered: registration.registered,
      worktree,
      owner,
      locked: registration.locked,
      reclaim,
      observedAt: this.ports.now(),
    };
  }

  /**
   * Worst-first worktree hygiene. `CheckoutObserved.worktree` is a single
   * value covering three independent probes, so the most dangerous state wins.
   * A failed probe counts as `dirty_tracked`: an unreadable tree must never
   * look clean enough to delete.
   */
  private async worktreeState(root: string): Promise<CheckoutObserved['worktree']> {
    const status = await gitOrNull(root, ['status', '--porcelain']);
    if (status === null) return 'dirty_tracked';
    if (status.split('\n').some((line) => line.trim().length > 0 && !line.startsWith('??'))) {
      return 'dirty_tracked';
    }

    const untracked = await gitOrNull(root, ['ls-files', '--others', '--exclude-standard']);
    if (untracked?.trim()) return 'untracked';

    const ignored = await gitOrNull(root, ['ls-files', '--others', '--ignored', '--exclude-standard']);
    if (ignored?.trim()) return 'ignored';

    return 'clean';
  }

  /**
   * Reverse-derived from `git worktree list`, never from a registry.
   *
   * Only checkouts whose parent directory is this repository's managed root —
   * and that pass the full identity check — are returned, so an unrelated
   * worktree a user created by hand is never presented as ours.
   */
  async list(sourceCwd: string): Promise<CheckoutRoot[]> {
    const cwd = canonicalPath(sourceCwd);
    const toplevel = await gitOrNull(cwd, ['rev-parse', '--show-toplevel']);
    const trimmedRoot = toplevel?.trim();
    if (!trimmedRoot) return [];
    const sourceRoot = canonicalPath(trimmedRoot);

    const relativeCwd = path.relative(sourceRoot, cwd);
    const sourceCommonDir = await gitPathAbsolute(sourceRoot, ['--git-common-dir']);
    if (!sourceCommonDir) return [];

    const managedRoot = canonicalPath(managedRootFor(sourceRoot));
    const entries = await worktreeEntries(cwd);
    if (!entries) return [];

    const checkouts: CheckoutRoot[] = [];
    for (const entry of entries) {
      const root = canonicalPath(entry.path);
      if (!samePath(path.dirname(root), managedRoot)) continue;

      const registration = await inspectRegistration(root);
      if (!registration.registered || !registration.commonDir) continue;
      if (!samePath(registration.commonDir, sourceCommonDir)) continue;

      const entryCwd = path.join(root, relativeCwd);
      if (!this.isSafeCwd(root, entryCwd)) continue;

      checkouts.push({
        root,
        cwd: entryCwd,
        sourceRoot,
        sourceCwd: cwd,
        // Detached checkouts do not record their creation base anywhere in
        // git; the registered HEAD is the closest reconstructable value.
        // Callers that need the exact base must have kept `create`'s result.
        baseSha: registration.head ?? '',
      });
    }

    checkouts.sort((left, right) => (left.root < right.root ? -1 : left.root > right.root ? 1 : 0));
    return checkouts;
  }

  async bind(
    root: string,
    sessionId: string,
    takeover: 'fresh' | 'explicit-release' | 'prove-dead',
  ): Promise<void> {
    const registration = await inspectRegistration(root);
    if (!registration.registered) {
      throw new CheckoutError('not_a_checkout', `${root} is not a registered linked worktree`);
    }

    const session = sessionId.trim();
    if (!session) throw new CheckoutOwnerError('invalid_session', 'session id cannot be empty');

    const existing = await readOwner(root);
    if (existing === 'unreadable') {
      throw new CheckoutOwnerError(
        'owner_unreadable',
        `checkout at ${root} has an unreadable owner file`,
      );
    }
    if (existing !== null && existing.sessionId === session) return;

    if (takeover !== 'prove-dead') {
      if (existing !== null) {
        throw new CheckoutOwnerError(
          'owner_conflict',
          `checkout at ${root} is owned by ${existing.sessionId}; declare a takeover to replace it`,
        );
      }
      await bindOwner(root, session);
      return;
    }

    if (existing !== null) {
      // prove-dead reads observable facts only: an active run or a worker
      // holding the session. Never a heartbeat timestamp (decision D4).
      if (await this.ports.isSessionAlive(existing.sessionId)) {
        throw new CheckoutOwnerError(
          'owner_alive',
          `checkout at ${root} is owned by ${existing.sessionId}, which is still alive`,
        );
      }
      await bindOwner(root, session, { replace: true });
      return;
    }

    await bindOwner(root, session);
  }

  async release(root: string, sessionId: string): Promise<void> {
    const session = sessionId.trim();
    const existing = await readOwner(root);
    if (existing === 'unreadable') {
      throw new CheckoutOwnerError(
        'owner_unreadable',
        `checkout at ${root} has an unreadable owner file`,
      );
    }
    if (existing === null) return;
    if (existing.sessionId !== session) {
      throw new CheckoutOwnerError(
        'not_current_owner',
        `${session} cannot release ${root}: owned by ${existing.sessionId}`,
      );
    }
    await clearOwner(root);
  }

  /**
   * `refs/duya/checkpoint/<session>/<n>` is the only thing keeping a detached
   * HEAD's commits alive. Numbering is per session and monotonic; the newest
   * `CHECKPOINT_KEEP` refs survive, older ones are deleted so
   * `for-each-ref` does not become the next performance problem.
   */
  async checkpoint(root: string, sessionId: string): Promise<string> {
    const session = sessionId.trim();
    if (!SAFE_REF_COMPONENT.test(session)) {
      throw new CheckoutError(
        'resolve_failed',
        `session id ${JSON.stringify(session)} cannot be used in a checkpoint ref`,
      );
    }

    const headRaw = await gitOrNull(root, ['rev-parse', '--verify', 'HEAD']);
    const head = headRaw?.trim();
    if (!head) throw new CheckoutError('no_head', `checkout at ${root} has no HEAD`);

    const prefix = `${CHECKPOINT_PREFIX}/${session}/`;
    const existing = await gitOrNull(root, ['for-each-ref', '--format=%(refname)', prefix]);
    const sequence = (existing ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith(prefix))
      .map((line) => Number(line.slice(prefix.length)))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((left, right) => left - right);

    const next = (sequence.length > 0 ? sequence[sequence.length - 1] ?? 0 : 0) + 1;
    const ref = `${prefix}${next}`;
    await git(root, ['update-ref', ref, head]);

    const retained = [...sequence, next];
    while (retained.length > CHECKPOINT_KEEP) {
      const drop = retained.shift();
      if (drop === undefined) break;
      await git(root, ['update-ref', '-d', `${prefix}${drop}`]);
    }

    return ref;
  }

  /**
   * Write gate: resolve the checkout from the caller's cwd, then compare the
   * owner. Deliberately does not scan every worktree — a query must cost a
   * handful of git calls in one directory.
   */
  async assertWritable(
    cwd: string,
    sessionId: string,
  ): Promise<{ ok: true; root: string } | { ok: false; reason: 'not_a_checkout' | 'unowned' | 'not_owner' }> {
    const toplevel = await gitOrNull(cwd, ['rev-parse', '--show-toplevel']);
    const trimmedRoot = toplevel?.trim();
    if (!trimmedRoot) return { ok: false, reason: 'not_a_checkout' };

    const root = canonicalPath(trimmedRoot);
    // A primary checkout has `.git` as a directory; only linked worktrees
    // (`.git` file) are governed by this contract.
    const registration = await inspectRegistration(root);
    if (!registration.registered) return { ok: false, reason: 'not_a_checkout' };

    const owner = await readOwner(root);
    if (owner === null) return { ok: false, reason: 'unowned' };
    if (owner === 'unreadable') return { ok: false, reason: 'not_owner' };
    if (owner.sessionId !== sessionId.trim()) return { ok: false, reason: 'not_owner' };
    return { ok: true, root };
  }

  async reclaim(root: string): Promise<{ removed: true } | { removed: false; reason: CheckoutRetainReason }> {
    return reclaimCheckout(root, this.reclaimInputs());
  }
}

/** Convenience factory so callers do not depend on the class name. */
export function createCheckoutProvider(ports: CheckoutProviderPorts = {}): CheckoutProvider {
  return new GitCheckoutProvider(ports);
}
