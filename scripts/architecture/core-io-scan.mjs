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
 * scanner is a worse trade). `esbuild` IS a dependency, and it is the very
 * transform the test runner itself uses, so the scanner compiles the same
 * TypeScript the same way and runs the result with plain node.
 *
 * This used to go through `vite-node`, which was present only as a
 * TRANSITIVE dependency of vitest. Vitest 5 does not depend on `vite-node`
 * any more, so the transitive copy disappeared and this scanner could not
 * run at all: `architecture-check.mjs` reported "vite-node not found;
 * cannot execute layer-purity.ts" as a boundary violation. A gate that cannot
 * check has to say so — but it also has to keep checking, which is why the
 * execution path now rests on a dependency this repository DECLARES.
 *
 * A load failure is a non-zero exit with the error on stderr, and
 * `architecture-check.mjs` turns that into a violation. It is never swallowed:
 * a gate that cannot check has to say so, not report OK.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const TARGET = path.join(HERE, 'layer-purity.ts');

if (!existsSync(TARGET)) {
  process.stderr.write(`missing ${TARGET}\n`);
  process.exit(2);
}

// The entry is written to a temp file next to this one (so its relative
// imports resolve identically) and removed afterwards.
const entry = path.join(HERE, `.core-io-entry.${process.pid}.mjs`);
const bundle = path.join(HERE, `.core-io-bundle.${process.pid}.mjs`);
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

// `bundle: true` so a relative import inside `layer-purity.ts` resolves
// instead of being left for node to load as `.ts`. The bundle is written NEXT
// TO the target on purpose: `layer-purity.ts` derives the repo root from its
// own `import.meta.url`, and a bundle in the same directory resolves to the
// same root.
try {
  buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    logLevel: 'silent',
  });
} catch (err) {
  rmSync(entry, { force: true });
  process.stderr.write(`esbuild failed: ${err.message}\n`);
  process.exit(2);
}

const run = spawnSync(process.execPath, [bundle], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});

rmSync(entry, { force: true });
rmSync(bundle, { force: true });

if (run.error) {
  process.stderr.write(`scanner failed: ${run.message}\n`);
  process.exit(2);
}
if (run.status !== 0) {
  process.stderr.write(run.stderr || `scanner exited ${run.status}\n`);
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
