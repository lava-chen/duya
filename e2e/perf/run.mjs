#!/usr/bin/env node
/**
 * e2e/perf/run.mjs — the Duya Desktop performance harness.
 *
 * ONE COMMAND, REAL ELECTRON, PRODUCTION BUILD
 *
 *   node e2e/perf/run.mjs
 *
 * The harness launches the real Electron app from `dist-electron/main.js`
 * with the production renderer in `dist/` (preview mode, so no dev server
 * and no port), drives the six core journeys, and writes a machine-readable
 * JSON report plus a human-readable markdown summary.
 *
 * It is deliberately NOT a Playwright test: a test asserts, a benchmark
 * observes. There are no thresholds here and no "fail if slower than X" —
 * the report presents numbers, their spread across samples, and which of
 * them are quiet enough to become CI regression gates later.
 *
 * OPTIONS
 *
 *   --scenarios a,b,c   only these scenarios (default: all)
 *   --samples N         samples per scenario / per fixture (default: 3)
 *   --out <dir>         where the report is written
 *                       (default: docs-local/research/perf-harness)
 *   --lock-script <p>   the shared measurement lock script
 *   --lock-wait-min N   how long to wait for the lock (default: 30)
 *   --no-lock           do not take the lock (the report will say so)
 *   --lock-mode MODE    strict (skip a scenario whose lock cannot be taken) or
 *                       best-effort (measure anyway and flag it in the report)
 *   --agent <name>      the name the lock is taken under
 *   --panels N          how many panels the panel scenario opens (default 3)
 *
 * The measurement lock matters: five agents benchmark this machine at the
 * same time, and a CPU number taken while another agent is measuring is a
 * measurement of contention. Every run takes the lock unless `--no-lock` is
 * passed, and the report records whether it was held.
 */
import * as path from 'node:path';
import { REPO_ROOT, assertProductionBuild } from './lib/launch.mjs';
import { captureAppEnvironment, captureHostEnvironment, captureRepositoryState } from './lib/env.mjs';
import { buildReport, writeReport } from './lib/report.mjs';
import { withMeasurementLock } from './lib/lock.mjs';

import startupScenario from './scenarios/startup.mjs';
import sessionSwitchScenario from './scenarios/session-switch.mjs';
import streamScenario from './scenarios/stream.mjs';
import typingScenario from './scenarios/typing.mjs';
import panelsScenario from './scenarios/panels.mjs';
import gpuScenario from './scenarios/gpu.mjs';

const SCENARIOS = [
  startupScenario,
  sessionSwitchScenario,
  streamScenario,
  typingScenario,
  panelsScenario,
  gpuScenario,
];

function parseArgs(argv) {
  const options = {
    scenarios: null,
    samples: 3,
    out: path.join(REPO_ROOT, 'docs-local', 'research', 'perf-harness'),
    lockScript: null,
    lockWaitMin: 30,
    useLock: true,
    lockMode: 'strict',
    agent: 'agentA-harness',
    panels: 3,
    baseline: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--scenarios') options.scenarios = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--samples') options.samples = Number.parseInt(next(), 10);
    else if (arg === '--out') options.out = path.resolve(REPO_ROOT, next());
    else if (arg === '--lock-script') options.lockScript = path.resolve(REPO_ROOT, next());
    else if (arg === '--lock-wait-min') options.lockWaitMin = Number.parseInt(next(), 10);
    else if (arg === '--no-lock') options.useLock = false;
    else if (arg === '--lock-mode') options.lockMode = next();
    else if (arg === '--agent') options.agent = next();
    else if (arg === '--panels') options.panels = Number.parseInt(next(), 10);
    else if (arg === '--baseline') options.baseline = path.resolve(REPO_ROOT, next());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.samples) || options.samples < 1) {
    throw new Error('--samples must be a positive integer');
  }
  return options;
}

function usage() {
  process.stdout.write(
    [
      'Duya Desktop performance harness',
      '',
      '  node e2e/perf/run.mjs [--scenarios a,b] [--samples N] [--out DIR]',
      '                           [--lock-script PATH] [--lock-wait-min N]',
      '                           [--no-lock] [--lock-mode MODE] [--agent NAME] [--panels N]',
      '',
      `scenarios: ${SCENARIOS.map((scenario) => scenario.id).join(', ')}`,
      '',
    ].join('\n'),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const build = assertProductionBuild();
  const selected = options.scenarios
    ? SCENARIOS.filter((scenario) => options.scenarios.includes(scenario.id))
    : SCENARIOS;
  if (selected.length === 0) {
    throw new Error(`no scenario matched ${JSON.stringify(options.scenarios)}`);
  }

  const startedAt = new Date().toISOString();
  const runId = `${Date.now().toString(36)}`;
  const results = [];

  const ctx = {
    options,
    runId,
    launchMark: Date.now(),
    log: (message) => process.stdout.write(`[perf] ${message}\n`),
  };

  const environment = {
    ...captureHostEnvironment(),
    ...captureRepositoryState(),
    buildType: 'production',
    rendererUrl: build.rendererUrl,
    mainEntry: build.mainEntry,
    electronVersion: null,
    chromiumVersion: null,
  };

  /**
   * One scenario at a time under the lock.
   *
   * The lock is taken PER SCENARIO rather than for the whole run: five
   * agents share this machine, and a 40-minute hold would starve the others
   * while a per-scenario hold of a few minutes lets the team rotate. Every
   * number in a scenario is still taken uncontended.
   */
  const runMeasurements = async () => {
    for (const scenario of selected) {
      process.stdout.write(`\n[perf] === ${scenario.id} ===\n`);
      const scenarioStartedAt = Date.now();
      let outcome;
      try {
        outcome = await withMeasurementLock(
          async () => {
            // The app-level environment is read from a short-lived launch,
            // inside the lock: a launch is CPU work.
            if (!environment.electronVersion) {
              const appEnvironment = await captureAppEnvironmentQuietly();
              environment.electronVersion = appEnvironment.versions?.electron ?? null;
              environment.chromiumVersion = appEnvironment.versions?.chrome ?? null;
              environment.electronPlatform = appEnvironment.versions?.platform ?? null;
            }
            return scenario.run(ctx);
          },
          {
            lockScript: options.lockScript,
            agent: options.agent,
            waitMs: options.lockWaitMin * 60_000,
            required: options.lockMode === 'strict',
          },
        );
      } catch (error) {
        // Strict mode: the lock could not be taken within the budget, so the
        // scenario was NOT measured. A number taken while another agent
        // measures this machine is a measurement of contention, and a report
        // that says so is worth more than a contaminated one.
        const reason = String(error?.message ?? error);
        process.stderr.write(`[perf] scenario ${scenario.id} skipped: ${reason}\n`);
        results.push({
          scenario: scenario.id,
          title: scenario.title,
          fixture: scenario.fixture ?? null,
          fixtureDigest: null,
          status: 'skipped',
          samples: [],
          notes: {},
          error: reason,
          durationMs: Date.now() - scenarioStartedAt,
        });
        continue;
      }

      const scenarioResult = outcome.value;
      if (scenarioResult?.failed) {
        const message = String(
          scenarioResult.failed?.stack ?? scenarioResult.failed?.message ?? scenarioResult.failed,
        );
        process.stderr.write(`[perf] scenario ${scenario.id} failed: ${message}\n`);
        results.push({
          scenario: scenario.id,
          title: scenario.title,
          fixture: scenario.fixture ?? null,
          fixtureDigest: null,
          status: 'failed',
          samples: [],
          notes: {},
          error: message,
          durationMs: Date.now() - scenarioStartedAt,
        });
        continue;
      }

      results.push({
        scenario: scenario.id,
        title: scenario.title,
        fixture: scenarioResult.notes?.fixture ?? scenario.fixture ?? null,
        fixtureDigest: scenarioResult.notes?.fixtureDigest ?? null,
        status: 'ok',
        lockHeld: outcome.lock.held,
        samples: scenarioResult.samples ?? [],
        notes: {
          ...(scenarioResult.notes ?? {}),
          ...(outcome.lock.held
            ? {}
            : { lockWarning: `measured WITHOUT the measurement lock: ${outcome.lock.reason}` }),
        },
        durationMs: Date.now() - scenarioStartedAt,
      });
    }
    return results;
  };
  let lock;
  if (options.useLock) {
    // The lock is taken per scenario inside `runMeasurements`; this block
    // only records the mode for the report.
    await runMeasurements();
    const skipped = results.filter((result) => result.status === 'skipped');
    lock = {
      enabled: true,
      held: skipped.length === 0,
      mode: 'per-scenario',
      agent: options.agent,
      skippedScenarios: skipped.map((result) => result.scenario),
    };
  } else {
    lock = { enabled: false, held: false, mode: 'off', reason: '--no-lock was passed' };
    await runMeasurements();
  }

  // The app-level environment was read inside the lock, before the
  // scenarios ran.
  const report = buildReport({
    results,
    environment,
    startedAt,
    durationMs: Date.now() - Date.parse(startedAt),
    samplesPerScenario: options.samples,
    lock,
    harnessVersion: '1.0.0',
    notes: {
      command: `node e2e/perf/run.mjs ${process.argv.slice(2).join(' ')}`.trim(),
      thresholdPolicy:
        'no hard thresholds: the report presents numbers, their spread across samples, '
        + 'and the noise level of each metric',
      fixtureIds: [
        'perf/session-100',
        'perf/session-1000',
        'perf/session-10000',
        'perf/stream-long-reply',
        'perf/stream-tool-storm',
        'perf/typing-30s',
      ],
    },
  });

  const basename = `perf-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const { jsonPath, mdPath } = await writeReport({
    dir: options.out,
    basename,
    report,
  });

  process.stdout.write(`\n[perf] report: ${jsonPath}\n[perf] summary: ${mdPath}\n`);
  for (const result of report.results) {
    process.stdout.write(
      `[perf]   ${result.scenario}: ${result.status} (${(result.samples ?? []).length} samples)\n`,
    );
  }
  const failed = report.results.filter((result) => result.status !== 'ok');
  if (failed.length > 0) process.exitCode = 1;
}

async function captureAppEnvironmentQuietly() {
  try {
    const { launchPerfElectron, closePerfElectron } = await import('./lib/launch.mjs');
    const launched = await launchPerfElectron({ namespace: 'perf-env-probe' });
    const environment = await captureAppEnvironment(launched.app);
    await closePerfElectron(launched.app);
    return environment;
  } catch (error) {
    return { versions: null, gpu: null, error: String(error?.message ?? error) };
  }
}

main().catch((error) => {
  process.stderr.write(`[perf] ${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
