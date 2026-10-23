#!/usr/bin/env node
/**
 * Agent E — pool the interleaved startup measurement blocks.
 *
 * The machine is shared by five agents, so a single before/after pair of
 * measurement windows is not trustworthy: any drift in machine load lands
 * entirely on one variant. The measurement therefore runs the two variants
 * in ALTERNATING blocks (`baseline-b1`, `after-b1`, `baseline-b2`, …) and
 * pools the blocks per variant, so drift is shared instead of attributed.
 *
 * Usage:
 *   node e2e/perf/agents/agent-e/aggregate-startup.mjs [block files...]
 *   (no args -> the default block list)
 *
 * No packages/ import — this file lives under e2e/ and must stay free of
 * product dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

const DEFAULT_BLOCKS = [
  'baseline-b1', 'after-b1',
  'baseline-b2', 'after-b2',
  'baseline-b3', 'after-b3',
];

const args = process.argv.slice(2);
const blocks = args.length ? args : DEFAULT_BLOCKS;

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

function describe(values) {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (usable.length === 0) return { n: 0 };
  const sorted = [...usable].sort((a, b) => a - b);
  return {
    n: usable.length,
    min: sorted[0],
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: Math.round(usable.reduce((a, b) => a + b, 0) / usable.length),
  };
}

const variants = { baseline: [], after: [] };
const perBlock = [];

for (const block of blocks) {
  const file = path.join(repoRoot, 'e2e', 'perf', 'agents', 'agent-e', `${block}-startup.json`);
  if (!fs.existsSync(file)) {
    perBlock.push({ block, missing: true });
    continue;
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const variant = block.startsWith('baseline') ? 'baseline' : 'after';
  variants[variant].push(...data.results);
  perBlock.push({
    block,
    samples: data.results.length,
    succeeded: data.succeeded,
    typeable: describe(data.results.map((r) => r.startup_typeable_ms)),
    firstPaint: describe(data.results.map((r) => r.startup_firstPaint_ms)),
  });
}

console.log('--- per block ---');
for (const b of perBlock) {
  if (b.missing) { console.log(`${b.block}: MISSING`); continue; }
  console.log(
    `${b.block.padEnd(12)} samples=${b.samples} ok=${b.succeeded} ` +
    `typeable p50=${b.typeable.p50 ?? '-'} (n=${b.typeable.n}) ` +
    `fcp p50=${b.firstPaint.p50 ?? '-'} (n=${b.firstPaint.n})`,
  );
}

console.log('\n--- pooled by variant ---');
const summary = {};
for (const [variant, results] of Object.entries(variants)) {
  const typeable = describe(results.map((r) => r.startup_typeable_ms));
  const firstPaint = describe(results.map((r) => r.startup_firstPaint_ms));
  const ok = results.filter((r) => !r.error && typeof r.startup_typeable_ms === 'number').length;
  summary[variant] = {
    samples: results.length,
    typeable_reached: ok,
    startup_typeable_ms: typeable,
    startup_firstPaint_ms: firstPaint,
  };
  console.log(
    `${variant.padEnd(9)} samples=${results.length} typeable_ok=${ok} ` +
    `typeable ${JSON.stringify(typeable)}`,
  );
  console.log(
    `${' '.padEnd(9)} fcp ${JSON.stringify(firstPaint)}`,
  );
}

const b = summary.baseline?.startup_typeable_ms;
const a = summary.after?.startup_typeable_ms;
if (b && a && b.p50 != null && a.p50 != null) {
  console.log(
    `\ntypeable p50 delta: ${a.p50 - b.p50} ms (${(((a.p50 - b.p50) / b.p50) * 100).toFixed(1)}%)`,
  );
}
const bf = summary.baseline?.startup_firstPaint_ms;
const af = summary.after?.startup_firstPaint_ms;
if (bf && af && bf.p50 != null && af.p50 != null) {
  console.log(
    `fcp p50 delta: ${af.p50 - bf.p50} ms (${(((af.p50 - bf.p50) / bf.p50) * 100).toFixed(1)}%)`,
  );
}
