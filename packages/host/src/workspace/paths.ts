/**
 * Path layout for managed checkouts.
 *
 * This reproduces the historical layout that `worker-subagents/worktree.ts`
 * already used, on purpose: the on-disk directories of a released build are
 * real state, and switching to codex's 4-hex-character bucket scheme would
 * orphan every existing worktree and break `git worktree list` bookkeeping for
 * users who already have them. Layout, in order:
 *
 *   <data root>/worktrees/<repoName>-<sha256(sourceRoot)[0..12]>/<slug>-<6hex>
 *
 * `<data root>` keeps honouring `DUYA_APP_DATA_PATH` first (legacy override),
 * then the canonical duya data root.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { resolveDataRoot } from '@duya/data/data-paths';

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

/** Data root for managed checkouts; env override first, matching the legacy module. */
export function resolveCheckoutDataRoot(): string {
  return process.env.DUYA_APP_DATA_PATH?.trim() || resolveDataRoot();
}

/** Recognise missing historical managed paths so resume cannot fall back to the parent. */
export function isManagedCheckoutPath(directory: string): boolean {
  const relative = path.relative(path.resolve(resolveCheckoutDataRoot(), 'worktrees'), path.resolve(directory));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Deterministic per-repository directory so checkouts for one repo stay together. */
export function managedRootFor(sourceRoot: string): string {
  const repoKey = createHash('sha256').update(path.resolve(sourceRoot)).digest('hex').slice(0, 12);
  const repoName = path.basename(sourceRoot).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'repo';
  return path.join(resolveCheckoutDataRoot(), 'worktrees', `${repoName}-${repoKey}`);
}

/** Six hex characters keep concurrent checkouts of identically named tasks apart. */
export function allocateCheckoutName(slug: string, sourceRoot: string): string {
  const suffix = createHash('sha256')
    .update(`${sourceRoot}:${slug}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 6);
  return `${slug}-${suffix}`;
}
