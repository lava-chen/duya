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
 * ## Errors
 *
 * The four legacy codes are preserved verbatim so receipts keep the same
 * actionable sentence: `not_a_git_repo`, `no_head`, `dirty_worktree`,
 * `worktree_add_failed`. Every newer failure collapses into `resolve_failed`
 * or `worktree_add_failed` — no new code leaks into existing callers.
 */

import type { CheckoutProvider } from '../workspace/index.js';
import { CheckoutError, CheckoutOwnerError, createCheckoutProvider, slugifyWorktreeName } from '../workspace/index.js';
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
 */
export async function createIsolatedWorktree(
  repoCwd: string,
  rawName: string,
): Promise<IsolatedWorktree> {
  try {
    const checkout = await provider.create({
      sourceCwd: repoCwd,
      // Legacy isolation has no session identity; the checkout stays unowned
      // until slice D binds a real session to it.
      ownerSessionId: '',
      label: rawName,
    });

    logger.info(
      '[SubAgent] isolated worktree created',
      {
        repoRoot: checkout.sourceRoot,
        worktreePath: checkout.root,
        baseSha: checkout.baseSha,
      },
      'SubAgent',
    );

    return {
      path: checkout.cwd,
      branch: checkout.baseSha.slice(0, 12),
      repoRoot: checkout.sourceRoot,
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
