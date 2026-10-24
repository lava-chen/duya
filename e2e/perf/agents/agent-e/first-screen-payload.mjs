#!/usr/bin/env node
/**
 * Agent E — first-screen JS payload accounting for the shared renderer.
 *
 * Answers: "how many bytes of JavaScript does the renderer have to download
 * and evaluate before the first screen can paint, and how many chunks is that
 * spread over?"
 *
 * The computation lives in `e2e/perf/lib/first-screen.mjs` because the CI
 * budget gate (`scripts/perf/first-screen-budget.mjs`) must measure exactly
 * the same thing: a measurement with two implementations is a measurement
 * with two numbers.
 *
 * Usage:
 *   node e2e/perf/agents/agent-e/first-screen-payload.mjs [--dist dist] [--json]
 *   node e2e/perf/agents/agent-e/first-screen-payload.mjs --chunk-dump chunks.json
 *
 * `--chunk-dump` points at a Rollup chunk-graph dump (see the note on the
 * dump in the library). It is optional: without it the graph is derived from
 * the emitted chunks, and the two agree on the first-screen closure.
 *
 * No packages/ import: this file lives under e2e/ and must stay free of
 * product dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeFirstScreenPayload, readChunkDump } from '../../lib/first-screen.mjs';

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(name);
}
function option(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const distDir = path.resolve(repoRoot, option('--dist', 'dist'));
const assetsDir = path.join(distDir, 'assets');

if (!fs.existsSync(assetsDir)) {
  console.error(`[agent-e] no assets dir at ${assetsDir} — run a production build first`);
  process.exit(2);
}

const chunkDump = readChunkDump(option('--chunk-dump', null));
const report = computeFirstScreenPayload({ distDir, chunkDump, repoRoot });

if (flag('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[agent-e] dist=${report.dist} entry=${report.entry}`);
  console.log(`[agent-e] FIRST-SCREEN JS: ${report.firstScreen.kb} KB in ${report.firstScreen.chunkCount} chunks`);
  console.log(`[agent-e] TOTAL JS       : ${report.totalJs.kb} KB in ${report.totalJs.chunkCount} chunks`);
  console.log(`[agent-e] LAZY-ONLY JS   : ${Math.round((report.lazyOnlyChunks.bytes / 1024) * 10) / 10} KB in ${report.lazyOnlyChunks.chunkCount} chunks`);
  console.log('[agent-e] first-screen chunks:');
  for (const c of report.chunks) console.log(`  ${String(c.kb).padStart(8)} KB  ${c.chunk}`);
  if (report.thirdPartyPackages.length) {
    console.log('[agent-e] third-party packages in the first screen (module count):');
    for (const [pkg, n] of report.thirdPartyPackages.slice(0, 20)) console.log(`  ${String(n).padStart(5)}  ${pkg}`);
  }
  if (report.firstPartyAreas.length) {
    console.log('[agent-e] first-party areas in the first screen (module count):');
    for (const [area, n] of report.firstPartyAreas.slice(0, 20)) console.log(`  ${String(n).padStart(5)}  ${area}`);
  }
}
