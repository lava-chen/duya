#!/usr/bin/env node
/**
 * test-fault-injection.mjs — measure whether a test suite can actually DETECT a
 * defect, by injecting a defect into production code and watching what happens.
 *
 * ## Why this exists
 *
 * A test that never fails is not a test. `expect()` counts, file lengths and
 * names are proxies; the only direct evidence of defect-detection power is a
 * defect that the suite misses. This tool injects one and reports the answer.
 *
 * It is a scoped, explicit version of mutation testing:
 *   - every mutation is a literal source edit listed in a spec file, so a
 *     reviewer can read exactly what defect was injected before believing the
 *     "survived" verdict;
 *   - only production sources are mutated (never the tests), so a surviving
 *     mutant means the suite did not notice, not that the suite was broken;
 *   - the source is restored from git after every mutation, so a crashed run
 *     cannot leave the tree mutated.
 *
 * ## The verdict vocabulary
 *
 *   killed    the suite went red -> the suite detected this defect
 *   survived  the suite stayed green -> the suite did NOT detect this defect
 *   errored   the run failed for a reason other than an assertion
 *             (collection error, crash) -> NOT evidence of detection
 *   skipped   the mutation did not apply (the `find` text was absent or
 *             ambiguous) -> not counted either way
 *
 * `errored` is deliberately NOT a kill. A suite that crashes on a mutated
 * source has not demonstrated that it checks anything.
 *
 * ## Usage
 *
 *   node scripts/test-fault-injection.mjs --spec <spec.json> [--out <report.json>]
 *
 * Spec format:
 *   {
 *     "cases": [
 *       {
 *         "name": "human readable label",
 *         "source": "packages/host/src/foo.ts",
 *         "tests": ["packages/host/tests/foo.test.ts"],
 *         "mutations": [
 *           { "id": "m1", "find": "exact text", "replace": "mutated text",
 *             "description": "what defect this simulates" }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Exit code: 0 when the run completed (whatever the verdicts were), 1 on a
 * harness error. A surviving mutant is a FINDING, not a harness failure.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const args = { spec: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--spec') args.spec = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Run vitest over `files` and classify the outcome.
 *
 * vitest is invoked through `node <vitest.mjs>` rather than `npx vitest`:
 * `npx` is a `.cmd` shim on Windows, and Node refuses to spawn one directly
 * (EINVAL), so the shim route fails on every Windows machine — which is the
 * machine this audit was run on.
 */
function runSuite(files) {
  const reportPath = resolve(tmpdir(), 'duya-fault-injection-result.json');
  const vitestBin = resolve(REPO_ROOT, 'node_modules/vitest/vitest.mjs');
  if (!existsSync(vitestBin)) {
    return { verdict: 'errored', detail: `vitest is not installed at ${vitestBin}` };
  }
  const args = [vitestBin, 'run', '--reporter=json', `--outputFile=${reportPath}`, ...files];
  let stdout = '';
  let failed = false;
  try {
    stdout = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    failed = true;
    stdout = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  }

  if (!existsSync(reportPath)) {
    return { verdict: 'errored', detail: 'vitest produced no JSON report', stdout: stdout.slice(-2000) };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    return { verdict: 'errored', detail: `unreadable vitest report: ${String(error)}`, stdout: stdout.slice(-2000) };
  }
  const failedTests = report.numFailedTests ?? 0;
  const failedSuites = report.numFailedTestSuites ?? 0;
  const passed = report.numPassedTests ?? 0;
  if (failedTests > 0 || failedSuites > 0) {
    const names = (report.testResults ?? [])
      .flatMap((file) => (file.assertionResults ?? []))
      .filter((test) => test.status === 'failed')
      .map((test) => test.fullName)
      .slice(0, 8);
    return {
      verdict: 'killed',
      detail: `${failedTests} failed test(s), ${failedSuites} failed suite(s)`,
      failedTestNames: names,
    };
  }
  if (failed) {
    return { verdict: 'errored', detail: 'vitest exited non-zero with no failed assertion', stdout: stdout.slice(-2000) };
  }
  return { verdict: 'survived', detail: `${passed} test(s) passed on the mutated source` };
}

/** Restore a mutated file from git. */
function restore(file) {
  execFileSync('git', ['checkout', '--', file], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Refuse to mutate a file that has uncommitted changes.
 *
 * The restore is `git checkout --`, which discards whatever was in the
 * working tree. If the author had unsaved work in the file under test, this
 * tool would silently delete it — so the run stops BEFORE anything is
 * touched, and names the file.
 */
function assertClean(file) {
  const status = execFileSync('git', ['status', '--porcelain', '--', file], {
    cwd: REPO_ROOT, encoding: 'utf8',
  });
  if (status.trim().length > 0) {
    throw new Error(
      `refusing to mutate ${file}: it has uncommitted changes, and restoring the `
      + 'original after the mutation would discard them. Commit or stash first.',
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.spec) {
    process.stderr.write('usage: node scripts/test-fault-injection.mjs --spec <spec.json> [--out <report.json>]\n');
    process.exit(2);
  }
  const specPath = resolve(process.cwd(), args.spec);
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const cases = spec.cases ?? [];
  const results = [];

  for (const testCase of cases) {
    const sourcePath = resolve(REPO_ROOT, testCase.source);
    if (!existsSync(sourcePath)) {
      results.push({ case: testCase.name, source: testCase.source, error: 'source file not found', mutations: [] });
      continue;
    }
    const original = readFileSync(sourcePath, 'utf8');
    const mutationResults = [];
    try {
      assertClean(testCase.source);
    } catch (error) {
      results.push({
        case: testCase.name,
        source: testCase.source,
        error: error instanceof Error ? error.message : String(error),
        mutations: [],
      });
      continue;
    }
    for (const mutation of testCase.mutations ?? []) {
      // A checkout on Windows may hold CRLF where the spec's text holds LF.
      // The mutation still has to be found, so the CRLF spelling is tried too
      // — and a mutation that only matches the other spelling is still the
      // same mutation, not a different defect.
      const candidates = [mutation.find];
      if (mutation.find.includes('\n')) candidates.push(mutation.find.replace(/\n/g, '\r\n'));
      const found = candidates.find((text) => occurrences(original, text) === 1);
      if (found === undefined) {
        const counts = candidates.map((text) => occurrences(original, text)).join('/');
        mutationResults.push({
          id: mutation.id,
          description: mutation.description,
          verdict: 'skipped',
          detail: `the target text occurs ${counts} time(s); it must occur exactly once`,
        });
        continue;
      }
      const mutated = original.replace(found, found === mutation.find ? mutation.replace : mutation.replace.replace(/\n/g, '\r\n'));
      writeFileSync(sourcePath, mutated, 'utf8');
      let outcome;
      try {
        outcome = runSuite(testCase.tests ?? []);
      } finally {
        restore(testCase.source);
      }
      mutationResults.push({
        id: mutation.id,
        description: mutation.description,
        verdict: outcome.verdict,
        detail: outcome.detail,
        failedTestNames: outcome.failedTestNames,
      });
      process.stdout.write(
        `${outcome.verdict.toUpperCase().padEnd(9)} ${testCase.name} / ${mutation.id} — ${outcome.detail}\n`,
      );
    }
    results.push({ case: testCase.name, source: testCase.source, tests: testCase.tests, mutations: mutationResults });
  }

  const summary = { killed: 0, survived: 0, errored: 0, skipped: 0 };
  for (const result of results) {
    for (const mutation of result.mutations ?? []) {
      if (mutation.verdict in summary) summary[mutation.verdict]++;
    }
  }
  const report = { spec: args.spec, summary, cases: results };
  if (args.out) {
    writeFileSync(resolve(process.cwd(), args.out), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`\n${JSON.stringify(summary)}\n`);
}

main();
