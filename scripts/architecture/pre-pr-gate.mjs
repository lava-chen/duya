#!/usr/bin/env node
/**
 * pre-pr-gate.mjs — run the CI architecture job locally, in one command.
 *
 * ## Why this file exists
 *
 * The seven open PRs reviewed on 2026-11-04 were each green locally and three
 * were red in CI. None of the three failures needed CI to find them:
 *
 *   - `bundle:verify` STALE (two PRs edited worker inputs without rebuilding
 *     the checked-in bundle, so the fix was not even in the shipped worker),
 *   - `agent-retirement-gate` growth (three RECORDED_LOSSES literals tripped a
 *     text-based reference ratchet),
 *   - a census test that `vitest --changed` never selects on a PR, so it only
 *     goes red once the branches are integrated.
 *
 * Every one of those is a step in `.github/workflows/test.yml`'s architecture
 * job, and every one is a pure local static check. The information existed;
 * there was just no single local command that produced it. This runner is that
 * command. It deliberately CONTINUES past a failure: one run shows every red
 * gate instead of the first one, which is the difference between one CI round
 * trip and four.
 *
 * ## Why the step list is asserted against the workflow
 *
 * A checklist that drifts from CI is worse than no checklist: it gives a green
 * answer for a red PR. `pre-pr-gate.test.ts` parses the workflow and requires
 * two-way parity between its `npm run` commands and `STEPS` below. Adding a
 * gate to CI without adding it here (or vice versa) fails a test.
 *
 * ## What it does NOT cover
 *
 * The `typecheck` and `test` jobs are separate CI jobs: minutes, not seconds,
 * and platform-sensitive. `--full` adds them. The default run prints the
 * reminder rather than pretending the architecture job is the whole build.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NODE = 'node';
const NPM = 'npm';

/**
 * The architecture job, in CI order. Order matters: A1's headless probe needs
 * the Host build that precedes it, and the two scan guards belong after their
 * gates. `heavy` steps are the ones `--quick` skips.
 */
export const STEPS = [
  { name: 'Baseline ratchet', argv: [NPM, 'run', 'architecture:baseline-ratchet', '--', '{BASE_SHA}'] },
  { name: 'Architecture boundary check', argv: [NPM, 'run', 'architecture:check'] },
  {
    name: 'Guard: architecture:check scanned something',
    argv: [NODE, 'scripts/architecture/architecture-check.mjs', '--json'],
    // `--json` exits 1 when it FOUND blocking violations. That is the real
    // gate's business (the step above is already red); here the only question
    // is whether it looked at anything.
    allowStatus: [0, 1],
    validate: (result) => {
      try {
        const report = JSON.parse(result.stdout);
        return (report.total ?? 0) > 0 ? null : `blind scan: total=${report.total ?? 0}`;
      } catch {
        return '--json produced no report';
      }
    },
  },
  { name: 'Slice graph and audit-imports parity', argv: [NPM, 'run', 'architecture:slice-graph'] },
  { name: 'Agent retirement reference ratchet', argv: [NPM, 'run', 'agent-retirement-gate'] },
  { name: 'Architecture plan-600 boundary gates', argv: [NPM, 'run', 'architecture:boundaries'] },
  { name: 'Architecture resolver self-test', argv: [NPM, 'run', 'architecture:self-test'] },
  { name: 'Browser entry closure (G10)', argv: [NPM, 'run', 'architecture:browser-closure'] },
  {
    name: 'Build Host dependency closure for A1',
    argv: [NODE, 'scripts/build-packages.mjs', '--target', '@duya/host'],
    heavy: true,
  },
  { name: 'Headless load of the cli handler layer (A1)', argv: [NPM, 'run', 'architecture:headless'], heavy: true },
  { name: 'Client entry closure (G11-1)', argv: [NPM, 'run', 'architecture:client-closure'] },
  { name: 'Bot boundary gate', argv: [NPM, 'run', 'architecture:bot-boundary'] },
  { name: 'Worker module-level state ratchet', argv: [NPM, 'run', 'architecture:worker-module-state'] },
  { name: 'Worker bundle freshness (bundle:verify)', argv: [NPM, 'run', 'bundle:verify'] },
  { name: 'Plan tracking table matches the tree (T02)', argv: [NPM, 'run', 'plan:sync'] },
  { name: 'Rule files reference paths that still exist', argv: [NPM, 'run', 'test:rules'] },
  { name: 'Guard: G10 must have scanned something', argv: [NODE, 'scripts/architecture/gate-scan-guard.mjs', 'g10'], heavy: true },
  { name: 'Guard: A1 must have scanned something', argv: [NODE, 'scripts/architecture/gate-scan-guard.mjs', 'a1'], heavy: true },
];

/** The two CI jobs that are minutes, not seconds. Opt in with `--full`. */
export const FULL_SUITES = [
  { name: 'typecheck:all', argv: [NPM, 'run', 'typecheck:all'] },
  { name: 'full vitest suite', argv: [NODE, 'node_modules/vitest/vitest.mjs', 'run'] },
];

/** npm scripts named by a step list (used by the parity test). */
export function npmScripts(steps) {
  return steps
    .filter((step) => step.argv[0] === NPM && step.argv[1] === 'run')
    .map((step) => step.argv[2]);
}

/**
 * Two-way parity between CI's architecture job and the local checklist.
 *
 * Pure and exported so the test can feed it a deliberately truncated CI list:
 * a parity checker that only verifies one direction is the mutation that lets
 * a brand-new CI gate go unrunnable locally.
 */
export function ciParity(ciScripts, steps = STEPS) {
  const local = new Set(npmScripts(steps));
  const ci = new Set(ciScripts);
  return {
    missingLocally: [...ci].filter((script) => !local.has(script)).sort(),
    missingInCi: [...local].filter((script) => !ci.has(script)).sort(),
  };
}

/** The point where this branch left master; the ratchet's comparison base. */
export function baseSha() {
  for (const ref of ['master', 'origin/master']) {
    try {
      const sha = execFileSync('git', ['merge-base', 'HEAD', ref], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (sha !== '') return sha;
    } catch {
      // No such ref on this clone; try the next one.
    }
  }
  return 'HEAD';
}

function commandFor(argv) {
  const [program, ...args] = argv;
  const resolved = program === NPM
    ? (process.platform === 'win32' ? 'npm.cmd' : 'npm')
    : program === NODE ? process.execPath : program;
  return { command: resolved, args };
}

function runStep(step, { verbose }) {
  const sha = step.argv.includes('{BASE_SHA}') ? baseSha() : null;
  const argv = sha === null ? step.argv : step.argv.map((arg) => arg.replace('{BASE_SHA}', sha));
  const { command, args } = commandFor(argv);
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const allowed = step.allowStatus ?? [0];
  let problem = result.error?.message ?? null;
  if (problem === null && !allowed.includes(result.status)) {
    problem = `exit ${result.status}`;
  }
  if (problem === null && step.validate !== undefined) {
    problem = step.validate(result);
  }
  return {
    name: step.name,
    ok: problem === null,
    problem,
    output,
    seconds: ((Date.now() - started) / 1000).toFixed(1),
    command: [command, ...args].join(' '),
  };
}

function main(argv) {
  const quick = argv.includes('--quick');
  const full = argv.includes('--full');
  const verbose = argv.includes('--verbose');
  const selected = [
    ...STEPS.filter((step) => !quick || !step.heavy),
    ...(full ? FULL_SUITES : []),
  ];
  if (argv.includes('--list')) {
    for (const step of selected) process.stdout.write(`  ${step.name}\n`);
    return;
  }

  const sha = baseSha();
  process.stdout.write(`pre-PR gate: ${selected.length} steps, base ${sha}${quick ? ' (quick)' : ''}${full ? ' (+ full suites)' : ''}\n\n`);
  const results = [];
  for (const step of selected) {
    const result = runStep(step, { verbose });
    results.push(result);
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name} (${result.seconds}s)\n`);
    if (verbose && result.output.trim() !== '') process.stdout.write(`${result.output}\n`);
    if (!result.ok) {
      const lines = result.output.trim().split('\n');
      for (const line of lines.slice(-25)) process.stderr.write(`      ${line}\n`);
      process.stderr.write(`      -> ${result.problem}\n      $ ${result.command}\n`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  process.stdout.write(`\npre-PR gate: ${passed}/${results.length} passed in ${quick ? 'quick' : 'CI architecture'} scope\n`);
  if (!full) {
    process.stdout.write('Not covered (separate CI jobs): npm run typecheck:all, full vitest suite. Use --full to include them.\n');
  }
  if (passed !== results.length) {
    process.stderr.write('\nFix the failures above before opening a PR. `--verbose` prints every step\'s output.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
