/**
 * Path layout for managed checkouts.
 *
 * This reproduces the historical layout that `worker-subagents/worktree.ts`
 * already used, on purpose: the on-disk directories of a released build are
 * real state, and switching to codex's 4-hex-character bucket scheme would
 * orphan every existing worktree and break `git worktree list` bookkeeping for
 * users who already have them. Layout, in order:
 *
 *   <root>/<repoName>-<sha256(sourceRoot)[0..12]>/<slug>-<6hex>
 *
 * `<root>` is `desktop.git-worktree-root` when it holds an absolute path, and
 * otherwise the historical `<data root>/worktrees`. The repo-key segment stays
 * in both cases so one configured root can hold checkouts of several
 * repositories without name collisions.
 *
 * `<data root>` keeps honouring `DUYA_APP_DATA_PATH` first (legacy override),
 * then the canonical duya data root. `[desktop]` settings are read from that
 * same root; see `settings.ts` for why.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { resolveCheckoutDataRoot } from './data-root.js';
import { readWorktreeSettings, type WorktreeSettings } from './settings.js';

export { resolveCheckoutDataRoot } from './data-root.js';

/** Duya-owned layout segment below the configured or default root. */
const REPO_KEY_PATTERN = /-[0-9a-f]{12}$/;

/** Whether a directory name is a repository key produced by `repoDirectoryName`. */
export function isRepoKeySegment(name: string): boolean {
  return REPO_KEY_PATTERN.test(name);
}

/**
 * Slugify a label into a directory-safe fragment. Duya-owned labels are
 * already short, but the model supplies `name`, and a path containing `/`,
 * spaces or a colon makes `git worktree add` fail with a message the model
 * cannot act on.
 */
export function slugifyWorktreeName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'task';
}

/** Historical worktrees directory; also the fallback when no root is configured. */
export function defaultWorktreesRoot(): string {
  return path.join(resolveCheckoutDataRoot(), 'worktrees');
}

/**
 * Recognise paths that may be historical managed paths so resume cannot fall
 * back to the parent.
 *
 * This is a shape test, not an identity check: under the default worktrees
 * directory every descendant is duya's namespace, while a user-configured
 * root may also hold unrelated worktrees, so there the `<repo>-<hash>`
 * segment is required. Authorization still comes from registration plus the
 * owner file (`assertWritable`), never from this helper.
 */
export function isManagedCheckoutPath(directory: string): boolean {
  const target = path.resolve(directory);
  const defaultRoot = defaultWorktreesRoot();
  if (isStrictDescendant(defaultRoot, target)) return true;

  const configuredRoot = readWorktreeSettings().root;
  if (configuredRoot === null) return false;
  if (!isStrictDescendant(configuredRoot, target)) return false;
  const repoKey = path.relative(configuredRoot, target).split(path.sep)[0] ?? '';
  return isRepoKeySegment(repoKey);
}

/** Deterministic per-repository directory under the historical root. */
export function defaultManagedRootFor(sourceRoot: string): string {
  return path.join(defaultWorktreesRoot(), repoDirectoryName(sourceRoot));
}

/** Deterministic per-repository directory under the configured (or default) root. */
export function managedRootFor(
  sourceRoot: string,
  settings: WorktreeSettings = readWorktreeSettings(),
): string {
  return path.join(settings.root ?? defaultWorktreesRoot(), repoDirectoryName(sourceRoot));
}

/** Six hex characters keep concurrent checkouts of identically named tasks apart. */
export function allocateCheckoutName(slug: string, sourceRoot: string): string {
  const suffix = createHash('sha256')
    .update(`${sourceRoot}:${slug}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 6);
  return `${slug}-${suffix}`;
}

function repoDirectoryName(sourceRoot: string): string {
  const repoKey = createHash('sha256').update(path.resolve(sourceRoot)).digest('hex').slice(0, 12);
  const repoName = path.basename(sourceRoot).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'repo';
  return `${repoName}-${repoKey}`;
}

function isStrictDescendant(base: string, target: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
