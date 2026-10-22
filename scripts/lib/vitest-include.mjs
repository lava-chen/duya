/**
 * vitest-include.mjs — the single source of truth for "which files does the
 * vitest runner collect?".
 *
 * Two tools need that answer and must not disagree:
 *   - scripts/check-test-coverage.mjs — the gate that fails when a tracked test
 *     file is collected by nobody;
 *   - scripts/test-inventory.mjs — the inventory that says what each collected
 *     file costs and what it proves.
 *
 * A gate and an inventory that read the globs differently would produce
 * contradictory verdicts about the same file, so the parsing lives here once.
 *
 * The globs are read TEXTUALLY from vitest.config.ts on purpose: importing the
 * config would pull in the whole Vite pipeline (and its resolution of every
 * package's `exports` map) into a script that only needs a list of strings.
 *
 * NOTE: the parser scans quoted strings inside the `include` array. It does not
 * strip comments, so an apostrophe in a comment inside that array would swallow
 * the rest of the file's globs. vitest.config.ts already carries that warning
 * next to the array; keep it in mind before adding one.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Convert a vitest include glob (only the forms actually used here) to RegExp. */
export function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories.
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`);
}

/** Read `test.include` out of vitest.config.ts without importing it. */
export function readIncludeGlobs(repoRoot) {
  const configPath = resolve(repoRoot, 'vitest.config.ts');
  const src = readFileSync(configPath, 'utf8');
  const start = src.indexOf('include:');
  if (start === -1) throw new Error('could not find `include:` in vitest.config.ts');
  const open = src.indexOf('[', start);
  const close = src.indexOf(']', open);
  if (open === -1 || close === -1) throw new Error('could not parse the include array');
  const globs = [];
  for (const m of src.slice(open, close).matchAll(/'([^']+)'/g)) globs.push(m[1]);
  if (globs.length === 0) throw new Error('include array parsed as empty');
  return globs;
}

/** The globs plus a matcher for them. */
export function includeMatchers(repoRoot) {
  const globs = readIncludeGlobs(repoRoot);
  return { globs, matchers: globs.map(globToRegExp) };
}
