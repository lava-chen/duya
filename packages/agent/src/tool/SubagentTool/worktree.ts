/**
 * worktree.ts — `isolation: 'worktree'` implementation for the `task` tool.
 *
 * A sub-agent that edits files must not scribble on the user's working copy
 * while they are typing in it, so this module materializes a real
 * `git worktree` and hands its path to `runAgent` as the child's working
 * directory. The worktree lives under the duya-owned root (`~/.duya/worktrees`,
 * see `utils/duyaRoot.ts`) rather than inside the repository, so:
 *   - the user's own `.gitignore` / editor file-watching never sees it,
 *   - `git status` in the user's checkout is unaffected,
 *   - `git worktree list` remains the single place that reveals it.
 *
 * Every failure mode (not a repo, no HEAD, dirty tree, `git worktree add`
 * refused) is surfaced as a `WorktreeError` with a machine-readable `code` so
 * `SubagentTool` can put a specific sentence in the receipt instead of a
 * stack trace. `execFile` with an args array is used throughout — a shell
 * string would be a quoting bug on every Windows path containing a space.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { getDuyaRoot } from '../../utils/duyaRoot.js';
import { logger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

/** git invocations are local and cheap; 30s covers a large worktree checkout. */
const GIT_TIMEOUT_MS = 30_000;

/** Cap the stderr text echoed back to the model so a hook's noise cannot flood the receipt. */
const MAX_GIT_ERROR_CHARS = 400;

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
  /** Absolute path of the new worktree — the child's working directory. */
  path: string;
  /** Generated branch name (`duya/subagent/<slug>-<shortHash>`). */
  branch: string;
  /** Repository root the worktree was created from. */
  repoRoot: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    // `-c core.quotepath=false` keeps non-ASCII repo paths readable; the
    // explicit encoding avoids mojibake in the path we then use as cwd.
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/** First line of a git failure, trimmed to a receipt-safe length. */
function describeGitFailure(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr ?? '';
  const line = stderr.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.trim().slice(0, MAX_GIT_ERROR_CHARS);
}

/**
 * Slugify a task name into a branch-safe fragment. Duya-owned names are
 * already short, but the model can pass anything in `name`, and a branch name
 * containing `/`, spaces or a colon makes `git worktree add` fail with a
 * message the model cannot act on.
 */
export function slugifyWorktreeName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'task';
}

/** Deterministic per-repo directory so worktrees for one repo stay together. */
function worktreeBaseDir(repoRoot: string): string {
  const repoKey = createHash('sha256').update(path.resolve(repoRoot)).digest('hex').slice(0, 12);
  const repoName = path.basename(repoRoot).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'repo';
  return path.join(getDuyaRoot(), 'worktrees', `${repoName}-${repoKey}`);
}

/**
 * Create an isolated worktree for one sub-agent run.
 *
 * @param repoCwd  Directory to isolate from (the parent's working directory).
 * @param rawName  Model-supplied task name; slugified into the branch name.
 */
export async function createIsolatedWorktree(
  repoCwd: string,
  rawName: string,
): Promise<IsolatedWorktree> {
  const repoRootRaw = await gitOrNull(repoCwd, ['rev-parse', '--show-toplevel']);
  if (!repoRootRaw) {
    throw new WorktreeError(
      'not_a_git_repo',
      `isolation: "worktree" requires a git repository, but ${repoCwd} is not inside one. Re-run without isolation, or cd into a repository.`,
    );
  }
  const repoRoot = path.resolve(repoRootRaw.trim());

  // `rev-parse --verify HEAD` fails on a fresh repo with no commit, where
  // `git worktree add` would fail with a far less legible message.
  const head = await gitOrNull(repoCwd, ['rev-parse', '--verify', 'HEAD']);
  if (!head) {
    throw new WorktreeError(
      'no_head',
      `isolation: "worktree" requires at least one commit, but ${repoRoot} has no HEAD yet. Commit something first, or re-run without isolation.`,
    );
  }

  // `git worktree add` refuses to check out over uncommitted changes, and a
  // half-applied worktree would leave the user with a directory they did not
  // ask for. Refuse up front instead.
  const status = await gitOrNull(repoCwd, ['status', '--porcelain']);
  if (status === null) {
    throw new WorktreeError(
      'resolve_failed',
      `isolation: "worktree" could not read the git status of ${repoRoot}. Re-run without isolation.`,
    );
  }
  if (status.trim().length > 0) {
    const changed = status.trim().split('\n').length;
    throw new WorktreeError(
      'dirty_worktree',
      `isolation: "worktree" requires a clean working tree, but ${repoRoot} has ${changed} uncommitted change(s). Commit or stash them first, or re-run without isolation.`,
    );
  }

  const slug = slugifyWorktreeName(rawName);
  // 6 hex chars keeps concurrent spawns of identically-named tasks from
  // colliding on the branch name without making the name unwieldy.
  const suffix = createHash('sha256')
    .update(`${repoRoot}:${slug}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 6);
  const branch = `duya/subagent/${slug}-${suffix}`;
  const worktreePath = path.join(worktreeBaseDir(repoRoot), `${slug}-${suffix}`);

  mkdirSync(path.dirname(worktreePath), { recursive: true });

  try {
    // Args array, never a shell string: the path may contain spaces.
    await git(repoCwd, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  } catch (err) {
    logger.warn('[SubAgent] git worktree add failed', {
      repoRoot,
      branch,
      worktreePath,
      err,
    }, 'SubAgent')
    throw new WorktreeError(
      'worktree_add_failed',
      `isolation: "worktree" could not create an isolated worktree: ${describeGitFailure(err) || 'git worktree add failed'}`,
    );
  }

  logger.info('[SubAgent] isolated worktree created', {
    repoRoot,
    branch,
    worktreePath,
  }, 'SubAgent')

  return { path: worktreePath, branch, repoRoot };
}
