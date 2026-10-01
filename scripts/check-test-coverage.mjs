#!/usr/bin/env node
// scripts/check-test-coverage.mjs
// Ratcheting gate for "a test file nobody ever runs" (plan 583, ISS-49).
//
// Why this exists: vitest.config.ts's `test.include` is an explicit allow-list,
// not a convention like `**/*.test.ts`. Any tracked test file outside those
// globs is collected by nobody, runs in CI for nobody, and fails for nobody.
// That is the same failure class as the suite that reported "no tests" instead
// of failing: coverage that looks present in the tree but is never exercised.
//
// This is a STATIC check on purpose. Running vitest to find out which files it
// picked up is not viable here: `vitest list` over the whole repo takes ~70s
// and drowns in pre-existing module-resolution errors (@lobehub/ui,
// react-syntax-highlighter on Windows), so its output cannot be trusted as a
// completeness signal. Matching the globs directly is deterministic and free.
//
// Note what this does NOT claim: a file CAN be matched by an include glob and
// still contribute nothing meaningful. What it catches is the silent case -
// a file the runner never even looks at.
//
// Usage:
//   node scripts/check-test-coverage.mjs          # check (CI)
//   node scripts/check-test-coverage.mjs --write  # re-record the baseline

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const baselinePath = resolve(scriptDir, 'test-coverage-baseline.json');
const configPath = resolve(repoRoot, 'vitest.config.ts');

const write = process.argv.includes('--write');

/** A file that looks like a test by name. */
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Convert a vitest include glob (only the forms actually used here) to RegExp. */
function globToRegExp(glob) {
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
function readIncludeGlobs() {
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

function trackedFiles() {
  const proc = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    process.stderr.write('check-test-coverage: git ls-files failed.\n');
    process.exit(2);
  }
  return proc.stdout.toString('utf8').split('\0').filter(Boolean);
}

const globs = readIncludeGlobs();
const matchers = globs.map(globToRegExp);

const orphans = [];
let total = 0;
for (const file of trackedFiles()) {
  const posix = file.replace(/\\/g, '/');
  if (!TEST_FILE.test(posix)) continue;
  // e2e/ has its own Playwright runner (e2e/playwright.config.ts); it is not
  // supposed to be in the vitest include list.
  if (posix.startsWith('e2e/')) continue;
  // docs/ holds archival material, not code. Nothing under docs/ is in any
  // tsconfig include either, so a .test.ts there is a recovered plan that
  // happens to be a TypeScript file - flagging it would be noise, and acting
  // on it (by collecting it) would be worse than leaving it alone.
  if (posix.startsWith('docs/')) continue;
  total++;
  if (!matchers.some((re) => re.test(posix))) orphans.push(posix);
}

const current = orphans.slice().sort();

if (write) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `check-test-coverage: baseline written (${current.length} of ${total} test files uncollected).\n`,
  );
  process.exit(0);
}

let known = [];
if (existsSync(baselinePath)) {
  try {
    known = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    process.stderr.write('check-test-coverage: baseline unreadable; re-record with --write.\n');
    process.exit(2);
  }
}
const knownSet = new Set(known);
const fresh = current.filter((f) => !knownSet.has(f));

if (fresh.length > 0) {
  process.stderr.write(
    `check-test-coverage: ${fresh.length} test file(s) that no vitest include glob collects.\n`
    + 'A test file outside test.include never runs. Either move it under a glob or\n'
    + 'add the glob to vitest.config.ts.\n'
    + fresh.map((f) => `  ${f}`).join('\n')
    + '\n'
    + `Checked globs:\n${globs.map((g) => `  ${g}`).join('\n')}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `check-test-coverage: OK — every tracked test file is collected`
  + `${known.length ? ` (${known.length} known orphans in baseline)` : ''}.\n`,
);
