#!/usr/bin/env node
/**
 * Plan 600 — G2 scanner bridge. Emits JSON for `architecture-check.mjs`.
 *
 * ## Why this file exists
 *
 * `layer-purity.ts` has asserted "a `core` module performs no IO" since plan
 * 587 M5.3, and it has 23 passing unit tests. It was never called from
 * `architecture-check.mjs`. Verified by injection on `master` @ 0870966e:
 *
 * ```
 * $ echo "import { readFileSync } from 'node:fs';" >> packages/agent-core/src/run-outcome.ts
 * $ npm run architecture:check
 * OK — no new boundary violations.        # exit 0
 * ```
 *
 * A gate with 23 green tests that no build step runs is worse than no gate: it
 * is evidence, on a screen, that the boundary is enforced.
 *
 * ## Why a bridge rather than importing the .ts directly
 *
 * `architecture-check.mjs` is plain ESM and this repository has no TypeScript
 * runtime dependency (`tsx` is not a dependency, and adding one to run a single
 * scanner is a worse trade). `vite-node` IS present, as a transitive
 * dependency of vitest, and is what the test runner already uses to execute
 * the TypeScript. So the scanner runs through that.
 *
 * A load failure is a non-zero exit with the error on stderr, and
 * `architecture-check.mjs` turns that into a violation. It is never swallowed:
 * a gate that cannot check has to say so, not report OK.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const TARGET = path.join(HERE, 'layer-purity.ts');

if (!existsSync(TARGET)) {
  process.stderr.write(`missing ${TARGET}\n`);
  process.exit(2);
}

const VITE_NODE = [
  path.join(REPO_ROOT, 'node_modules', 'vite-node', 'vite-node.mjs'),
  path.join(REPO_ROOT, 'node_modules', '.bin', 'vite-node.cmd'),
].find((p) => existsSync(p));

if (!VITE_NODE) {
  process.stderr.write('vite-node not found; cannot execute layer-purity.ts\n');
  process.exit(2);
}

// `vite-node` executes FILES, not `-e` snippets — passing `-e` gets "No files
// specified". So the entry is written to a temp file next to this one (so its
// relative imports resolve identically) and removed afterwards.
const entry = path.join(HERE, `.core-io-entry.${process.pid}.mjs`);
writeFileSync(
  entry,
  [
    `import { findCorePurityViolations } from ${JSON.stringify(TARGET)};`,
    'const problems = findCorePurityViolations();',
    'process.stdout.write(JSON.stringify(problems));',
    '',
  ].join('\n'),
  'utf8',
);

const run = spawnSync(process.execPath, [VITE_NODE, entry], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});

rmSync(entry, { force: true });

if (run.error) {
  process.stderr.write(`vite-node failed: ${run.message}\n`);
  process.exit(2);
}
if (run.status !== 0) {
  process.stderr.write(run.stderr || `vite-node exited ${run.status}\n`);
  process.exit(run.status ?? 2);
}

// The scanner returns human-readable problem strings, one per line of the
// report. Normalise them into the shape `architecture-check.mjs` consumes, and
// keep the whole string as the detail so a baseline reviewer can see exactly
// which site was tolerated.
const stdout = (run.stdout || '').trim();
let problems;
try {
  const parsed = JSON.parse(stdout);
  problems = Array.isArray(parsed) ? parsed : [String(parsed)];
} catch (err) {
  process.stderr.write(`scanner did not emit JSON: ${err.message}\n--- stdout ---\n${stdout}\n`);
  process.exit(2);
}

const sites = problems
  .filter((p) => typeof p === 'string' && p.length > 0)
  .map((p) => {
    // `findCorePurityViolations` emits "<file>:<line> <reason>"; splitting it
    // lets the check report point at a file, which is what a reviewer opens.
    const m = /^([^:]+):(\d+)\s*(.*)$/.exec(p);
    if (!m) return { file: 'packages/agent-core', kind: 'core-io', detail: p };
    return { file: m[1].replace(/\\/g, '/'), line: Number(m[2]), kind: 'core-io', detail: m[3] || p };
  });

process.stdout.write(JSON.stringify(sites));
