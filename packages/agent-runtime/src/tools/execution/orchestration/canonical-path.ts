/**
 * Path canonicalisation for tool dependency planning — Plan 587 M5.4.
 *
 * The dependency planner decides whether two tool-uses may run in the
 * parallel by comparing path strings. A plain string comparison is wrong
 * the moment two different spellings name the same file: `src/../src/a.ts`
 * vs `src/a.ts`, `/tmp` vs `\tmp`, or — the case that actually bites in
 * production — a symlink or Windows junction pointing at a worktree that
 * the LLM addressed through its real path in one tool_use and through the
 * alias in the next.
 *
 * `planExecution` is deliberately pure and synchronous, so filesystem
 * access must not happen inside it. This module supplies the capability
 * and the planner receives it as an injected `PathCanonicaliser`. The
 * planner stays a function of its inputs; only the injected port touches
 * `fs`.
 *
 * Failure policy: canonicalisation must never throw and never make two
 * different paths look identical. When a path cannot be resolved we fall
 * back to lexical normalisation, and when even that is impossible we
 * return the input unchanged so the planner falls back to string
 * comparison — which is the safe direction (it can only fail to
 * serialise, never to over-serialise into a wrong answer).
 */

import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * Port consumed by `planExecution`. Maps a declared path onto a
 * canonical form so alias spellings compare equal.
 */
export type PathCanonicaliser = (path: string) => string;

/**
 * Sentinels are not filesystem paths. Canonicalising them would turn
 * the "unknown paths" marker into a real path and destroy the
 * conservative-serialisation signal, so they pass through untouched.
 */
const SENTINELS: ReadonlySet<string> = new Set(['__unknown__', '__from_input__']);

/**
 * Resolve `candidate` to an existing filesystem entry, walking up to the
 * deepest ancestor that does exist when the leaf is missing.
 *
 * `WriteTool` routinely targets a file that does not exist yet, and a
 * file the same turn deletes may have vanished. `realpathSync` throws on
 * both, so we canonicalise the nearest existing ancestor and re-append
 * the unresolved tail. That still resolves every symlink / junction in
 * the directory part, which is where aliases actually live.
 */
function realpathWithMissingTail(candidate: string): string | null {
  try {
    return realpathSync.native(candidate);
  } catch {
    /* fall through to the ancestor walk */
  }

  const tail: string[] = [];
  let current = candidate;
  // Bounded walk: the filesystem root is reached after at most the
  // number of path segments, and dirname() is a fixed point at the root.
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return null;
    tail.unshift(current.slice(parent.length + 1));
    try {
      const realParent = realpathSync.native(parent);
      return tail.length === 0 ? realParent : resolve(realParent, ...tail);
    } catch {
      current = parent;
    }
  }
}

/**
 * Build the canonicaliser used by the production tool pipeline.
 *
 * Windows and macOS filesystems are case-insensitive by default, so
 * `Read` and `read` name the same file there. We fold case on those
 * platforms to keep the planner from scheduling two writes to one file.
 * Case folding is deliberately *not* applied on Linux, where
 * `README` and `readme` are genuinely different files and folding them
 * would over-serialise unrelated work.
 */
export function createRealpathCanonicaliser(): PathCanonicaliser {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);

  return (path: string): string => {
    if (path.length === 0) return path;
    if (SENTINELS.has(path)) return path;

    // Relative paths are resolved against the process CWD. The planner
    // is given paths exactly as the tool extracted them, so this keeps
    // `./a.ts` and `a.ts` comparable without threading a base directory
    // through the port.
    const absolute = isAbsolute(path) ? path : resolve(path);

    const real = realpathWithMissingTail(absolute);
    return fold(real ?? absolute);
  };
}

/**
 * Canonicaliser that performs no filesystem access. Used by the planner
 * when the caller injects nothing, and by unit tests that want to pin
 * planner behaviour independently of the filesystem.
 *
 * It still folds case and normalises separators and `.` / `..` segments,
 * because that part is lexical and therefore always safe.
 */
export function createLexicalCanonicaliser(): PathCanonicaliser {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  return (path: string): string => {
    if (path.length === 0) return path;
    if (SENTINELS.has(path)) return path;
    const absolute = resolve(path);
    return caseInsensitive ? absolute.toLowerCase() : absolute;
  };
}
