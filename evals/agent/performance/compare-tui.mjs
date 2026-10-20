import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [baselineArg, currentArg, outputArg] = process.argv.slice(2);
if (!baselineArg || !currentArg) {
  console.error('Usage: node evals/agent/performance/compare-tui.mjs <baseline.json> <current.json> [comparison.json]');
  process.exit(2);
}
const baseline = JSON.parse(await readFile(resolve(baselineArg), 'utf8'));
const current = JSON.parse(await readFile(resolve(currentArg), 'utf8'));
if (baseline.kind !== 'agent-tui-performance' || current.kind !== baseline.kind) {
  throw new Error('Both inputs must be Agent TUI performance reports');
}
if (baseline.schemaVersion !== current.schemaVersion) throw new Error('Report schema versions differ');
for (const key of ['node', 'platform', 'arch', 'renderer', 'columns', 'rows']) {
  if (baseline.environment[key] !== current.environment[key]) {
    throw new Error(`TUI environments differ at ${key}; refusing an apples-to-oranges comparison`);
  }
}
if (JSON.stringify(baseline.workload) !== JSON.stringify(current.workload)) {
  throw new Error('TUI workloads differ; refusing an apples-to-oranges comparison');
}

function percentChange(before, after) {
  return before === 0 ? null : ((after / before) - 1) * 100;
}
function metric(name, before, after) {
  return { name, baseline: before, current: after, changePercent: percentChange(before, after) };
}
const metrics = [
  metric('startup.paintedMs.p50', baseline.startup.paintedMs.p50, current.startup.paintedMs.p50),
  metric('startup.paintedMs.p95', baseline.startup.paintedMs.p95, current.startup.paintedMs.p95),
  metric('inputLatency.paintedP50', baseline.inputLatency.paintedP50, current.inputLatency.paintedP50),
  metric('inputLatency.paintedP95', baseline.inputLatency.paintedP95, current.inputLatency.paintedP95),
  metric('inputLatency.dispatchP95', baseline.inputLatency.dispatchP95, current.inputLatency.dispatchP95),
  metric('inputLatency.frameBytesP50', baseline.inputLatency.frameBytesP50, current.inputLatency.frameBytesP50),
  metric('streamFrames.p95GapMs', baseline.streamFrames.p95, current.streamFrames.p95),
  metric('streamFrames.frames', baseline.streamFrames.frames, current.streamFrames.frames),
  metric('streamFrames.coalescedDeltas', baseline.streamFrames.coalescedDeltas, current.streamFrames.coalescedDeltas),
  metric('streamFrames.outputBytes', baseline.streamFrames.outputBytes, current.streamFrames.outputBytes),
  metric('streamFrames.meanFrameBytes', baseline.streamFrames.meanFrameBytes, current.streamFrames.meanFrameBytes),
  metric('streamFrames.outputBytesPerSecond', baseline.streamFrames.outputBytesPerSecond, current.streamFrames.outputBytesPerSecond),
  metric('streamFrames.withinInterval', baseline.streamFrames.withinInterval, current.streamFrames.withinInterval),
  ...current.transcriptLayout.map((layout, index) => metric(
    `transcript.${layout.blocks}blocks.coldTotalLinesMs`,
    baseline.transcriptLayout[index]?.coldTotalLinesMs,
    layout.coldTotalLinesMs,
  )),
  ...current.transcriptLayout.map((layout, index) => metric(
    `transcript.${layout.blocks}blocks.warmTotalLinesMs`,
    baseline.transcriptLayout[index]?.warmTotalLinesMs,
    layout.warmTotalLinesMs,
  )),
];
const comparison = {
  schemaVersion: 1,
  kind: 'agent-tui-performance-comparison',
  baseline: { commit: baseline.source.commit, createdAt: baseline.createdAt },
  current: { commit: current.source.commit, createdAt: current.createdAt },
  workloadMatch: true,
  metrics,
  ratchet: 'informational-only; no budgets have been approved',
};
if (outputArg) await writeFile(resolve(outputArg), `${JSON.stringify(comparison, null, 2)}\n`);
for (const item of metrics) {
  const change = item.changePercent === null ? 'n/a' : `${item.changePercent >= 0 ? '+' : ''}${item.changePercent.toFixed(1)}%`;
  console.log(`${item.name}: ${Number(item.baseline).toFixed(3)} -> ${Number(item.current).toFixed(3)} (${change})`);
}
if (outputArg) console.log(`Comparison report: ${resolve(outputArg)}`);
