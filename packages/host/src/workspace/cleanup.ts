/**
 * Retention-based cleanup of managed checkouts.
 *
 * This module decides *which* checkouts are candidates; it never decides that
 * one may be deleted. That answer comes from `reclaim()`, which owns the
 * fail-closed matrix (plan 621 decision D8). A checkout that is dirty, owned by
 * a live session, in use as a cwd, locked, detached-unreferenced or holding a
 * reparse point is reported in `retained` and stays on disk.
 *
 * Ordering uses `duya-checkout.json`'s `createdAt`. A checkout created by an
 * earlier build has no such field and falls back to the directory mtime;
 * corrupt metadata is `failed`, not "old enough to delete".
 */

import { readdirSync, statSync, type Dirent } from 'node:fs';
import * as path from 'node:path';
import type {
  CheckoutProvider,
  CheckoutRetainReason,
  CheckoutRoot,
  WorktreeCleanupOptions,
  WorktreeCleanupResult,
} from './types.js';
import { readCheckoutOrigin } from './checkout-origin.js';
import { canonicalPath } from './fs-utils.js';
import { gitOrNull } from './git.js';
import { defaultWorktreesRoot, isRepoKeySegment } from './paths.js';
import { inspectRegistration, sourceRootFromCommonDir } from './registration.js';
import { readWorktreeSettings, type WorktreeSettings } from './settings.js';

/** The two provider calls cleanup needs; keeps tests free of the whole class. */
export type CleanupPort = Pick<CheckoutProvider, 'list' | 'reclaim' | 'observe'>;

export async function runWorktreeCleanup(
  port: CleanupPort,
  options: WorktreeCleanupOptions = {},
  settings: WorktreeSettings = readWorktreeSettings(),
): Promise<WorktreeCleanupResult> {
  const dryRun = options.dryRun === true;
  const keepCount = settings.keepCount;
  const protectedRoots = new Set((options.protectRoots ?? []).map((root) => canonicalPath(root)));
  const repositories = await resolveRepositories(options, settings);

  const removed: string[] = [];
  const retained: { root: string; reason: CheckoutRetainReason }[] = [];
  const failed: { root: string; message: string }[] = [];
  let examined = 0;

  for (const repository of repositories) {
    let checkouts: CheckoutRoot[];
    try {
      checkouts = await port.list(repository);
    } catch (error) {
      failed.push({ root: repository, message: messageOf(error) });
      continue;
    }
    examined += checkouts.length;

    const ordered = await newestFirst(checkouts, failed);
    for (const checkout of ordered.slice(keepCount)) {
      if (protectedRoots.has(canonicalPath(checkout.root))) continue;
      try {
        if (dryRun) {
          const verdict = (await port.observe(checkout.root)).reclaim;
          if (verdict.ok) removed.push(checkout.root);
          else retained.push({ root: checkout.root, reason: verdict.reason });
        } else {
          const verdict = await port.reclaim(checkout.root);
          if (verdict.removed) removed.push(checkout.root);
          else retained.push({ root: checkout.root, reason: verdict.reason });
        }
      } catch (error) {
        failed.push({ root: checkout.root, message: messageOf(error) });
      }
    }
  }

  return { dryRun, keepCount, examined, removed, retained, failed };
}

/**
 * Source repositories with managed checkouts below the current or default
 * root. A directory only counts when its child is a registered linked
 * worktree; a user folder that merely resembles `<repo>-<hash>` is skipped.
 */
export async function discoverManagedRepos(
  settings: WorktreeSettings = readWorktreeSettings(),
): Promise<string[]> {
  const roots = new Set([
    canonicalPath(defaultWorktreesRoot()),
    canonicalPath(settings.root ?? defaultWorktreesRoot()),
  ]);
  const repositories = new Set<string>();

  for (const root of roots) {
    for (const repoEntry of readDirectories(root)) {
      if (!isRepoKeySegment(repoEntry.name)) continue;
      const repoDirectory = path.join(root, repoEntry.name);
      for (const checkoutEntry of readDirectories(repoDirectory)) {
        const registration = await inspectRegistration(path.join(repoDirectory, checkoutEntry.name));
        if (!registration.registered || !registration.commonDir) continue;
        repositories.add(canonicalPath(sourceRootFromCommonDir(registration.commonDir)));
      }
    }
  }

  return [...repositories].sort();
}

async function resolveRepositories(
  options: WorktreeCleanupOptions,
  settings: WorktreeSettings,
): Promise<string[]> {
  const explicit = options.sourceCwd?.trim();
  if (explicit) {
    const toplevel = await gitOrNull(canonicalPath(explicit), ['rev-parse', '--show-toplevel']);
    const sourceRoot = toplevel?.trim();
    return sourceRoot ? [canonicalPath(sourceRoot)] : [];
  }

  const repositories = new Set(await discoverManagedRepos(settings));
  for (const sourceRoot of options.sourceRoots ?? []) {
    repositories.add(canonicalPath(sourceRoot));
  }
  return [...repositories].sort();
}

/**
 * Newest first, with creation metadata as the order and directory mtime as the
 * legacy fallback. Unreadable metadata removes the checkout from the
 * candidates: not knowing its age is a reason to keep it.
 */
async function newestFirst(
  checkouts: readonly CheckoutRoot[],
  failed: { root: string; message: string }[],
): Promise<CheckoutRoot[]> {
  const ordered: { checkout: CheckoutRoot; createdAt: number }[] = [];
  for (const checkout of checkouts) {
    try {
      const origin = await readCheckoutOrigin(checkout.root);
      ordered.push({ checkout, createdAt: origin?.createdAt ?? mtimeOf(checkout.root) });
    } catch (error) {
      failed.push({ root: checkout.root, message: messageOf(error) });
    }
  }
  ordered.sort((left, right) =>
    right.createdAt - left.createdAt || (left.checkout.root < right.checkout.root ? -1 : 1));
  return ordered.map((entry) => entry.checkout);
}

function readDirectories(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
}

function mtimeOf(directory: string): number {
  try {
    return statSync(directory).mtimeMs;
  } catch {
    return 0;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
