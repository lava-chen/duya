/**
 * WorktreeManager — git worktree isolation for sub-agents (plan 439).
 *
 * Creates short-lived git worktrees under `<repoRoot>/.duya/worktrees/<name>`
 * so a sub-agent can mutate files without racing its siblings or the parent
 * session's working copy (aligned to Claude Code's Agent tool
 * `isolation: 'worktree'` contract):
 *
 * - Base commit defaults to `fresh` (origin's default branch) so parallel
 *   agents share one deterministic starting point; `'head'` keeps local
 *   continuity when requested.
 * - `.duya/worktrees/` is appended to `.git/info/exclude` (local ignore)
 *   instead of touching the user's tracked .gitignore.
 * - Zero-change trees are auto-removed after the agent finishes; dirty trees
 *   are always kept and reported, never silently discarded.
 *
 * All git access goes through an injectable `GitRunner` so tests can run
 * against real throwaway repositories without mocking process internals.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { logger } from '../utils/logger.js';

/** Directory (relative to repo root) that hosts agent worktrees. */
export const WORKTREE_DIR_NAME = '.duya/worktrees';

/** Prefix for branches created for agent worktrees. */
export const WORKTREE_BRANCH_PREFIX = 'duya-worktree';

/** Where fresh base resolution looks, in order, before falling back to HEAD. */
const FRESH_BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'];

export type WorktreeBaseRef = 'fresh' | 'head';

export type GitRunner = (args: string[], cwd?: string) => Promise<string>;

export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const stderr =
          typeof (err as NodeJS.ErrnoException & { stderr?: unknown }).stderr === 'string'
            ? String((err as { stderr?: unknown }).stderr).trim()
            : '';
        reject(new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`));
      } else {
        resolve(stdout.toString());
      }
    });
  });

export interface AgentWorktreeHandle {
  /** Absolute path of the new worktree. */
  path: string;
  /** Branch created for (and checked out in) this worktree. */
  branch: string;
  /** Commit the worktree was created from. */
  baseCommit: string;
  /** Sanitized short name (matches the last path segment). */
  name: string;
  /** Absolute path of the owning repository root — the cwd anchor for later
   * git calls (worktree/branch removal must run outside the tree). */
  repoRoot: string;
}

export interface CreateAgentWorktreeOptions {
  /** Any directory inside the parent repository. */
  repoDir: string;
  /** Short name; sanitized, collision-suffixed, randomized when omitted. */
  name?: string;
  /** `'fresh'` (default) = origin default branch; `'head'` = current HEAD. */
  baseRef?: WorktreeBaseRef;
  /** Override the hosting directory; defaults to `<repoRoot>/.duya/worktrees`. */
  rootDir?: string;
}

export interface CleanupOutcome {
  removed: boolean;
  /** Why the tree was kept ('dirty') or why removal failed. */
  reason?: string;
}

/**
 * Sanitize a caller-provided worktree name into a safe single path segment
 * and git branch tail: `[A-Za-z0-9._-]`, no leading dot/dash, ≤64 chars.
 */
export function sanitizeWorktreeName(raw?: string): string {
  let cleaned = (raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-_]+/, '')
    .replace(/[.\-_]+$/, '')
    .slice(0, 64);
  if (!cleaned || cleaned.includes('..')) {
    cleaned = `wt-${randomUUID().slice(0, 8)}`;
  }
  return cleaned;
}

function branchNameFor(name: string): string {
  return `${WORKTREE_BRANCH_PREFIX}/${name}`;
}

async function resolveRepoRoot(repoDir: string, run: GitRunner): Promise<string> {
  const out = await run(['rev-parse', '--show-toplevel'], repoDir);
  return path.resolve(out.trim());
}

/** Resolve the commit a fresh tree should start from; HEAD is the fallback. */
async function resolveFreshBase(repoDir: string, run: GitRunner): Promise<string> {
  try {
    const symbolic = (await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir)).trim();
    if (symbolic) {
      // e.g. "origin/main" — verified by rev-parse below via candidates.
      const head = await revParseQuiet(repoDir, symbolic, run);
      if (head) return head;
    }
  } catch {
    // No origin remote configured — fall through to candidates.
  }
  for (const candidate of FRESH_BASE_CANDIDATES) {
    const ref = await revParseQuiet(repoDir, candidate, run);
    if (ref) return ref;
  }
  logger.warn('[Worktree] fresh base unresolved, falling back to HEAD', { repoDir }, 'Worktree');
  return (await run(['rev-parse', 'HEAD'], repoDir)).trim();
}

async function revParseQuiet(
  repoDir: string,
  ref: string,
  run: GitRunner,
): Promise<string | null> {
  try {
    const out = await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoDir);
    return out.trim() || null;
  } catch {
    return null;
  }
}

async function ensureExcluded(repoRoot: string, run: GitRunner): Promise<void> {
  const entry = `${WORKTREE_DIR_NAME}/`;
  // Use check-ignore on a probe path inside the dir — covers both tracked
  // .gitignore rules and an existing info/exclude entry in one query.
  try {
    await run(['check-ignore', '-q', `${WORKTREE_DIR_NAME}/probe`], repoRoot);
    return; // exit code 0 → already ignored
  } catch {
    // exit code 1 → not ignored; append to .git/info/exclude (local only).
  }
  const excludePath = path.join(repoRoot, '.git', 'info', 'exclude');
  let current = '';
  try {
    current = await fs.readFile(excludePath, 'utf8');
  } catch {
    // Missing file is fine — create it below.
  }
  const lines = current.split(/\r?\n/);
  if (lines.includes(entry)) return;
  const next = `${current}${current && !current.endsWith('\n') ? '\n' : ''}# duya agent worktrees (plan 439)\n${entry}\n`;
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, next, 'utf8');
}

async function pickUniquePath(rootDir: string, baseName: string): Promise<{ filePath: string; name: string }> {
  let candidate = baseName;
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const filePath = path.join(rootDir, candidate);
    try {
      await fs.access(filePath);
    } catch {
      return { filePath, name: candidate };
    }
    candidate = `${baseName}-${attempt + 1}`;
  }
  throw new Error(`Unable to find a free worktree path under ${rootDir}`);
}

async function pickUniqueBranch(repoDir: string, baseBranch: string, run: GitRunner): Promise<string> {
  let candidate = baseBranch;
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const exists = await revParseQuiet(repoDir, `refs/heads/${candidate}`, run);
    if (!exists) return candidate;
    candidate = `${baseBranch}-${attempt + 1}`;
  }
  throw new Error(`Unable to find a free branch name based on ${baseBranch}`);
}

/**
 * Create a new worktree with a dedicated branch inside the given repository.
 * Throws when `repoDir` is not a git repository or git itself fails — callers
 * surface that as an explicit error rather than degrading silently.
 */
export async function createAgentWorktree(
  options: CreateAgentWorktreeOptions,
  runner: GitRunner = defaultGitRunner,
): Promise<AgentWorktreeHandle> {
  const { repoDir, baseRef = 'fresh' } = options;
  const run = runner;

  const repoRoot = await resolveRepoRoot(repoDir, run);
  const rootDir = options.rootDir ?? path.join(repoRoot, ...WORKTREE_DIR_NAME.split('/'));
  const baseName = sanitizeWorktreeName(options.name);
  const { filePath, name } = await pickUniquePath(rootDir, baseName);

  const baseCommit =
    baseRef === 'head'
      ? (await run(['rev-parse', 'HEAD'], repoRoot)).trim()
      : await resolveFreshBase(repoRoot, run);

  const branch = await pickUniqueBranch(repoRoot, branchNameFor(name), run);

  await fs.mkdir(rootDir, { recursive: true });
  await ensureExcluded(repoRoot, run);

  // -b creates the branch at <base>; two separate args keep Windows paths intact.
  await run(['worktree', 'add', '-b', branch, filePath, baseCommit], repoRoot);

  logger.info('[Worktree] created', { path: filePath, branch, baseCommit }, 'Worktree');
  return { path: filePath, branch, baseCommit, name, repoRoot };
}

/**
 * True when the worktree has any modification or untracked file
 * (`git status --porcelain` output non-empty, ignored files excluded).
 */
export async function isAgentWorktreeDirty(
  worktreePath: string,
  runner: GitRunner = defaultGitRunner,
): Promise<boolean> {
  const out = await runner(['status', '--porcelain'], worktreePath);
  return out.trim().length > 0;
}

/**
 * Remove a worktree and its dedicated branch.
 * Refuses when the tree is dirty unless `force` is set.
 */
export async function removeAgentWorktree(
  handle: Pick<AgentWorktreeHandle, 'path' | 'branch' | 'repoRoot'>,
  opts: { force?: boolean; runner?: GitRunner } = {},
): Promise<CleanupOutcome> {
  const run = opts.runner ?? defaultGitRunner;
  const args = ['worktree', 'remove'];
  if (opts.force) args.push('--force');
  args.push(handle.path);
  // Run from the owning repo root, never from inside the tree being deleted —
  // git cannot remove a worktree that is some process's cwd (Windows EBUSY).
  try {
    await run(args, handle.repoRoot);
  } catch (err) {
    return { removed: false, reason: err instanceof Error ? err.message : String(err) };
  }
  // The branch was created by us for this tree only; delete best-effort.
  try {
    await run(['branch', '-D', handle.branch], handle.repoRoot);
  } catch {
    // Already gone or checked out elsewhere — not worth failing the cleanup.
  }
  logger.info('[Worktree] removed', { path: handle.path, branch: handle.branch }, 'Worktree');
  return { removed: true };
}

/**
 * Auto-cleanup contract: a zero-change tree is deleted outright; a dirty
 * tree is always kept and its path reported back to the model/user.
 */
export async function cleanupIfUnchanged(
  handle: Pick<AgentWorktreeHandle, 'path' | 'branch' | 'repoRoot'>,
  runner: GitRunner = defaultGitRunner,
): Promise<CleanupOutcome> {
  let dirty: boolean;
  try {
    dirty = await isAgentWorktreeDirty(handle.path, runner);
  } catch (err) {
    return { removed: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (dirty) {
    logger.info('[Worktree] kept (dirty)', { path: handle.path, branch: handle.branch }, 'Worktree');
    return { removed: false, reason: 'dirty' };
  }
  return removeAgentWorktree(handle, { runner });
}
