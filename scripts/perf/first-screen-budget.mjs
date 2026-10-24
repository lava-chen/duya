#!/usr/bin/env node
/**
 * scripts/perf/first-screen-budget.mjs — the CI gate on the renderer's
 * first-screen payload.
 *
 * WHAT IT GATES
 *
 * The bytes of JavaScript the renderer must download and evaluate before the
 * first screen can paint. Bytes are machine-independent, so this gate means
 * the same thing on every runner, unlike a wall-clock threshold.
 *
 * WHAT IT DOES NOT GATE
 *
 * Wall-clock time. A shared CI runner is too noisy for that, and the
 * authoritative numbers live in the sprint's plan document as trends, not as
 * thresholds.
 *
 * HOW THE BUDGET WAS CALIBRATED
 *
 * Two independent production builds of the same tree measured 3538.1 KB
 * (PR #401's claim) and 3541.1 KB (the integrator's serial re-profile) —
 * 0.08 % apart; the entry chunk 2659.2 KB and 2662.2 KB, 0.11 % apart. The
 * tolerance is 5 %, about fifty times the observed build-to-build spread,
 * while the smallest regression worth catching — the provider SDKs coming
 * back into the entry chunk — is roughly 15 %.
 *
 * Exit codes
 *   0  the budget holds
 *   1  the budget was exceeded (or nothing was measured)
 *   2  the build output was missing, so there was nothing to measure
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeFirstScreenPayload, readChunkDump } from '../../e2e/perf/lib/first-screen.mjs';
import { evaluateBudget } from '../../e2e/perf/lib/first-screen-budget.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
function flag(name) {
  return args.includes(name);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distDir = path.resolve(repoRoot, option('--dist', 'dist'));
const budgetPath = path.resolve(repoRoot, option('--budget', 'e2e/perf/baselines/first-screen-payload.json'));

if (!fs.existsSync(path.join(distDir, 'assets'))) {
  console.error(`[perf-budget] no renderer build at ${distDir} — run the production build first`);
  process.exit(2);
}
if (!fs.existsSync(budgetPath)) {
  console.error(`[perf-budget] no budget at ${budgetPath}`);
  process.exit(2);
}

const budget = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
const payload = computeFirstScreenPayload({
  distDir,
  chunkDump: readChunkDump(option('--chunk-dump', null)),
  repoRoot,
});

const { checks, violations, tolerancePct } = evaluateBudget(payload, budget);

if (flag('--json')) {
  console.log(JSON.stringify({ payload, budget, checks, violations, tolerancePct }, null, 2));
} else {
  console.log(`[perf-budget] dist=${payload.dist} entry=${payload.entry}`);
  console.log(`[perf-budget] budget ${budget.recordedAt ?? 'unrecorded'} @ ${budget.commit ?? 'unknown commit'} `
    + `(tolerance ${tolerancePct}%)`);
  for (const check of checks) {
    const limit = check.limit == null ? '' : ` / limit ${check.limit}`;
    console.log(
      `[perf-budget] ${check.metric}: ${check.measured} (baseline ${check.baseline ?? '-'}${limit})`
      + (check.deltaPct == null ? '' : ` ${check.deltaPct >= 0 ? '+' : ''}${check.deltaPct}%`),
    );
  }
  console.log(`[perf-budget] first screen: ${payload.firstScreen.kb} KB in ${payload.firstScreen.chunkCount} chunks; `
    + `total JS ${payload.totalJs.kb} KB in ${payload.totalJs.chunkCount} chunks`);
}

if (violations.length > 0) {
  for (const violation of violations) console.error(`[perf-budget] FAIL: ${violation}`);
  process.exit(1);
}
console.log('[perf-budget] OK — the first-screen payload is within budget');
