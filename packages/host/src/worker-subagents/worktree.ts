/**
 * worktree.ts — `isolation: 'worktree'` implementation for the `task` tool.
 *
 * This module used to be the only worktree implementation. Plan 621 made
 * `workspace/` the owner of creation, observation, ownership and reclamation,
 * so everything below is a shim: the exports and signatures are unchanged
 * because `worker-subagents/service.ts` (and its receipt text) depends on
 * them, but the behaviour now comes from `GitCheckoutProvider`.
 *
 * ## `branch` is a short SHA, not a branch name
 *
 * The checkout is created with `--detach` (plan 621, decision D3), so it has
 * no branch. `IsolatedWorktree.branch` is therefore the first 12 characters of
 * the base commit. It remains a `string` on purpose: changing it to
 * `string | null` would break `service.ts` compilation, and that file belongs
 * to slice D. Callers that want user-facing wording changed ("worktree on
 * branch x") belong to D as well.
 *
 * ## Ownership (plan 621 slice D)
 *
 * `createIsolatedWorktree` takes an optional `ownerSessionId`: the child's
 * session id, minted before creation so the checkout is born owned (the
 * codex order — identity first, then checkout). `releaseIsolatedWorktree`
 * surrenders ownership without deleting, `checkpointIsolatedWorktree` pins
 * the current HEAD under `refs/duya/checkpoint/<session>/<n>` (the only
 * thing keeping a detached HEAD's commits alive), and
 * `registeredCheckoutRoot` answers "is this directory a registered linked
 * worktree" for the resume cwd check.
 *
 * ## Errors
 *
 * The four legacy codes are preserved verbatim so receipts keep the same
 * actionable sentence: `not_a_git_repo`, `no_head`, `dirty_worktree`,
 * `worktree_add_failed`. Every newer failure collapses into `resolve_failed`
 * or `worktree_add_failed` — no new code leaks into existing callers.
 */

import type { CheckoutProvider } from '../workspace/index.js';
import {
  CheckoutError,
  CheckoutOwnerError,
  createCheckoutProvider,
  gitOrNull,
  inspectRegistration,
  slugifyWorktreeName,
} from '../workspace/index.js';
import { canonicalPath } from '../workspace/fs-utils.js';
import { sessionDb } from '../worker-db-client.js';
import { logger } from '../worker-logger.js';

export type WorktreeErrorCode =
  | 'not_a_git_repo'
  | 'no_head'
  | 'dirty_worktree'
  | 'worktree_add_failed'
  | 'resolve_failed';

export class WorktreeError extends Error {
  constructor(
    readonly code: WorktreeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export interface IsolatedWorktree {
  /** Absolute path of the child's working directory (checkout root + source subdirectory). */
  path: string;
  /**
   * Short (12 hex chars) base commit SHA. Detached checkouts have no branch
   * name to report; see the header comment.
   */
  branch: string;
  /** Repository root the worktree was created from. */
  repoRoot: string;
  /**
   * The checkout root itself (the linked worktree). Slice D needs it to
   * release ownership and to write the session's checkout record without
   * re-deriving it from `path` (they differ by the source subdirectory).
   */
  root: string;
  /** Full base commit SHA the detached HEAD starts from. */
  baseSha: string;
}

export { slugifyWorktreeName };

/** One provider instance for the process: it holds no per-call state. */
const provider: CheckoutProvider = createCheckoutProvider();

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function translate(err: unknown, repoCwd: string): WorktreeError {
  if (err instanceof WorktreeError) return err;

  if (err instanceof CheckoutError) {
    switch (err.code) {
      case 'not_a_git_repo':
        return new WorktreeError(
          'not_a_git_repo',
          `isolation: "worktree" requires a git repository, but ${repoCwd} is not inside one. Re-run without isolation, or cd into a repository.`,
        );
      case 'no_head':
        return new WorktreeError(
          'no_head',
          'isolation: "worktree" requires at least one commit, but the repository has no HEAD yet. Commit something first, or re-run without isolation.',
        );
      case 'dirty_worktree':
        return new WorktreeError(
          'dirty_worktree',
          'isolation: "worktree" requires a clean working tree, but the repository has uncommitted changes. Commit or stash them first, or re-run without isolation.',
        );
      case 'worktree_add_failed':
        return new WorktreeError('worktree_add_failed', `isolation: "worktree" could not create an isolated worktree: ${err.message}`);
      default:
        return new WorktreeError('resolve_failed', `isolation: "worktree" failed: ${err.message}`);
    }
  }

  if (err instanceof CheckoutOwnerError) {
    return new WorktreeError('resolve_failed', `isolation: "worktree" failed: ${err.message}`);
  }

  return new WorktreeError('resolve_failed', `isolation: "worktree" failed: ${describe(err)}`);
}

/**
 * Create an isolated checkout for one sub-agent run.
 *
 * @param repoCwd  Directory to isolate from (the parent's working directory).
 * @param rawName  Model-supplied task name; slugified into the checkout name.
 * @param ownerSessionId  Session that receives write access at creation time.
 *   Plan 621 D: the child's id is minted BEFORE this call, so the checkout is
 *   born owned instead of being bound to nobody. Omit (or pass an empty
 *   string) to keep the legacy unowned behaviour.
 */
export async function createIsolatedWorktree(
  repoCwd: string,
  rawName: string,
  ownerSessionId?: string,
): Promise<IsolatedWorktree> {
  try {
    const checkout = await provider.create({
      sourceCwd: repoCwd,
      ownerSessionId: ownerSessionId?.trim() ?? '',
      label: rawName,
    });

    logger.info(
      '[SubAgent] isolated worktree created',
      {
        repoRoot: checkout.sourceRoot,
        worktreePath: checkout.root,
        baseSha: checkout.baseSha,
        ownerSessionId: ownerSessionId?.trim() || '(unowned)',
      },
      'SubAgent',
    );

    return {
      path: checkout.cwd,
      branch: checkout.baseSha.slice(0, 12),
      repoRoot: checkout.sourceRoot,
      root: checkout.root,
      baseSha: checkout.baseSha,
    };
  } catch (err) {
    const failure = translate(err, repoCwd);
    logger.warn(
      '[SubAgent] isolated worktree creation failed',
      { repoCwd, name: rawName, code: failure.code, err },
      'SubAgent',
    );
    throw failure;
  }
}

/**
 * Give up write ownership of an isolated checkout without deleting it
 * (plan 621 §4.5: release is the current owner's explicit surrender, and the
 * checkout stays on disk). Idempotent: releasing an unowned checkout is a
 * no-op. Used when the post-creation cwd readback fails — the checkout is
 * kept for inspection but the session never takes it.
 */
export async function releaseIsolatedWorktree(
  checkoutRoot: string,
  ownerSessionId: string,
): Promise<void> {
  await provider.release(checkoutRoot, ownerSessionId);
}

/**
 * Pin the checkout's current HEAD as `refs/duya/checkpoint/<session>/<n>`
 * (plan 621 §4.5). Called when an isolated run completes: the ref is the
 * only thing keeping a detached HEAD's commits alive once the working tree
 * is eventually reclaimed.
 */
export async function checkpointIsolatedWorktree(
  checkoutRoot: string,
  ownerSessionId: string,
): Promise<string> {
  return provider.checkpoint(checkoutRoot, ownerSessionId);
}

/**
 * The registered linked-worktree root containing `directory`, or `null`.
 *
 * A registered checkout is a real git linked worktree (four-way identity
 * check in `inspectRegistration`, surfaced through `provider.observe`).
 * Slice D uses this to decide whether a resumed sub-agent's original
 * working directory was checkout-owned (refuse the cwd change) or an
 * ordinary directory the user moved (keep the legacy warning). `head` is the
 * registered HEAD, the closest reconstructable base for a resumed session's
 * checkout record.
 */
export async function registeredCheckoutRoot(
  directory: string,
): Promise<{ root: string; head: string | null } | null> {
  const toplevel = await gitOrNull(directory, ['rev-parse', '--show-toplevel']);
  const trimmed = toplevel?.trim();
  if (!trimmed) return null;

  const root = canonicalPath(trimmed);
  try {
    const observed = await provider.observe(root);
    if (!observed.registered) return null;
    // `observe` is the registration judge; this second read only recovers the
    // registered HEAD, which observation deliberately does not surface.
    const registration = await inspectRegistration(root);
    return { root, head: registration.head };
  } catch (err) {
    // Observation failure is not evidence of registration; the caller falls
    // back to the non-checkout path instead of blocking a valid resume.
    logger.warn('[SubAgent] checkout observation failed during resume', { directory, err }, 'SubAgent');
    return null;
  }
}

/**
 * Re-establish write ownership for a resumed run. The previous run released
 * the checkout at its terminal, so the owner file is normally gone and
 * `explicit-release` is the honest takeover reason. Re-binding fails with a
 * typed `CheckoutOwnerError` when another session took the checkout meanwhile
 * — the caller surfaces that as a refused resume, never a silent switch.
 */
export async function bindIsolatedWorktree(
  checkoutRoot: string,
  ownerSessionId: string,
): Promise<void> {
  await provider.bind(checkoutRoot, ownerSessionId, 'explicit-release');
}

/** One session's checkout attachment, as stored under `sessions.extensions.checkout`. */
export interface CheckoutRunRecord {
  /** Linked worktree root (the identity the owner file lives in). */
  root: string;
  /** Working directory the session actually ran in (`root` + source subdir). */
  cwd: string;
  /** Base commit the detached HEAD started from (empty when unknown). */
  baseSha: string;
  /** When the session entered the checkout (epoch ms). */
  enteredAt: number;
  /** When the session left (epoch ms); set by the terminal paths. */
  leftAt?: number;
  /** Why the session left. Budget exhaustion reaches these paths as `failed`. */
  lastOutcome?: CheckoutRunOutcome;
}

export type CheckoutRunOutcome = 'completed' | 'failed' | 'cancelled' | 'cwd_mismatch';

/**
 * Terminal close-out for one checkout-owned run (plan 621 §4.5).
 *
 * - `completed`: pin a checkpoint ref first — it is the only thing keeping a
 *   detached HEAD's commits alive once the checkout is reclaimed.
 * - every outcome: release ownership (idempotent; the checkout stays on disk
 *   and becomes reclaimable via prove-dead once no run holds it).
 * - every outcome: leave `leftAt` + `lastOutcome` on the session's checkout
 *   record. The record is the temporary carrier for ownership history,
 *   standing in for the plan-620 rollout events — see the slice D report.
 *
 * Best-effort by design: identity lives in the owner file and the session's
 * `working_directory`, so a failed record write must not fail the run. A
 * failed release is logged loudly because it leaves the checkout owned by a
 * session that will never surrender it again.
 */
export async function finalizeCheckoutRun(input: {
  sessionId: string;
  record: CheckoutRunRecord;
  outcome: CheckoutRunOutcome;
}): Promise<void> {
  const { sessionId, record, outcome } = input;

  if (outcome === 'completed') {
    try {
      const ref = await checkpointIsolatedWorktree(record.root, sessionId);
      logger.info(
        '[SubAgent] checkout checkpoint ref created',
        { sessionId, checkoutRoot: record.root, ref },
        'SubAgent',
      );
    } catch (err) {
      logger.warn(
        '[SubAgent] checkout checkpoint failed',
        { sessionId, checkoutRoot: record.root, err },
        'SubAgent',
      );
    }
  }

  try {
    await releaseIsolatedWorktree(record.root, sessionId);
  } catch (err) {
    logger.warn(
      '[SubAgent] checkout release failed',
      { sessionId, checkoutRoot: record.root, err },
      'SubAgent',
    );
  }

  try {
    await sessionDb.setExtension(sessionId, 'checkout', {
      root: record.root,
      cwd: record.cwd,
      baseSha: record.baseSha,
      enteredAt: record.enteredAt,
      leftAt: Date.now(),
      lastOutcome: outcome,
    });
  } catch (err) {
    logger.warn(
      '[SubAgent] failed to record checkout terminal outcome on session',
      { sessionId, checkoutRoot: record.root, outcome, err },
      'SubAgent',
    );
  }
}
