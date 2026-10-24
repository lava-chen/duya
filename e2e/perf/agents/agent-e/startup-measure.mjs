#!/usr/bin/env node
/**
 * Agent E — `startup.typeable_ms` for the shared renderer, measured with the
 * SHARED harness.
 *
 * WHY THIS FILE EXISTS
 *
 * The shared harness (`e2e/perf/run.mjs`) already owns the startup scenario:
 * it launches the real Electron app in preview mode against the production
 * bundle in `dist/`, prepares a warm profile through the product's own IPC,
 * and reports `startup.typeable_ms` from the OS process start time. Agent E
 * needs the same number for a before/after comparison of a renderer change,
 * with two additions the shared runner does not offer:
 *
 *   1. The BUILD happens inside the same lock as the measurement. A build
 *      that races another agent's measurement produces a number that belongs
 *      to neither build.
 *   2. The result is written next to the build artifacts, so a comparison
 *      has the bytes and the timings side by side.
 *
 * The scenario itself is NOT reimplemented: it is imported from
 * `e2e/perf/scenarios/startup.mjs`, so the metric definitions, the warm
 * profile preparation and the fixture are the shared ones.
 *
 * USAGE
 *
 *   node e2e/perf/agents/agent-e/startup-measure.mjs --samples 5 --label after
 *   node e2e/perf/agents/agent-e/startup-measure.mjs --samples 5 --label before --build
 *
 * OPTIONS
 *
 *   --samples N    samples per run (default 5)
 *   --label NAME   a name for this run, used in the output file name
 *   --build        rebuild everything before measuring (packages -> electron -> renderer)
 *   --build=renderer   rebuild only the renderer bundle before measuring
 *   --out DIR      where the report is written (default docs-local/research/perf-agent-e)
 *   --lock-wait-ms N   how long to wait for the shared lock (default 600000)
 *
 * The lock is the shared one (`e2e/perf/lib/lock.mjs`), so this run excludes
 * the other agents' runs and is excluded by theirs.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withMeasurementLock } from '../../lib/lock.mjs';
import { REPO_ROOT, assertProductionBuild } from '../../lib/launch.mjs';
import { captureHostEnvironment, captureRepositoryState } from '../../lib/env.mjs';
import { summarize, stability } from '../../lib/metrics.mjs';
import startupScenario from '../../scenarios/startup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    samples: 5,
    label: 'run',
    build: 'none',
    lockWaitMs: 600_000,
    bestEffort: false,
    out: path.join(REPO_ROOT, 'docs-local', 'research', 'perf-agent-e'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--samples') options.samples = Number.parseInt(next(), 10);
    else if (arg === '--label') options.label = next();
    else if (arg === '--out') options.out = path.resolve(REPO_ROOT, next());
    else if (arg === '--build') options.build = 'all';
    else if (arg === '--build=renderer') options.build = 'renderer';
    else if (arg === '--lock-wait-ms') options.lockWaitMs = Number.parseInt(next(), 10);
    else if (arg === '--best-effort') options.bestEffort = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.samples) || options.samples < 1) {
    throw new Error('--samples must be a positive integer');
  }
  return options;
}

function run(command, args) {
  process.stdout.write(`[agent-e] $ ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

/**
 * The production build of THIS checkout.
 *
 * `npm run build:packages` refreshes the workspace `dist/` folders the
 * renderer imports at build time (`@duya/ai`, `@duya/agent-protocol`, ...);
 * `scripts/build-electron.mjs` produces the main process bundle the
 * measurement launches; `vite build` produces the renderer bundle the
 * measurement loads over `file://`.
 *
 * `renderer` skips the first two: a renderer-only change does not move the
 * workspace packages or the main process, and rebuilding them would hold the
 * shared lock twice as long for the same measurement.
 */
function buildProductionBundle(mode) {
  if (mode === 'all') run('npm', ['run', 'build:packages']);
  if (mode === 'all') run('node', ['scripts/build-electron.mjs']);
  run('npx', ['vite', 'build']);
}

/** The first-screen JS accounting, straight from the emitted artifacts. */
function firstScreenPayload() {
  const result = spawnSync(
    process.execPath,
    [path.join(HERE, 'first-screen-payload.mjs'), '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    throw new Error(`first-screen-payload.mjs failed with exit code ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      [
        'node e2e/perf/agents/agent-e/startup-measure.mjs [--samples N] [--label NAME]',
        '                                          [--build|--build=renderer] [--out DIR]',
        '                                          [--lock-wait-ms N]',
        '',
      ].join('\n'),
    );
    return;
  }

  const runId = `${Date.now().toString(36)}-${options.label}`;
  const startedAt = new Date().toISOString();

  const outcome = await withMeasurementLock(
    async () => {
      if (options.build !== 'none') buildProductionBundle(options.build);
      const build = assertProductionBuild();

      const ctx = {
        options: { samples: options.samples },
        runId,
        launchMark: Date.now(),
        log: (message) => process.stdout.write(`[perf] ${message}\n`),
      };
      const scenarioResult = await startupScenario.run(ctx);
      const payload = firstScreenPayload();

      return {
        scenario: scenarioResult,
        payload,
        rendererUrl: build.rendererUrl,
      };
    },
    {
      agent: 'agentE-uiarch',
      waitMs: options.lockWaitMs,
      // Poll often: the shared lock is handed over between the other agents'
      // scenarios, and a short gap is only won by the agent that asks for it
      // most often.
      retryMs: 250,
      required: !options.bestEffort,
    },
  );

  const samples = outcome.value.scenario.samples ?? [];
  const metricNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.metrics ?? {})))];
  const metrics = {};
  for (const name of metricNames) {
    const values = samples.map((sample) => sample.metrics?.[name]);
    metrics[name] = {
      summary: summarize(values),
      stability: stability(values),
    };
  }

  const report = {
    label: options.label,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    lock: outcome.lock,
    environment: {
      ...captureHostEnvironment(),
      ...captureRepositoryState(),
      buildType: 'production',
      rendererUrl: outcome.value.rendererUrl,
    },
    firstScreen: outcome.value.payload,
    metrics,
    samples,
    notes: outcome.value.scenario.notes,
  };

  fs.mkdirSync(options.out, { recursive: true });
  const file = path.join(options.out, `startup-${options.label}-${options.samples}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));

  process.stdout.write(`\n[agent-e] report: ${file}\n`);
  for (const name of [
    'startup.typeable_ms',
    'startup.firstPaint_ms',
    'startup.warm.typeable_ms',
    'startup.warm.firstPaint_ms',
    'startup.reload.typeable_ms',
  ]) {
    const entry = metrics[name];
    if (!entry) continue;
    const s = entry.summary;
    process.stdout.write(
      `[agent-e] ${name}: n=${s.count} p50=${s.p50} mean=${s.mean} min=${s.min} max=${s.max} `
        + `spread=${s.spreadPct}% cv=${entry.stability.cv} (${entry.stability.level})\n`,
    );
  }
  const fs1 = outcome.value.payload.firstScreen;
  process.stdout.write(
    `[agent-e] first-screen JS: ${fs1.kb} KB in ${fs1.chunkCount} chunks `
      + `(entry ${outcome.value.payload.entryChunkBytes} bytes)\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[agent-e] ${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
