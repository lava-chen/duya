/**
 * evals/agent/runner/run-eval.ts — the process entry point.
 *
 * A plain module, deliberately NOT a test file. `scripts/eval-agent.mjs` runs it
 * through `vite-node`, which gives the eval tree the same transform, aliases and
 * better-sqlite3 ABI handling the rest of the suite gets — without making every
 * `npm test` fork three real worker processes, and without a test file whose
 * result is really a process exit code.
 *
 * The report's exit code IS this process's exit code. That is the whole point of
 * having the policy in `./suite.ts` rather than in a test assertion: 0/1/2/3 is
 * a contract a caller can branch on, and `skipped` can never be collapsed into
 * 0 by anything on the way out.
 */

import { writeSync } from 'node:fs';
import { EXTENDED_SUITE, FIXED_SUITE, formatReport, runSuite, type SuiteSpec } from './run-suite';

/** The small, fixed, high-value set, by id. */
export const FIXED_CASE_IDS = [
  'structure-text-only',
  'task-artefact-write-file',
  'safety-manifest-refused',
] as const;

function suiteFor(mode: string): SuiteSpec {
  return mode === 'extended'
    ? EXTENDED_SUITE
    : { ...FIXED_SUITE, caseIds: FIXED_CASE_IDS };
}

async function main(): Promise<void> {
  const mode = process.env['DUYA_EVAL_MODE'] === 'extended' ? 'extended' : 'smoke';
  const outFile = process.env['DUYA_EVAL_OUT'];
  const report = await runSuite({ suite: suiteFor(mode), env: process.env, outFile });

  // Written with `writeSync` to fd 1 and then exited explicitly, rather than
  // assigning `process.exitCode` and waiting for the event loop to drain.
  //
  // The event loop does not drain here. The harness leaves real resources behind
  // — a better-sqlite3 handle held by the injected store singleton, child
  // process stdio pipes, timers the run layer started — so a run that had
  // finished its work and written its report sat there forever, and the CLI never
  // returned an exit code at all. A report that is written but never returned is
  // indistinguishable from a hang to whatever scheduled it, so the exit is
  // forced once the bytes are on disk. `writeSync` is what makes that safe: a
  // `process.exit` after an async `stdout.write` truncates the report.
  const text = `${formatReport(report)}\n${outFile === undefined ? '' : `\nreport written to ${outFile}\n`}`;
  writeSync(1, text);
  process.exit(report.exit.code);
}

await main();
