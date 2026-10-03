#!/usr/bin/env node
// scripts/eval-agent.mjs — the explicit entry points for the agent evals.
//
// Why a script and not just `vitest`: the plan asks for CI to run a SMALL, FIXED
// set of high-value cases, and for the extended set to be run manually or on a
// schedule under the user's existing authorisation. That is two named commands
// with a report and an exit code, which `vitest` does not provide.
//
//   node scripts/eval-agent.mjs smoke      # the fixed set. exit 0 only if EVERY
//                                          # check passed, nothing unknown,
//                                          # nothing skipped. This is the one a
//                                          # CI job may run.
//   node scripts/eval-agent.mjs extended   # every case on disk. Reach gaps are
//                                          # reported as data; exit 2 means
//                                          # "not a pass", never "green".
//
// NO AUTOMATED TRIGGER IS ADDED HERE, and none should be. This script defines the
// commands and the data contract; whether and when they run is the user's call
// under the authorisation they already have.
//
// Exit codes (see evals/agent/evaluators/suite.ts):
//   0  all checks passed; nothing unknown, nothing skipped
//   1  at least one check failed
//   2  nothing failed, but something was unknown or skipped  <- NOT success
//   3  the suite could not run at all
//
// The suite runs through `vite-node` (a vitest dependency) rather than plain
// `node`, so the eval tree gets the same transform, aliases and better-sqlite3
// ABI handling as the rest of the suite. A second runner with its own resolution
// would be a second place for the SQLite ABI to go wrong — and that class of bug
// has already cost this repo real time.
//
// Usage:
//   node scripts/eval-agent.mjs <smoke|extended> [--out <file>] [--list]

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('--'));

if (args.includes('--list')) {
  const casesDir = path.join(repoRoot, 'evals', 'agent', 'cases');
  if (!existsSync(casesDir)) {
    process.stderr.write('eval-agent: no cases directory.\n');
    process.exit(3);
  }
  process.stdout.write(`${readdirSync(casesDir).filter((f) => f.endsWith('.json')).sort().join('\n')}\n`);
  process.exit(0);
}

if (mode !== 'smoke' && mode !== 'extended') {
  process.stderr.write(
    'eval-agent: pass "smoke" or "extended".\n'
    + '  smoke     the small fixed high-value set; exit 0 only when nothing was unknown or skipped\n'
    + '  extended  every case on disk; reach gaps are reported, not aggregated into success\n',
  );
  process.exit(3);
}

const outFlag = args.indexOf('--out');
const outFile = outFlag !== -1 && args[outFlag + 1] !== undefined
  ? path.resolve(repoRoot, args[outFlag + 1])
  : path.join(repoRoot, 'evals', 'agent', 'reports', `${mode}.json`);

if (!existsSync(path.join(repoRoot, 'packages', 'agent', 'bundle', 'agent-process-entry.js'))) {
  process.stderr.write(
    'eval-agent: the agent bundle is missing.\n'
    + 'The evals fork the SAME bundle the product forks; run `npm run bundle:agent` first.\n',
  );
  process.exit(3);
}

const viteNodeBin = path.join(repoRoot, 'node_modules', 'vite-node', 'vite-node.mjs');
if (!existsSync(viteNodeBin)) {
  process.stderr.write('eval-agent: vite-node is not installed. Run `npm install`.\n');
  process.exit(3);
}

const proc = spawnSync(
  process.execPath,
  [viteNodeBin, path.join(repoRoot, 'evals', 'agent', 'runner', 'run-eval.ts')],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, DUYA_EVAL_MODE: mode, DUYA_EVAL_OUT: outFile },
  },
);

if (proc.error) {
  process.stderr.write(`eval-agent: could not start the suite: ${proc.error.message}\n`);
  process.exit(3);
}

// A spawn that produced no report at all is "the suite could not run", which is
// 3 — never 0. Anything else passes the report's own code through untouched, so
// the 0/1/2/3 distinction a caller branches on survives this hop.
if (!existsSync(outFile)) {
  process.stderr.write('eval-agent: the suite produced no report.\n');
  process.exit(3);
}
try {
  const report = JSON.parse(readFileSync(outFile, 'utf8'));
  const code = report?.exit?.code;
  if (code === 0 || code === 1 || code === 2 || code === 3) {
    process.exit(code);
  }
  process.stderr.write(`eval-agent: the report carries an unusable exit code: ${JSON.stringify(report?.exit)}\n`);
  process.exit(3);
} catch (error) {
  process.stderr.write(`eval-agent: the report is unreadable: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(3);
}
