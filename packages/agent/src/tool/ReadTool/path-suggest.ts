/**
 * path-suggest - friendly path suggestions on ENOENT
 *
 * When a read fails with ENOENT, we try to give the model something
 * more useful than "File not found":
 *
 *   1. macOS screenshots may use either a regular space or a thin
 *      space (U+202F) before "AM"/"PM" depending on macOS version.
 *      Try the alternate and use the result if it works.
 *
 *   2. Find a similar file in the same directory (Levenshtein
 *      over the basename, ignoring case and extension).
 *
 *   3. If the user gave a relative path, suggest the absolute
 *      path under the current working directory.
 */

import { existsSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

// Narrow no-break space (U+202F) used by some macOS versions in screenshot filenames
const THIN_SPACE = ' ';

/**
 * If the path looks like a macOS screenshot, return the alternate
 * space-character variant. Returns undefined if not applicable.
 */
export function getAlternateScreenshotPath(filePath: string): string | undefined {
  const filename = basename(filePath);
  // Match "Screenshot YYYY-MM-DD at H.MM (AM|PM).png" with either
  // a regular space or a thin space before the AM/PM.
  const amPmPattern = /^(.+)([  ])(AM|PM)(\.png)$/;
  const match = filename.match(amPmPattern);
  if (!match) return undefined;
  const currentSpace = match[2];
  const alternateSpace = currentSpace === ' ' ? THIN_SPACE : ' ';
  return filePath.replace(
    `${currentSpace}${match[3]}${match[4]}`,
    `${alternateSpace}${match[3]}${match[4]}`,
  );
}

/**
 * Levenshtein distance — small, dependency-free implementation.
 * Used to score candidate filenames against the requested one.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Find a file in the same directory with a name similar to the
 * requested one. Returns the absolute path of the best match, or
 * undefined if nothing is close enough.
 *
 * "Close enough" = Levenshtein distance ≤ basename.length / 3,
 * case-insensitive comparison.
 */
export function findSimilarFile(filePath: string, maxDistanceRatio = 0.34): string | undefined {
  const dir = dirname(filePath);
  const target = basename(filePath);
  if (!existsSync(dir)) return undefined;

  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const entries = readdirSync(dir);
  const targetLower = target.toLowerCase();

  let best: { name: string; distance: number } | undefined;
  for (const entry of entries) {
    if (entry.toLowerCase() === targetLower) continue; // exact match
    const dist = levenshtein(entry.toLowerCase(), targetLower);
    if (dist / Math.max(entry.length, target.length) > maxDistanceRatio) continue;
    if (!best || dist < best.distance) {
      best = { name: entry, distance: dist };
    }
  }
  return best ? join(dir, best.name) : undefined;
}

/**
 * If filePath is relative and a similar file exists at the given
 * working directory root, return that absolute path. Used as a
 * fallback when the user typed a path that doesn't resolve but a
 * typo-corrected version does.
 */
export function suggestPathUnderCwd(filePath: string, cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  if (filePath.startsWith('/') || /^[a-zA-Z]:[\\\/]/.test(filePath)) {
    // Already absolute; nothing to suggest
    return undefined;
  }
  const absolute = join(cwd, filePath);
  return existsSync(absolute) ? absolute : undefined;
}
