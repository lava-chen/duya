#!/usr/bin/env node
/**
 * test-summary-guard.mjs — report what `npm test` actually collected, and
 * refuse to turn "did not collect" into a verdict.
 *
 * ## Why this file exists
 *
 * Plan 610 T04 / gap G10. The `test` job in `.github/workflows/test.yml` has
 * been red on every single commit of master — run `39040547246` (master,
 * `a24b14eb`) and run `39044714745` (PR #275) carry the byte-identical line:
 *
 *     guard FAILED: could not read the vitest summary line.
 *     - test files collected: **UNKNOWN**
 *     - tests collected: **UNKNOWN**
 *
 * Both of those runs are the guard reporting on ITSELF, not on the suite. The
 * measured facts from the raw job logs (see `__fixtures__/`) are:
 *
 *   * `grep -c passed` over the whole ubuntu job log is **0**. Vitest's
 *     summary block always contains the word "passed", so there is no summary
 *     block at all in either log. There was never anything to match.
 *   * The real-ESC byte count is ~43000 and the literal `^[[` count is **0**.
 *     Vitest's colour codes reach the file as real ESC bytes; the "ESC was
 *     stripped by the writer, leaving `^[[`" story is not what the bytes say.
 *     Both spellings are still accepted below, because that is cheap and the
 *     claim is cheap to be wrong about — but it is not the cause of G10.
 *   * The run dies before the reporter prints: an **Unhandled Rejection**
 *     (`[vitest-pool]: Unexpected call to process.send()`, then
 *     `ERR_INVALID_ARG_TYPE` from `node_modules/vitest/dist/chunks/coverage.*.js`)
 *     kills the process, so the log ends mid file-list with
 *     `##[error]Process completed with exit code 1.` and no summary.
 *
 * The defect that made CI useless is therefore narrower and dumber than "the
 * regex is wrong": **a guard that cannot read its input reports that as a
 * failure**. That is the failure mode this file is built to remove. With 11
 * known-red tests on master, a `test` job that is red for an unrelated,
 * information-free reason cannot distinguish "known debt" from "a new
 * regression" — so the job's answer is unusable on every PR.
 *
 * ## The exit contract
 *
 * This guard answers ONE question: did the run collect any tests at all? It
 * is not a second verdict on whether the suite passed — `vitest`'s own exit
 * code already is that verdict, and the test step's `set -o pipefail`
 * pipeline propagates it. A guard that re-decided pass/fail would duplicate
 * it and, when it got the parsing wrong, would overrule the real signal.
 *
 *   verdict      meaning                                      exit
 *   ------------------------------------------------------------------
 *   `collected`  summary parsed, totals are non-zero             0
 *   `zero`       summary parsed, a total is 0 — nothing ran      1
 *   `unread`     no summary line in the log                     0  <-- was 1
 *   `no-log`     the log file does not exist                    1  <-- was 0
 *
 * `no-log` and `unread` look like the same thing — "the guard has no
 * numbers" — and they are deliberately NOT the same verdict, because they
 * answer different questions about different failures:
 *
 *   `unread`  the log EXISTS and this guard read all of it; the summary block
 *             simply is not in there. So the guard did its job and the input
 *             arrived damaged. Something IS on the record: the `Run tests`
 *             step's own exit code, plus whatever the log does contain. The
 *             guard stays neutral and lets that single record speak, because
 *             a second red here is the duplication that made G10 unreadable.
 *
 *   `no-log`  the log does not exist. Nothing ran, or `tee` never wrote where
 *             the guard looked. There is no record at all: not the totals, not
 *             the crash, not the test step's exit code as this guard can see
 *             it. Exiting 0 here converts a BROKEN WIRE into a green job,
 *             and a green job is exactly the thing a reviewer stops reading.
 *             Missing evidence is not neutral; it is the loudest thing the
 *             guard can say. See the `no-log` block in `run()`.
 *
 * `unread` is the whole point. "I could not read the summary" is a fact about
 * THIS GUARD, not about the suite, so it is reported as `UNKNOWN` in the step
 * summary and exits neutrally. The run's real outcome is already on the
 * record from the test step's exit code, and it stays there. The previous
 * behaviour did the opposite: it converted its own parse failure into a red
 * that looked, in the job list, exactly like a suite failure.
 *
 * `zero` is the case that genuinely IS a verdict. Vitest exits 0 when zero test
 * files match, and "files matched, tests ran: 0" is reachable (every file
 * skipped, or an include-glob change matching only empty files). That looks
 * identical to a healthy run from the outside, so it stays red.
 *
 * ## Why the parsing is written to survive, not to be clever
 *
 * The regexes are deliberately dumb and deliberately redundant:
 *
 *   * Both ANSI spellings are stripped — real `\x1b[22m` AND the literal
 *     `^[[22m` / `^[22m` caret forms some writers emit when they escape the
 *     ESC byte. Accepting a form that never occurs costs one alternation;
 *     rejecting one that does occur costs the entire job.
 *   * A leading GitHub Actions timestamp (`2026-10-17T14:31:15.4995888Z `) is
 *     stripped when present, so this guard can be pointed at a raw Actions
 *     job log as well as at the `tee`-written file. That is what makes the
 *     fixtures in `__fixtures__/` usable as byte-exact regression input.
 *   * The search takes the LAST parseable occurrence, not the first: this log
 *     is megabytes of test output and any line beginning with "Tests" would
 *     match first, while the real summary is the final block.
 *   * `latin1` + NUL-strip keeps the reader byte-exact for both tee (UTF-8)
 *     and PowerShell `Tee-Object` (UTF-16LE) writers.
 *
 * ## What a failure means
 *
 * Only `zero` and `no-log` fail, and they mean two different things.
 * `zero` means "the suite collected nothing", which is a real defect. `no-log`
 * means "there was no log to read", which is a broken pipeline. An `unread`
 * verdict means this guard did not get to form an opinion — read the
 * `##[error]Process completed with exit code 1.` line above it in the job log,
 * because that is where the answer is.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Strip ANSI colour sequences in both spellings.
 *
 * `\x1b[22m` is a real ESC byte (what vitest actually emits).
 * `^[[22m` and `^[22m` are the caret forms some writers substitute when they
 * escape the ESC byte instead of passing it through. Both are accepted: the
 * point of this guard is to report, and a guard that rejects a spelling it
 * has never seen reports nothing.
 */
const ANSI_SEQUENCE = /(?:\x1b\[|\^\[\[?)[0-9;?]*[A-Za-z]/g;

/** GitHub Actions prefixes every captured line with a UTC ISO-8601 stamp. */
const ACTIONS_TIMESTAMP = /^\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/;

/**
 * Read a captured log into comparable plain text.
 *
 * latin1 + NUL removal recovers the summary byte-exactly whether the writer
 * was `tee` (UTF-8) or PowerShell's `Tee-Object` (UTF-16LE, whose ASCII bytes
 * arrive NUL-interleaved).
 *
 * The Actions timestamp is dropped PER LINE, before any matching: it sits at
 * the start of the line, so a pattern anchored at `^` cannot cross it —
 * `[ \t]*` does not match a digit. Stripping it afterwards, inside the capture
 * group, silently never fires.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeLog(text) {
  return text
    .replace(/\u0000/g, '')
    .replace(ANSI_SEQUENCE, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(ACTIONS_TIMESTAMP, ''))
    .join('\n');
}

/**
 * Read the vitest summary totals out of a normalized log.
 *
 * @param {string} text already passed through {@link normalizeLog}
 * @returns {{ files: number | null, tests: number | null }}
 */
export function parseSummary(text) {
  const totalFor = (label) => {
    // `[ \t]` rather than `\s`: `\s` also matches `\n`, so `^\s*Tests\s+`
    // could start matching on a blank line above the real one and let the
    // capture drift onto whatever follows. Horizontal space only.
    const re = new RegExp(`^[ \\t]*${label}[ \\t]+(.*)$`, 'gm');
    const candidates = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const hit = m[1].match(/\((\d+)\)[ \t]*$/);
      if (hit) candidates.push(Number(hit[1]));
    }
    // Last parseable occurrence wins: the real summary is the final block.
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  };

  return {
    files: totalFor('Test Files'),
    tests: totalFor('Tests'),
  };
}

/**
 * Decide the guard's verdict from the parsed totals.
 *
 * @param {{ files: number | null, tests: number | null }} summary
 * @returns {{ verdict: 'collected' | 'zero' | 'unread', exitCode: number }}
 */
export function decide(summary) {
  const { files, tests } = summary;
  if (files === null || tests === null) return { verdict: 'unread', exitCode: 0 };
  if (files === 0 || tests === 0) return { verdict: 'zero', exitCode: 1 };
  return { verdict: 'collected', exitCode: 0 };
}

/**
 * Render the GitHub step summary block.
 *
 * @param {{ files: number | null, tests: number | null }} summary
 * @param {ReturnType<typeof decide>} decision
 * @returns {string}
 */
export function renderReport(summary, decision) {
  const show = (n) => (n === null ? 'UNKNOWN' : String(n));
  const lines = [
    '### npm test',
    '',
    `- test files collected: **${show(summary.files)}**`,
    `- tests collected: **${show(summary.tests)}**`,
  ];

  if (decision.verdict === 'unread') {
    lines.push(
      '',
      'The vitest summary block is not in the captured output, so these totals',
      'are UNKNOWN. That is a fact about this guard, not about the suite: the',
      'run\'s real outcome is the exit code of the `Run tests` step above, which',
      'is the verdict. A run that dies before printing its summary (today: an',
      'unhandled rejection inside the vitest pool) is the usual cause — read the',
      '`Process completed with exit code N` line in that step for the answer.',
    );
  } else if (decision.verdict === 'zero') {
    lines.push(
      '',
      '**Zero collection.** The suite ran no tests; that is a failure, not a pass.',
    );
  }

  return lines.join('\n');
}

/**
 * Run the guard against one log file.
 *
 * @param {string} logPath
 * @param {{ summaryPath?: string | null, stdout?: (text: string) => void,
 *           stderr?: (text: string) => void }} [io]
 * @returns {number} process exit code
 */
export function run(logPath, io = {}) {
  const out = io.stdout ?? ((text) => process.stdout.write(text));
  const err = io.stderr ?? ((text) => process.stderr.write(text));
  const append = io.appendFileSync ?? appendFileSync;

  if (!existsSync(logPath)) {
    // T04b: a missing log file is a WIRING failure, not an opinion this guard
    // declined to offer.
    //
    // The old exit code here was 0, chosen for symmetry with `unread`. That
    // symmetry was wrong: `unread` means "I read the input and it had no
    // summary", which leaves the run's real outcome on the record elsewhere.
    // `no-log` means "there is no input" — the test step never ran, or `tee`
    // wrote somewhere else, and this guard is now the ONLY thing standing
    // between a broken pipeline and a green checkmark.
    //
    // Exiting 0 there is the worst available answer: it is not neutral, it is
    // affirmative. It says "the suite collected tests" when this guard never
    // saw a single test. Note that this is strictly MORE information than the
    // `unread` case, not less: a run that crashed still leaves a log behind,
    // so `no-log` narrows the diagnosis down to the pipeline rather than the
    // suite.
    const message =
      'guard: no ' + path.basename(logPath) + ' — the test step never ran; ' +
      'its own failure is the signal.\n';
    out(message);
    err(
      '\nguard FAILED: ' + path.basename(logPath) + ' does not exist, so this ' +
      'guard collected nothing at all — not the totals, not the crash, not the ' +
      'test step exit code. This is broken wiring (the test step did not run, or ' +
      'tee wrote elsewhere), not a passing run. Fix the pipeline before reading ' +
      'anything into this job.\n',
    );
    return 1;
  }

  const summary = parseSummary(normalizeLog(readFileSync(logPath, 'latin1')));
  const decision = decide(summary);
  const report = renderReport(summary, decision);
  const summaryPath =
    'summaryPath' in io ? io.summaryPath : (process.env.GITHUB_STEP_SUMMARY ?? null);
  if (summaryPath) append(summaryPath, report + '\n');
  out(report + '\n');

  if (decision.verdict === 'zero') {
    err(
      `\nguard FAILED: collected ${summary.files} file(s) / ${summary.tests} test(s). ` +
      'A zero-collection run is a failed run, not a pass.\n',
    );
  }

  return decision.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(run(process.argv[2] ?? 'vitest-output.log'));
}
