#!/usr/bin/env node
// scripts/showcase/showcase.mjs
// Stage-1 entrypoint. Runs the 5 duya showcase scenarios and saves PNGs
// (plus an optional GIF) under assets/showcase/.
//
// Usage:
//   node scripts/showcase/showcase.mjs                  # all 5 scenarios
//   node scripts/showcase/showcase.mjs 01                # one scenario
//   node scripts/showcase/showcase.mjs --gif             # also compose GIF
//
// Stage 1 status:
//   - Scenario 01 (launcher) works end-to-end today.
//   - Scenarios 02..05 require a one-line addition to electron/main.ts
//     (DUYA_SHOWCASE_DRIVER eval) which the user will be asked to
//     authorize separately. Until then they fall back to capturing the
//     launcher state — same as scenario 01 — and label the PNG clearly.

import { captureOne } from './capture-electron.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'assets', 'showcase');

// Definition of the 5 showcase scenarios. Keep this aligned with
// docs/release-notes and README "What can Duya do?" sections.
const SCENARIOS = [
  {
    id: '01-launcher',
    title: 'App launcher / desktop workspace',
    selector: '[data-showcase-ready="true"]',
    waitMs: 2500,
    needsShowcaseMode: false,
  },
  {
    id: '02-research-browser',
    title: 'Research with a real browser',
    selector: '[data-tool-card-ready="browser.snapshot"]',
    waitMs: 6000,
    needsShowcaseMode: true,
  },
  {
    id: '03-files-edit',
    title: 'Local file edit with diff card',
    selector: '[data-tool-card-ready="edit.diff"]',
    waitMs: 6000,
    needsShowcaseMode: true,
  },
  {
    id: '04-canvas-conductor',
    title: 'Conductor canvas with smart layout',
    selector: '[data-conductor-ready="true"]',
    waitMs: 5000,
    needsShowcaseMode: true,
  },
  {
    id: '05-permission-prompt',
    title: 'Permission prompt before sensitive action',
    selector: '[data-permission-open="true"]',
    waitMs: 4000,
    needsShowcaseMode: true,
  },
];

function parseArgs(argv) {
  const out = { only: null, gif: false };
  for (const a of argv.slice(2)) {
    if (a === '--gif') out.gif = true;
    else if (a.startsWith('--')) continue;
    else out.only = a;
  }
  return out;
}

async function main() {
  const { only, gif } = parseArgs(process.argv);
  const wanted = only
    ? SCENARIOS.filter((s) => s.id === only)
    : SCENARIOS;

  if (wanted.length === 0) {
    console.error(`Unknown scenario: ${only}. Available: ${SCENARIOS.map((s) => s.id).join(', ')}`);
    process.exit(2);
  }

  console.log(`[showcase] output dir: ${OUT_DIR}`);
  const results = [];

  for (const sc of wanted) {
    process.stdout.write(`[showcase] ${sc.id} … `);
    try {
      const out = await captureOne({
        name: sc.id,
        readySelector: sc.selector,
        waitMs: sc.waitMs,
        env: sc.needsShowcaseMode ? { DUYA_SHOWCASE_MODE: '1' } : {},
      });
      console.log(`OK  ${path.relative(ROOT, out)}`);
      results.push({ id: sc.id, title: sc.title, path: out });
    } catch (e) {
      console.log(`FAIL ${e.message}`);
      results.push({ id: sc.id, title: sc.title, error: e.message });
    }
  }

  // Write a manifest describing what was produced.
  const manifest = {
    generatedAt: new Date().toISOString(),
    stage: 1,
    results,
    note:
      'Stage 1: only scenario 01 is fully wired. Scenarios 02..05 capture the ' +
      'launcher state until DUYA_SHOWCASE_DRIVER is wired into main.ts.',
  };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (gif) {
    const { composeGif } = await import('./compose-gif.mjs');
    await composeGif();
  }

  // Exit code reflects failures.
  const failed = results.filter((r) => r.error).length;
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[showcase] fatal:', e);
  process.exit(1);
});