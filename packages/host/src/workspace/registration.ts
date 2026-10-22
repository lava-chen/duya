/**
 * Read-only helpers that answer "is this directory still a registered linked
 * worktree of this repository?".
 *
 * Registration is the only property that proves a directory is a git
 * worktree and not an ordinary folder that happens to contain a `.git` file.
 * Every consumer (observe / list / bind / reclaim) starts here; a mistyped
 * path must never reach a delete step.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { gitOrNull, gitPathAbsolute } from './git.js';
import { canonicalPath, hasLinkedGitFile, samePath } from './fs-utils.js';

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
}

export interface Registration {
  registered: boolean;
  locked: boolean;
  head: string | null;
  branch: string | null;
  gitDir: string | null;
  commonDir: string | null;
}

const NOT_REGISTERED: Registration = {
  registered: false,
  locked: false,
  head: null,
  branch: null,
  gitDir: null,
  commonDir: null,
};

/**
 * Parse `git worktree list --porcelain -z`. NUL terminates each field and an
 * empty field separates records, which is what makes this safe for paths that
 * contain newlines — the reason the provider never uses the non-`-z` form.
 */
export function parseWorktreeList(raw: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  for (const field of raw.split('\0')) {
    if (field === '') {
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }
    if (field.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = {
        path: field.slice('worktree '.length),
        head: null,
        branch: null,
        detached: false,
        locked: false,
      };
      continue;
    }
    if (!current) continue;
    if (field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length).trim();
    else if (field.startsWith('branch ')) current.branch = field.slice('branch '.length).trim();
    else if (field === 'detached') current.detached = true;
    else if (field === 'locked' || field.startsWith('locked ')) current.locked = true;
  }

  if (current) entries.push(current);
  return entries;
}

export async function worktreeEntries(cwd: string): Promise<WorktreeEntry[] | null> {
  const raw = await gitOrNull(cwd, ['worktree', 'list', '--porcelain', '-z']);
  return raw === null ? null : parseWorktreeList(raw);
}

/**
 * Full identity check for one checkout root.
 *
 * Four conditions, all required:
 *   1. `.git` is a FILE (a linked worktree), not a directory (primary checkout);
 *   2. `--git-dir` differs from `--git-common-dir` (linked, not primary);
 *   3. `git worktree list` still lists this exact root;
 *   4. the administration directory's `gitdir` file points back at this root's
 *      `.git`, so a stale registration occupied by a different checkout does
 *      not pass as ours.
 */
export async function inspectRegistration(root: string): Promise<Registration> {
  const checkout = canonicalPath(root);
  if (!hasLinkedGitFile(checkout)) return NOT_REGISTERED;

  const gitDir = await gitPathAbsolute(checkout, ['--git-dir']);
  const commonDir = await gitPathAbsolute(checkout, ['--git-common-dir']);
  if (!gitDir || !commonDir || samePath(gitDir, commonDir)) return NOT_REGISTERED;

  const entries = await worktreeEntries(checkout);
  if (!entries) return NOT_REGISTERED;
  const entry = entries.find((candidate) => samePath(candidate.path, checkout));
  if (!entry) return NOT_REGISTERED;

  let backlink: string;
  try {
    backlink = readFileSync(path.join(gitDir, 'gitdir'), 'utf8').trim();
  } catch {
    return NOT_REGISTERED;
  }
  if (!backlink) return NOT_REGISTERED;
  if (!samePath(canonicalPath(path.resolve(gitDir, backlink)), canonicalPath(path.join(checkout, '.git')))) {
    return NOT_REGISTERED;
  }

  return {
    registered: true,
    locked: entry.locked,
    head: entry.head,
    branch: entry.branch,
    gitDir,
    commonDir,
  };
}

/** Source repository root for a linked worktree, derived from its common git dir. */
export function sourceRootFromCommonDir(commonDir: string): string {
  return path.dirname(commonDir);
}
