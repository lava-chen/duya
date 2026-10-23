#!/usr/bin/env node
/**
 * summarise.mjs — turn the raw result JSON into the table the PR quotes.
 *
 * The point of this script is that the numbers in the report are the numbers
 * in the files, computed by code rather than by hand. It prints one row per
 * (mode, scenario) with the median across repeats, plus the raw per-repeat
 * values, so a single lucky run cannot hide behind a median.
 *
 * Usage:
 *   node e2e/perf/agents/agent-d/summarise.mjs <result.json> [more.json ...]
 */

import * as fs from 'node:fs';

const METRICS = [
  'frame.p95_ms',
  'frame.p50_ms',
  'frame.mean_ms',
  'frame.max_ms',
  'longtask.count',
  'longtask.total_ms',
  'longtask.max_ms',
];

function median(values) {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('usage: summarise.mjs <result.json> [...]\n');
  process.exit(1);
}

const runs = [];
for (const file of files) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const run of parsed.runs ?? []) runs.push({ ...run, file });
}

if (runs.length === 0) {
  process.stdout.write('no runs in the given files\n');
  process.exit(0);
}

process.stdout.write(`runs: ${runs.length}\n\n`);

// --- GPU state per run ------------------------------------------------------
process.stdout.write('GPU state per run\n');
for (const run of runs) {
  const status = run.rendererGpuStatus;
  const feature = run.mainProcessGpu?.featureStatus ?? {};
  process.stdout.write(
    `  ${run.mode} #${run.repeat}: compositing=${status?.compositing ?? 'n/a'} ` +
      `gpu_compositing=${feature.gpu_compositing ?? 'n/a'} webgl=${feature.webgl ?? 'n/a'} ` +
      `terminal=${run.terminal?.dataRenderer ?? 'n/a'}->${run.terminalAfter?.dataRenderer ?? 'n/a'} ` +
      `gpuProcessExits=${status?.gpuProcessExitCount ?? 'n/a'} ` +
      `webglContextLosses=${status?.webglContextLossCount ?? 'n/a'}` +
      `${run.rendererGpuStatusAfterLoss ? ` ->${run.rendererGpuStatusAfterLoss.webglContextLossCount}` : ''}` +
      `${run.errors?.length ? ` ERRORS=${run.errors.length}` : ''}\n`,
  );
}
process.stdout.write('\n');

// --- Metrics per (mode, scenario) -------------------------------------------
const keys = [...new Set(runs.flatMap((run) => run.scenarios.map((s) => s.scenario)))];
for (const mode of [...new Set(runs.map((r) => r.mode))]) {
  const modeRuns = runs.filter((r) => r.mode === mode);
  process.stdout.write(`mode=${mode} (${modeRuns.length} runs)\n`);
  for (const scenario of keys) {
    const rows = modeRuns
      .map((run) => run.scenarios.find((s) => s.scenario === scenario))
      .filter(Boolean);
    if (rows.length === 0) continue;
    const cells = METRICS.map((metric) => {
      const values = rows.map((row) => row[metric]);
      const med = median(values);
      const raw = values.map((v) => (typeof v === 'number' ? v.toFixed(1) : 'n/a')).join('/');
      return `${metric}=${med === null ? 'n/a' : med.toFixed(1)} [${raw}]`;
    });
    process.stdout.write(`  ${scenario} (n=${rows.length}): ${cells.join('  ')}\n`);
  }
  process.stdout.write('\n');
}

// --- Errors -----------------------------------------------------------------
const failed = runs.filter((run) => run.errors?.length);
if (failed.length) {
  process.stdout.write(`runs with errors: ${failed.length}\n`);
  for (const run of failed) {
    process.stdout.write(`  ${run.mode} #${run.repeat}: ${run.errors.join(' | ').slice(0, 400)}\n`);
  }
}
