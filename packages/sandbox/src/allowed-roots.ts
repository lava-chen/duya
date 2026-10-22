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
 *
 * Plan 610 A5 continuation (2026-10-10): moved verbatim from
 * `packages/agent/src/tool/allowedRoots.ts` into `@duya/sandbox` — this is
 * the sandbox root-boundary primitive and belongs next to the sandbox
 * adapters, not inside the legacy agent package. The App's `duya-file://`
 * media allowlist (plan 583 ISS-02) and the desktop IPC path checks consume
 * it from here, removing two of the App's runtime imports of `@duya/agent`.
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
 *   1. Resolve the root LEXICALLY (collapses `..` and any trailing
 *      separator) and the target lexically too.
 *   2. `path.relative(lexRoot, lexTarget)` — if it does NOT start with `..`
 *      and is NOT absolute, the target is lexically inside the root.
 *      `path.relative` returns an absolute path when the drives differ on
 *      Windows (e.g. C: → D:), which correctly rejects cross-drive escapes.
 *   3. If the target exists, realpath BOTH the root and the target and
 *      re-check. This catches symlinks inside the root that point outside.
 *      If the target does not exist yet (write case), the lexical check
 *      from step 2 is the best available guarantee and is accepted.
 *
 * ## Why both sides of each comparison are the same KIND of path
 *
 * The lexical check compares a LEXICAL root with a LEXICAL target, and the
 * symlink check compares a REAL root with a REAL target. Mixing them — a
 * realpath'd root against a lexical target — makes the check fail on any
 * machine whose root path passes through a symlink, because the two spellings
 * of the same directory no longer share a prefix.
 *
 * macOS is that machine: `/var` is a symlink to `/private/var`, so a temp
 * root at `/var/folders/.../duya-roots-XXXX` has the realpath
 * `/private/var/folders/.../duya-roots-XXXX`. Comparing that realpath
 * against the lexical target produced `../../../var/folders/...`, the target
 * was judged to be OUTSIDE its own root, and every legitimate path was
 * rejected. Measured on the macOS runner (run 39643430577): 33 assertions
 * across 4 suites failed with `allowed: false` for paths that were plainly
 * inside the workspace.
 *
 * The symlink-escape protection is unchanged and still there: it is step 3,
 * and it compares real against real.
 */
export function isPathWithinRoots(absPath: string, roots: string[]): boolean {
  if (!Array.isArray(roots) || roots.length === 0) return false;
  if (!absPath || !isAbsolute(absPath)) return false;

  const lexTarget = resolve(absPath);

  for (const root of roots) {
    if (!root || !isAbsolute(root)) continue;

    // The LEXICAL root and the LEXICAL target, compared to each other. Both
    // sides must be the same kind of path: see the file header.
    const lexRoot = resolve(root);
    const rel = relative(lexRoot, lexTarget);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      // Lexically inside. Now verify no symlink escape if the target exists.
      // This comparison is realpath against realpath.
      let realRoot: string;
      try {
        realRoot = realpathSync(lexRoot);
      } catch {
        // Root does not exist or is unreadable; cannot anchor here. Skipping
        // it is the original behaviour and it is the safe one.
        continue;
      }
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
