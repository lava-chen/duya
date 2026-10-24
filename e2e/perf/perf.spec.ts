/**
 * e2e/perf/perf.spec.ts — the Playwright-native entry to the harness.
 *
 * The harness itself is a plain Node script (`e2e/perf/run.mjs`): a
 * benchmark observes, a test asserts. This spec exists so the harness can
 * be driven from the Playwright runner — for CI, or for an agent that
 * already works in that world:
 *
 *   npx playwright test --config=e2e/perf/playwright.config.ts
 *
 * It runs one sample per scenario and asserts only that a report was
 * produced and that it carries the metric contract's fields. It asserts NO
 * performance threshold: nothing in this harness is calibrated well enough
 * for a hard gate, and a threshold that is not calibrated is a lie that
 * blocks merges.
 */
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const RUNNER = path.join(HERE, 'run.mjs');

test('the harness produces a report with the metric contract fields', () => {
  test.setTimeout(60 * 60 * 1000);
  const outDir = path.join(REPO_ROOT, 'docs-local', 'research', 'perf-harness', 'playwright');
  fs.mkdirSync(outDir, { recursive: true });

  const result = spawnSync(
    process.execPath,
    [RUNNER, '--samples', '1', '--out', outDir],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 55 * 60 * 1000 },
  );
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');

  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  const jsonFile = files.filter((name) => name.endsWith('.json')).sort().pop();
  expect(jsonFile, 'the harness wrote no JSON report').toBeTruthy();

  const report = JSON.parse(fs.readFileSync(path.join(outDir, jsonFile!), 'utf8'));
  expect(report.schemaVersion).toBe(1);
  expect(report.environment.buildType).toBe('production');
  expect(report.environment.cpuModel).toBeTruthy();
  expect(report.run.scenarios.length).toBeGreaterThan(0);

  const scenarioIds = report.run.scenarios.map((scenario: { scenario: string }) => scenario.scenario);
  for (const expected of ['startup', 'session-switch', 'stream', 'typing', 'panels', 'gpu']) {
    expect(scenarioIds, `scenario ${expected} is missing`).toContain(expected);
  }
});
