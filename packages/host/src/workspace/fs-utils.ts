/**
 * Filesystem primitives shared by the checkout provider and the fail-closed
 * remover. Nothing here deletes recursively: on Windows a recursive delete
 * walks THROUGH NTFS junctions, which is how two incidents (2026-08-25,
 * 2026-10-03) wiped the primary checkout's packages.
 */

import { lstatSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Resolve a path the way git reports it: through junctions and 8.3 short
 * names. Falls back to `path.resolve` for paths that do not exist yet, so a
 * missing root still yields a comparable absolute string.
 */
export function canonicalPath(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/** Windows paths are case-insensitive; compare them that way. */
export function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isFile(target: string): boolean {
  try {
    return lstatSync(target).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(target: string): boolean {
  try {
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** True when the directory is a linked worktree (its `.git` is a file, not a dir). */
export function hasLinkedGitFile(root: string): boolean {
  return isFile(path.join(root, '.git'));
}

export interface ReparseScan {
  /** Reparse points (junctions / symlinks) found without following any of them. */
  links: string[];
  /** False when a directory could not be listed, so "none found" is not proven. */
  complete: boolean;
}

/**
 * Scan for reparse points without ever following one. A link is reported and
 * NOT descended into; its target may be the user's primary checkout.
 */
export function scanReparsePoints(root: string): ReparseScan {
  const links: string[] = [];
  let complete = true;
  const pending: string[] = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      complete = false;
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      // `lstat` is the authority here: Node reports NTFS junctions as
      // symbolic links, and a branch/commit can also contain a symlink.
      let isLink = entry.isSymbolicLink();
      if (!isLink) {
        try {
          isLink = lstatSync(full).isSymbolicLink();
        } catch {
          complete = false;
          continue;
        }
      }
      if (isLink) {
        links.push(full);
        continue;
      }
      if (entry.isDirectory()) pending.push(full);
    }
  }

  return { links, complete };
}

/**
 * Remove a junction / symlink itself, never its target. A directory junction
 * needs `rmdir`; a file symlink needs `unlink`. Both leave the target intact.
 */
export function unlinkReparsePoint(target: string): void {
  let targetIsDirectory = false;
  try {
    targetIsDirectory = statSync(target).isDirectory();
  } catch {
    // Dangling link: only the link itself exists.
    targetIsDirectory = false;
  }

  if (targetIsDirectory) {
    try {
      rmdirSync(target);
      return;
    } catch {
      // Fall through to unlink for links Windows refuses to rmdir.
    }
  }
  unlinkSync(target);
}

/** Remove a directory only if it is empty. Never recursive. */
export function removeEmptyDirectory(target: string): void {
  try {
    rmdirSync(target);
  } catch {
    // Not empty, already gone, or locked: leave it. Callers must not escalate.
  }
}
