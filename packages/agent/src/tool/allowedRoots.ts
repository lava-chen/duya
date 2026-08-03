/**
 * Root-boundary check for sandboxed file tools.
 *
 * When a tool is constructed with `allowedRoots`, every target path must
 * resolve to a location inside one of the roots. This rejects:
 *   - `..` traversal that escapes the root lexically
 *   - symlinks inside the root that point outside (realpath mismatch)
 *   - cross-drive paths on Windows (path.relative returns an absolute path)
 *   - sibling paths that share a string prefix with the root but are not
 *     inside it (a naive `startsWith` would accept these)
 *
 * Used by the Phase 2 memory curator process (design §7.2) to bind the
 * five file tools to a staging workspace so the agent literally cannot
 * name live memory, the DB, or the user home.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, relative } from 'node:path';

/**
 * Returns true iff `absPath` resolves to a location inside at least one
 * of `roots`. Both arguments are expected to be absolute; non-absolute
 * inputs are rejected. Returns `false` for an empty `roots` array —
 * callers gate on `allowedRoots?.length` to express "unrestricted".
 *
 * Resolution strategy per root:
 *   1. Realpath the root (root must exist; non-existent roots are skipped).
 *   2. Lexically resolve the target with `path.resolve` (collapses `..`).
 *   3. `path.relative(realRoot, lexTarget)` — if it does NOT start with
 *      `..` and is NOT absolute, the target is lexically inside the root.
 *      `path.relative` returns an absolute path when the drives differ on
 *      Windows (e.g. C: → D:), which correctly rejects cross-drive escapes.
 *   4. If the target exists, realpath it and re-check against the real
 *      root. This catches symlinks inside the root that point outside.
 *      If the target does not exist yet (write case), the lexical check
 *      from step 3 is the best available guarantee and is accepted.
 */
export function isPathWithinRoots(absPath: string, roots: string[]): boolean {
  if (!Array.isArray(roots) || roots.length === 0) return false;
  if (!absPath || !isAbsolute(absPath)) return false;

  const lexTarget = resolve(absPath);

  for (const root of roots) {
    if (!root || !isAbsolute(root)) continue;

    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      // Root does not exist or is unreadable; cannot anchor here.
      continue;
    }

    const rel = relative(realRoot, lexTarget);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      // Lexically inside. Now verify no symlink escape if the target exists.
      try {
        const realTarget = realpathSync(lexTarget);
        const relReal = relative(realRoot, realTarget);
        if (relReal === '' || (!relReal.startsWith('..') && !isAbsolute(relReal))) {
          return true;
        }
        // Target's realpath escaped the root — reject and keep scanning roots.
        continue;
      } catch {
        // Target does not exist yet (e.g. WriteTool creating a new file).
        // Lexical containment is the best available check; accept it.
        return true;
      }
    }
  }
  return false;
}