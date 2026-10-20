/**
 * Cross-platform path helpers for `projects.paths` deduplication.
 *
 * Plan 530 §3 — "显示最大的" rule for multi-path project rendering.
 * Lives in renderer (no Node `path` import) so it can be unit-tested
 * under vitest's `node` environment and re-used inside hooks/components.
 *
 * Rules (plan 530 §3.3):
 *   - Win path: case-insensitive segment match, both `\\` and `/` accepted as separators
 *   - POSIX path: case-sensitive segment match, only `/` accepted
 *   - Trailing separators are stripped
 *   - Empty path inputs are preserved (caller decides how to filter)
 *   - `isPathInside(target, root)` returns false when target === root (siblings)
 */

/** Win vs POSIX detection. We follow the source string verbatim: a drive
 *  letter (`C:`), UNC root (`\\host\share`), or backslash separator implies
 *  Win semantics; otherwise POSIX. We don't trust `process.platform` because
 *  the function is called from both renderer (any OS) and tests (vitest
 *  node, but the data may be Win path). */
function isWindowsPath(input: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true;
  if (input.startsWith('\\\\') || input.startsWith('//')) return true;
  if (input.includes('\\')) return true;
  return false;
}

/** Strip trailing `/` or `\\` so `'E:/Projects/duya/'` ≡ `'E:/Projects/duya'`. */
function stripTrailingSeparators(input: string): string {
  return input.replace(/[\\/]+$/, '');
}

/** Normalize separators to `/` for comparison. Does NOT lowercase on POSIX. */
function normalizeForCompare(input: string, isWin: boolean): string {
  const stripped = stripTrailingSeparators(input);
  const unified = stripped.replace(/\\/g, '/');
  return isWin ? unified.toLowerCase() : unified;
}

/**
 * Plan 530 §3 — return true when `target` is strictly inside `root`
 * (a descendant, not the same path). Comparison is segment-aware so
 * `E:/Projects/duya/docs` is inside `E:/Projects/duya` but
 * `E:/Projects/duya-extra` is NOT inside `E:/Projects/duya`.
 *
 * Path comparison follows plan 530 §3.3:
 *   - Win (drive letter / UNC / backslash): case-insensitive
 *   - POSIX: case-sensitive
 *
 * Throws on empty inputs (caller should filter empties upstream).
 */
export function isPathInside(target: string, root: string): boolean {
  if (!target || !root) {
    throw new Error('isPathInside: target and root must be non-empty');
  }

  const targetIsWin = isWindowsPath(target);
  const rootIsWin = isWindowsPath(root);

  const normTarget = normalizeForCompare(target, targetIsWin);
  const normRoot = normalizeForCompare(root, rootIsWin);

  // Mismatched OS hint: fall back to the more restrictive (POSIX
  // case-sensitive) comparison so we never hide a real conflict.
  if (!normTarget.startsWith(normRoot + '/')) return false;
  if (normTarget === normRoot) return false;
  return true;
}

/**
 * Return true when `target` is the same as `root` OR a strict ancestor of
 * `root`. Useful for dedupe: when sorted longest-first, a shorter
 * candidate can be the ancestor of an already-kept longer path and
 * should be dropped. The inverse of `isPathInside`.
 */
export function isPathAncestorOrSame(target: string, root: string): boolean {
  if (!target || !root) {
    throw new Error('isPathAncestorOrSame: target and root must be non-empty');
  }

  const targetIsWin = isWindowsPath(target);
  const rootIsWin = isWindowsPath(root);

  const normTarget = normalizeForCompare(target, targetIsWin);
  const normRoot = normalizeForCompare(root, rootIsWin);

  if (normTarget === normRoot) return true;
  return normRoot.startsWith(normTarget + '/');
}

/**
 * Normalize for dedupe comparison: strip trailing separators and, on
 * Windows paths only, lowercase the result so that `E:/Projects/duya`
 * and `e:/projects/duya/` collapse to the same canonical form. We do
 * NOT lowercase POSIX paths — plan 530 §3.3 keeps them case-sensitive.
 */
function normalizeForDedupe(input: string): string {
  const stripped = stripTrailingSeparators(input);
  const unified = stripped.replace(/\\/g, '/');
  return isWindowsPath(stripped) ? unified.toLowerCase() : unified;
}

/**
 * Plan 530 §3.1 — keep the longest ancestor; drop descendants that are
 * already covered by a kept path. Output is sorted alphabetically for
 * stable display.
 *
 * Algorithm:
 *   1. Filter empty inputs (caller may have user-typed blanks).
 *   2. Normalize (strip trailing separators; lowercase Win paths).
 *      Dedup normalized forms (first occurrence wins).
 *   3. Sort SHORTEST-first so that when we evaluate each candidate,
 *      a candidate whose ancestor is already kept (longer) will be
 *      dropped. This guarantees the longest ancestor wins regardless
 *      of the original input order.
 *   4. Sort the kept set alphabetically for display.
 *
 * Examples (plan 530 §3.2):
 *   Input:  [E:/Projects/duya, E:/Projects/duya/docs,
 *            E:/Projects/duya/docs/exec-plans, E:/Projects/duya-website]
 *   Output: [e:/projects/duya, e:/projects/duya-website]
 */
export function dedupeByContainment(paths: string[]): string[] {
  // 1. Filter empty inputs early.
  const nonEmpty = paths.filter((p) => p && p.length > 0);
  if (nonEmpty.length === 0) return [];

  // 2. Normalize + dedup duplicates (Win case-insensitive).
  const seenNormalized = new Set<string>();
  const inputs: string[] = [];
  for (const p of nonEmpty) {
    const key = normalizeForDedupe(p);
    if (seenNormalized.has(key)) continue;
    seenNormalized.add(key);
    inputs.push(key);
  }
  if (inputs.length === 0) return [];

  // 3. Sort SHORTEST-first so the ancestor (longer) is processed AFTER
  // its shorter ancestor is already kept. Ties preserve first input
  // order via Array.prototype.sort stability (Node 12+).
  const sorted = [...inputs].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const candidate of sorted) {
    const covered = kept.some((ancestor) =>
      isPathAncestorOrSame(ancestor, candidate)
    );
    if (!covered) kept.push(candidate);
  }

  // 4. Display sort.
  return kept.sort();
}

/**
 * Strip trailing `/` or `\\` from a single path. Exported so callers
 * (e.g. the path-config form in plan 525 Phase 4) can normalize user
 * input before saving to `projects.paths`.
 */
export function normalizePath(input: string): string {
  if (!input) return input;
  return stripTrailingSeparators(input);
}

/**
 * Convenience: basename-style display label for a repo node.
 *   `E:/Projects/duya`             -> `duya`
 *   `E:/Projects/duya/`            -> `duya`
 *   `E:/`                          -> `E:`   (root volume)
 *   `\\nas\repo`                   -> `repo`
 *   `/home/user/notes`             -> `notes`
 */
export function basenameFromPath(input: string): string {
  if (!input) return '';
  const unified = stripTrailingSeparators(input).replace(/\\/g, '/');
  // Drive root edge case: `E:/` → `E:`.
  if (/^[a-zA-Z]:$/.test(unified)) return unified;
  // Strip Windows drive prefix for split.
  const driveMatch = unified.match(/^([a-zA-Z]:)(.+)$/);
  const withoutDrive = driveMatch ? driveMatch[2] : unified;
  // Strip UNC host/share prefix: `//host/share/...` → last segment only.
  const uncMatch = withoutDrive.match(/^\/([^/]+)\/([^/]+)(\/.+)?$/);
  if (uncMatch && !uncMatch[3]) {
    // `//host/share` exactly: show the share name.
    return uncMatch[2];
  }
  const segments = withoutDrive.split('/').filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : '';
}