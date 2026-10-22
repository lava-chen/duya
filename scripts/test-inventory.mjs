#!/usr/bin/env node
/**
 * test-inventory.mjs — the reusable answer to "what does this repo's test
 * suite contain, what does it cost, and what is at risk?".
 *
 * ## Why this exists
 *
 * A test suite's size is not its quality, and a passing run is not evidence
 * that anything is being checked. The questions a maintainer actually asks are:
 *
 *   1. Which production code does this test file protect?
 *   2. What does it cost to run, and what does that cost buy?
 *   3. Where is the risk concentrated — the files that assert nothing, skip
 *      their own cases, bury the product behind mocks, or survived an injected
 *      defect?
 *
 * This script answers all three from evidence: the file list comes from the
 * vitest include globs (the same ones the runner uses), the static signals come
 * from the file's own source, and the cost comes from a real vitest JSON
 * report when one is supplied.
 *
 * ## What it deliberately does NOT do
 *
 * It does not guess quality from a file's name, its length, or its number of
 * assertions. A 2,000-line file full of mocks and no assertions is not a
 * strong test, and a 30-line file that kills a mutant is. The classification
 * here is a set of EVIDENCE FLAGS, each of which can be checked by a reader;
 * the letter grade is a summary of how many flags a file carries, and the
 * flags themselves are always listed.
 *
 * ## Usage
 *
 *   node scripts/test-inventory.mjs                        # print the summary
 *   node scripts/test-inventory.mjs --report <vitest.json> # include measured cost
 *   node scripts/test-inventory.mjs --write                # write the docs
 *
 *   --write refuses to overwrite an artifact that carries measurements
 *   unless a --report is given: the measured cost is the point of the file,
 *   and dropping it silently would look like a successful regeneration.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { includeMatchers } from './lib/vitest-include.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** The surfaces a test file can belong to, derived from its path. */
const KIND_RULES = [
  [/^scripts\/(?:architecture|ci)\//, 'gate'],
  [/^scripts\//, 'gate'],
  [/^evals\//, 'eval'],
  [/^e2e\//, 'e2e'],
  [/^apps\/desktop\/src\/main\//, 'desktop-main'],
  [/^apps\/desktop\//, 'desktop'],
  [/^apps\/web\//, 'web'],
  [/^packages\/ui\//, 'ui'],
  [/^packages\/agent-protocol\//, 'protocol'],
  [/^packages\/agent-core\//, 'core'],
  [/^packages\/agent-runtime\//, 'runtime'],
  [/^packages\/client-core\//, 'client-core'],
  [/^packages\/command-catalog\//, 'command-catalog'],
  [/^packages\/host\//, 'host'],
  [/^packages\/cli\//, 'cli'],
  [/^packages\/capabilities\//, 'capability'],
  [/^packages\/computer-use\//, 'computer-use'],
  [/^packages\/conductor\//, 'conductor'],
  [/^packages\/plugin-core\//, 'plugin'],
  [/^packages\/connectors\//, 'connector'],
  [/^packages\/memory\//, 'memory'],
  [/^packages\/ai\//, 'ai'],
  [/^packages\/data\//, 'data'],
  [/^packages\/gateway\//, 'gateway'],
  [/^packages\/voice\//, 'voice'],
  [/^packages\/sandbox\//, 'sandbox'],
  [/^packages\/tooling\//, 'tooling'],
  [/^packages\/input-completion\//, 'input-completion'],
  [/^packages\/agent\//, 'agent'],
];

/** The module root a file belongs to, for grouping. */
function moduleOf(rel) {
  const match = rel.match(/^(packages\/[^/]+|apps\/[^/]+|scripts|evals|e2e|tests)\//);
  return match ? match[1] : '(root)';
}

function kindOf(rel) {
  for (const [pattern, kind] of KIND_RULES) {
    if (pattern.test(rel)) return kind;
  }
  return 'other';
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function count(haystack, needle) {
  if (!needle) return 0;
  let total = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    total++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return total;
}

/**
 * The production modules a test file exercises.
 *
 * Only RELATIVE imports count: they are the ones that stay inside the file's
 * own package and therefore name a concrete production module. A `@duya/*`
 * import names a package boundary, not a module, and the boundary is already
 * recorded by the file's kind.
 */
function targetsOf(rel, source) {
  const dir = dirname(rel);
  const found = new Set();
  const importPattern = /(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    // The repo's ESM-style imports name the EMITTED file (`.js`) while the
    // source is TypeScript, so the extension is stripped before the source
    // spelling is tried. Without this, `../src/http-client.js` resolves to a
    // path that exists for neither `.ts` nor `.tsx`, and the file reports no
    // production module at all.
    const withoutExtension = specifier.replace(/\.(js|jsx|mjs|cjs)$/, '');
    const base = resolve(REPO_ROOT, dir, withoutExtension);
    for (const suffix of ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']) {
      const candidate = `${base}${suffix}`;
      if (!existsSync(candidate)) continue;
      const target = relative(REPO_ROOT, candidate).replace(/\\/g, '/');
      if (TEST_FILE.test(target)) break;
      if (target.endsWith('.d.ts')) break;
      found.add(target);
      break;
    }
  }
  return [...found].sort();
}

function readMeasured(reportPath) {
  if (!reportPath) return new Map();
  if (!existsSync(reportPath)) {
    process.stderr.write(`test-inventory: no measured report at ${reportPath}\n`);
    return new Map();
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const map = new Map();
  const repoRoot = REPO_ROOT.replace(/\\/g, '/');
  for (const file of report.testResults ?? []) {
    const assertions = file.assertionResults ?? [];
    const body = assertions.reduce((sum, a) => sum + (a.duration ?? 0), 0);
    const abs = file.name.replace(/\\/g, '/');
    // The report carries ABSOLUTE paths, and they are absolute in whatever
    // checkout produced them. Strip THIS checkout's root to get the
    // repository-relative path the inventory is keyed by. A hard-coded
    // directory name would silently drop every measurement on any other
    // machine — the file would still be written, just without its cost data.
    const rel = abs.startsWith(`${repoRoot}/`) ? abs.slice(repoRoot.length + 1) : abs;
    map.set(rel, {
      tests: assertions.length,
      bodyMs: body,
      wallMs: Math.max(0, (file.endTime ?? 0) - (file.startTime ?? 0)),
      failed: assertions.filter((a) => a.status === 'failed').length,
      pending: assertions.filter((a) => a.status !== 'passed' && a.status !== 'failed').length,
    });
  }
  return map;
}

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
  });
  return output.toString('utf8').split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'));
}

export function buildInventory(options = {}) {
  const { globs, matchers } = includeMatchers(REPO_ROOT);
  const measured = readMeasured(options.report);
  const mutants = readMutants(options.mutations);
  const knownOrphans = readKnownOrphans();
  const alternateRunners = readAlternateRunners();

  const rows = [];
  const otherRunners = [];
  for (const file of trackedFiles()) {
    if (!TEST_FILE.test(file)) continue;
    if (file.startsWith('docs/')) continue;
    const isCollected = matchers.some((re) => re.test(file));
    if (!isCollected) {
      // A tracked test file the vitest runner does not collect is either run by
      // a DIFFERENT runner (Playwright for e2e/, node:test for the rules check)
      // or is a real orphan. Both are worth recording, but they are not part of
      // the vitest suite, so they do not belong in its per-file records.
      otherRunners.push({
        file,
        runner: file.startsWith('e2e/')
          ? 'playwright'
          : knownOrphans.has(file) || alternateRunners.has(file) ? 'alternate runner' : 'NONE — collected by nobody',
      });
      continue;
    }
    const absolute = resolve(REPO_ROOT, file);
    if (!existsSync(absolute)) continue;
    const source = readFileSync(absolute, 'utf8');

    const tests = (source.match(/\b(?:it|test)\s*(?:\.\w+)?\s*\(/g) ?? []).length;
    const assertions = (source.match(/\bexpect\s*\(/g) ?? []).length;
    const mocks = (source.match(/\bvi\.mock\s*\(/g) ?? []).length;
    const spies = (source.match(/\bvi\.spyOn\s*\(/g) ?? []).length;
    const skipped = (source.match(/\b(?:it|test|describe)\.(?:skip|todo)\b/g) ?? []).length;
    const only = (source.match(/\b(?:it|test|describe)\.only\b/g) ?? []).length;
    const stdout = (source.match(/process\.(?:stdout|stderr)\.write/g) ?? []).length;
    const timings = measured.get(file);

    const flags = [];
    if (tests > 0 && assertions === 0) flags.push('no-assertion');
    if (skipped > 0) flags.push(`skipped-${skipped}`);
    if (only > 0) flags.push(`only-${only}`);
    if (mocks >= Math.max(1, tests)) flags.push('mock-heavy');
    if (stdout > 0) flags.push('stdout-write');
    const mutant = mutants.get(file);
    if (mutant) {
      if (mutant.survived > 0) flags.push(`mutant-survived-${mutant.survived}`);
      if (mutant.errored > 0) flags.push(`mutant-errored-${mutant.errored}`);
    }

    rows.push({
      file,
      module: moduleOf(file),
      kind: kindOf(file),
      collected: isCollected,
      tests,
      assertions,
      mocks,
      spies,
      targets: targetsOf(file, source),
      flags,
      measured: timings
        ? {
          wallMs: Math.round(timings.wallMs),
          bodyMs: Math.round(timings.bodyMs),
          failed: timings.failed,
          pending: timings.pending,
        }
        : null,
    });
  }

  // Sorted by PATH, not by cost.
  //
  // This artifact is committed, so its only value is that a reviewer can read
  // what changed. Sorting by the measured cost reshuffles every row on every
  // re-measure: adding ONE assertion to one test file came out as a
  // 13,000-line diff, where the actual change was one number. The cost
  // ranking is what the "Slowest files" table is for; the records themselves
  // stay where a reader can find them.
  rows.sort((a, b) => a.file.localeCompare(b.file));
  return { globs, rows, otherRunners };
}

/** Test files no vitest glob collects, recorded in the coverage gate's baseline. */
function readKnownOrphans() {
  const path = resolve(REPO_ROOT, 'scripts/test-coverage-baseline.json');
  if (!existsSync(path)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return new Set();
  }
}

/**
 * Test files a DIFFERENT runner executes: `node --test <file>` in a
 * package.json script.
 *
 * Derived from package.json rather than hard-coded, because the coverage gate
 * derives it the same way and asserts that every such file is invoked from
 * `typecheck:all` — so this list cannot drift from what actually runs.
 */
function readAlternateRunners() {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
  const files = new Set();
  for (const command of Object.values(manifest.scripts ?? {})) {
    for (const match of command.matchAll(/node --test ([\w./-]+\.mjs)/g)) {
      files.add(match[1]);
    }
  }
  return files;
}

/** Read a fault-injection report and index the survivors by the file they hit. */
function readMutants(path) {
  const map = new Map();
  if (!path || !existsSync(path)) return map;
  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return map;
  }
  for (const testCase of report.cases ?? []) {
    for (const mutation of testCase.mutations ?? []) {
      if (mutation.verdict !== 'survived' && mutation.verdict !== 'errored') continue;
      const entry = map.get(testCase.source) ?? { survived: 0, errored: 0 };
      if (mutation.verdict === 'survived') entry.survived++; else entry.errored++;
      map.set(testCase.source, entry);
    }
  }
  return map;
}

function grade(row) {
  // A = no flags; B = one flag; C = two or more. The flags are always listed
  // next to the grade, so the grade never carries information the flags do not.
  const riskFlags = row.flags.filter((f) => f !== 'not-collected');
  if (riskFlags.length === 0) return 'A';
  if (riskFlags.length === 1) return 'B';
  return 'C';
}

function renderMarkdown(inventory) {
  const { rows } = inventory;
  const byModule = new Map();
  for (const row of rows) {
    const key = row.module;
    const entry = byModule.get(key) ?? { files: 0, tests: 0, assertions: 0, mocks: 0, bodyMs: 0, a: 0, b: 0, c: 0 };
    entry.files++;
    entry.tests += row.tests;
    entry.assertions += row.assertions;
    entry.mocks += row.mocks;
    entry.bodyMs += row.measured?.bodyMs ?? 0;
    const g = grade(row);
    if (g === 'A') entry.a++; else if (g === 'B') entry.b++; else entry.c++;
    byModule.set(key, entry);
  }

  const flagCounts = new Map();
  for (const row of rows) {
    for (const flag of row.flags) {
      const key = flag.replace(/-\d+$/, '');
      flagCounts.set(key, (flagCounts.get(key) ?? 0) + 1);
    }
  }

  const measuredTotal = rows.reduce((sum, row) => sum + (row.measured?.bodyMs ?? 0), 0);
  const totalTests = rows.reduce((sum, row) => sum + row.tests, 0);
  const totalAssertions = rows.reduce((sum, row) => sum + row.assertions, 0);
  const totalMocks = rows.reduce((sum, row) => sum + row.mocks, 0);

  const lines = [];
  lines.push('# Test Inventory');
  lines.push('');
  lines.push('Generated by `npm run test:inventory:write`. The per-file records live in `test-inventory.json`;');
  lines.push('this file is the summary. A grade is a summary of the evidence flags on a file — read the');
  lines.push('flags, not the letter.');
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| test files | ${rows.length} |`);
  lines.push(`| test cases | ${totalTests} |`);
  lines.push(`| assertions | ${totalAssertions} |`);
  lines.push(`| module mocks | ${totalMocks} |`);
  lines.push(`| measured test time | ${(measuredTotal / 1000).toFixed(1)}s |`);
  lines.push('');
  lines.push('`test cases` and `assertions` are static counts of `it(`/`test(`/`expect(` call sites in');
  lines.push('the source. A run reports more cases than call sites, because `it.each` and loops expand');
  lines.push('one call site into several runtime cases.');
  lines.push('');
  lines.push('## By module');
  lines.push('');
  lines.push('| module | files | cases | assertions | mocks | measured s | A | B | C |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [name, entry] of [...byModule.entries()].sort((a, b) => b[1].bodyMs - a[1].bodyMs || b[1].files - a[1].files)) {
    lines.push(
      `| \`${name}\` | ${entry.files} | ${entry.tests} | ${entry.assertions} | ${entry.mocks} | `
      + `${(entry.bodyMs / 1000).toFixed(1)} | ${entry.a} | ${entry.b} | ${entry.c} |`,
    );
  }
  lines.push('');
  lines.push('## Evidence flags');
  lines.push('');
  lines.push('| flag | files |');
  lines.push('| --- | ---: |');
  for (const [flag, count_] of [...flagCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| \`${flag}\` | ${count_} |`);
  }
  lines.push('');
  lines.push('## Slowest files');
  lines.push('');
  lines.push('| file | measured ms | cases | grade | flags |');
  lines.push('| --- | ---: | ---: | :---: | --- |');
  for (const row of rows.filter((r) => r.measured).slice(0, 20)) {
    lines.push(
      `| \`${row.file}\` | ${row.measured.bodyMs} | ${row.tests} | ${grade(row)} | ${row.flags.join(', ') || '-'} |`,
    );
  }
  lines.push('');
  lines.push('## Highest risk');
  lines.push('');
  lines.push('| file | grade | flags | production modules exercised |');
  lines.push('| --- | :---: | --- | --- |');
  for (const row of rows.filter((r) => r.flags.length > 0).sort((a, b) => b.flags.length - a.flags.length).slice(0, 25)) {
    lines.push(
      `| \`${row.file}\` | ${grade(row)} | ${row.flags.join(', ')} | `
      + `${row.targets.slice(0, 3).map((t) => `\`${t}\``).join(', ') || '-'} |`,
    );
  }
  lines.push('');
  lines.push('## Test files outside the vitest suite');
  lines.push('');
  lines.push('| file | runner |');
  lines.push('| --- | --- |');
  for (const entry of inventory.otherRunners ?? []) {
    lines.push(`| \`${entry.file}\` | ${entry.runner} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report') options.report = resolve(process.cwd(), argv[++i]);
    else if (argv[i] === '--mutations') options.mutations = resolve(process.cwd(), argv[++i]);
    else if (argv[i] === '--write') options.write = true;
    else if (argv[i] === '--no-measurements') options.noMeasurements = true;
  }
  const inventory = buildInventory(options);
  if (options.write) {
    const markdown = resolve(REPO_ROOT, 'docs/development/test-inventory.md');
    const json = resolve(REPO_ROOT, 'docs/development/test-inventory.json');
    // The committed artifact carries per-file timings. Writing it without a
    // measurement report would drop them — silently, because the file would
    // still be valid JSON and still look like an inventory. Refuse instead,
    // and say how to reproduce what is committed.
    if (!options.report && !options.noMeasurements && existsSync(json)) {
      const existing = JSON.parse(readFileSync(json, 'utf8'));
      if ((existing.rows ?? []).some((row) => row.measured)) {
        process.stderr.write(
          'test-inventory: refusing to overwrite the committed inventory without a measurement report.\n'
          + '  The committed artifact carries per-file timings; writing without --report would drop them.\n'
          + '  Reproduce it with:\n'
          + '    npx vitest run --reporter=json --outputFile.json=<absolute path>\n'
          + '    node scripts/test-inventory.mjs --write --report <absolute path>\n'
          + '  Pass --no-measurements to write the static-only inventory on purpose.\n',
        );
        process.exit(1);
      }
    }
    writeFileSync(markdown, renderMarkdown(inventory), 'utf8');
    writeFileSync(json, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
    process.stdout.write(`test-inventory: wrote ${markdown} and ${json}\n`);
  } else {
    process.stdout.write(renderMarkdown(inventory));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
