import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [baselineArg, currentArg, outputArg] = process.argv.slice(2);
if (!baselineArg || !currentArg) {
  console.error('Usage: node evals/agent/performance/compare.mjs <baseline.json> <current.json> [comparison.json]');
  process.exit(2);
}
const baseline = JSON.parse(await readFile(resolve(baselineArg), 'utf8'));
const current = JSON.parse(await readFile(resolve(currentArg), 'utf8'));
if (baseline.schemaVersion !== current.schemaVersion) throw new Error('Report schema versions differ');
if (baseline.fixture !== current.fixture) throw new Error('Fixture versions differ');
if (baseline.environment.node !== current.environment.node || baseline.environment.platform !== current.environment.platform || baseline.environment.arch !== current.environment.arch) {
  throw new Error('Runtime environments differ; refusing an apples-to-oranges comparison');
}
const byId = new Map(baseline.results.map((result) => [result.id, result]));
const comparisons = current.results.map((result) => {
  const prior = byId.get(result.id);
  if (!prior) throw new Error(`Baseline lacks scenario ${result.id}`);
  const counterNames = new Set([...Object.keys(prior.counters), ...Object.keys(result.counters)]);
  const counterDifferences = Object.fromEntries([...counterNames]
    .filter((name) => prior.counters[name] !== result.counters[name])
    .sort()
    .map((name) => [name, {
      baseline: prior.counters[name] ?? 0,
      current: result.counters[name] ?? 0,
      delta: (result.counters[name] ?? 0) - (prior.counters[name] ?? 0),
    }]));
  // Payload byte estimates include volatile event fields (for example elapsed
  // durations). Keep those useful measurements visible without treating their
  // normal run-to-run variation as a changed workload.
  const stableCounterDifferences = Object.keys(counterDifferences)
    .filter((name) => !name.endsWith('.payload_estimated_bytes'));
  return {
    id: result.id,
    baselineP50Ms: prior.wallClock.p50Ms,
    currentP50Ms: result.wallClock.p50Ms,
    p50ChangePercent: prior.wallClock.p50Ms === 0 ? null : ((result.wallClock.p50Ms / prior.wallClock.p50Ms) - 1) * 100,
    baselineP95Ms: prior.wallClock.p95Ms,
    currentP95Ms: result.wallClock.p95Ms,
    p95ChangePercent: prior.wallClock.p95Ms === 0 ? null : ((result.wallClock.p95Ms / prior.wallClock.p95Ms) - 1) * 100,
    stableCountersMatch: stableCounterDifferences.length === 0,
    counterDifferences,
  };
});
const comparison = {
  schemaVersion: 1,
  kind: 'agent-core-engine-comparison',
  baseline: { commit: baseline.source.commit, createdAt: baseline.createdAt },
  current: { commit: current.source.commit, createdAt: current.createdAt },
  comparisons,
  ratchet: 'informational-only; no budgets have been approved',
};
const output = outputArg ? resolve(outputArg) : null;
if (output) await writeFile(output, `${JSON.stringify(comparison, null, 2)}\n`);
for (const row of comparisons) {
  const delta = row.p50ChangePercent == null ? 'n/a' : `${row.p50ChangePercent >= 0 ? '+' : ''}${row.p50ChangePercent.toFixed(1)}%`;
  const byteDeltas = Object.entries(row.counterDifferences)
    .filter(([name]) => name.endsWith('.payload_estimated_bytes'))
    .map(([name, values]) => `${name} ${values.delta >= 0 ? '+' : ''}${values.delta}B`);
  console.log(`${row.id}: p50 ${row.baselineP50Ms.toFixed(3)} -> ${row.currentP50Ms.toFixed(3)} ms (${delta}); stable counters ${row.stableCountersMatch ? 'match' : 'DIFFER'}${byteDeltas.length ? `; ${byteDeltas.join(', ')}` : ''}`);
}
if (output) console.log(`Comparison report: ${output}`);
