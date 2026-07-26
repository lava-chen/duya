import * as fs from 'fs';
import * as path from 'path';

/**
 * Path normalization utilities for the memory-state control plane.
 *
 * Extracted into a separate module so `workspaceOverrides.ts` and
 * `projectResolver.ts` can share the same rule without creating a
 * circular import (projectResolver imports workspaceOverrides for
 * `loadWorkspaceOverrides`; workspaceOverrides imports this for
 * `normalizePath`).
 *
 * Algorithm (Plan 301 §Phase B "Path normalization"):
 *   1. `path.resolve(input)` — make absolute, collapse `..`/`.`.
 *   2. Try `fs.realpathSync.native(input)` — resolve symlinks. On
 *      ELOOP/ENOENT/EACCES, fall back to the lexical `path.resolve`
 *      result. We never throw on realpath failure.
 *   3. Convert backslashes to forward slashes.
 *   4. `path.posix.normalize` — collapse duplicate slashes, trailing slash.
 *   5. Lowercase drive letter on Windows (e.g. `C:/foo` → `c:/foo`).
 *      Case is preserved otherwise (Linux is case-sensitive).
 */

export interface NormalizedPath {
  /** Lookup key for `project_path_aliases.absolute_normalized_path`. */
  absolute_normalized_path: string;
  /** Identity anchor for `projects.canonical_root`. Same as above for non-override paths. */
  canonical_root: string;
}

export function normalizePath(input: string, platform?: string): NormalizedPath {
  const resolved = path.resolve(input);

  // Try realpath, fall back to lexical on failure. We catch broadly
  // because realpath can throw ELOOP, ENOENT, EACCES, ENOTDIR, etc.
  let real = resolved;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    // Fall back to lexical path. Do NOT throw — the resolver must
    // handle symlink loops and missing paths gracefully.
  }

  // Convert backslashes to forward slashes, then posix-normalize.
  const forward = real.replace(/\\/g, '/');
  const normalized = path.posix.normalize(forward);

  // Lowercase drive letter on Windows for case-insensitive matching.
  const plat = platform ?? process.platform;
  const final = plat === 'win32' ? lowercaseDriveLetter(normalized) : normalized;

  return {
    absolute_normalized_path: final,
    canonical_root: final,
  };
}

function lowercaseDriveLetter(p: string): string {
  // Match `^/[A-Za-z]:/` (forward-slash-prefixed drive letter, e.g. `/C:/foo`)
  // OR `^[A-Za-z]:/` (drive letter at start, e.g. `C:/foo`).
  const m = p.match(/^\/?([A-Za-z]):(\/.*)$/);
  if (m) {
    const prefix = p.startsWith('/') ? '/' : '';
    return `${prefix}${m[1].toLowerCase()}:${m[2]}`;
  }
  return p;
}

/**
 * Walk up the path until we find an ancestor that exists on disk.
 * Returns `null` if no ancestor exists (we hit the filesystem root).
 *
 * Used when the original working directory doesn't exist (e.g.
 * removable drive unmounted, or a historical session whose path was
 * deleted). The walked-to ancestor is used as the identity input so
 * the project_id remains stable.
 *
 * We do NOT merge into the parent project (D5) — the walked-to path
 * is the new identity, not the parent's project_id.
 *
 * Input is the forward-slash normalized form (e.g. `c:/foo/bar`).
 * Output is also forward-slash normalized, or `null` if no ancestor
 * exists.
 */
export function walkToExistingAncestor(normalizedPath: string): string | null {
  // Convert back to platform path for fs.existsSync.
  // On Windows, `c:/foo/bar` → `c:\foo\bar` for fs checks.
  const plat = normalizedPath.replace(/\//g, path.sep);

  let current = plat;
  while (true) {
    try {
      if (fs.existsSync(current)) {
        // Convert back to forward-slash form for storage.
        return current.replace(/\\/g, '/');
      }
    } catch {
      // best-effort — treat as missing.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root.
      return null;
    }
    current = parent;
  }
}
