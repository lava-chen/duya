#!/usr/bin/env node
/**
 * scripts/perf/run.mjs — the short way into the performance harness.
 *
 * The harness itself lives in `e2e/perf/` (the shared public facility of
 * this sprint: runner, collector, fixture generator). This file only exists
 * so the command is short and stable:
 *
 *   node scripts/perf/run.mjs --samples 3
 *
 * It adds no behaviour and no npm-script dependency: the root
 * `package.json` is a shared file that the integrator owns.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.resolve(here, '..', '..', 'e2e', 'perf', 'run.mjs');

const result = spawnSync(process.execPath, [runner, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
