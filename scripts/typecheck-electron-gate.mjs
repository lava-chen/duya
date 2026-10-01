#!/usr/bin/env node
// typecheck-electron-gate.mjs — ratcheting typecheck gate for the Electron
// main process (plan 583, ISS-01).
//
// Why this exists instead of a plain `tsc --noEmit` in CI: the electron tree
// had never been typechecked at all (the root tsconfig excludes `electron/**`,
// and `typecheck:all` therefore never compiled the main process), which is
// how two P0-class type errors shipped — `remote-mcp.ts` calling
// `session.ledger` on a type with no such property. Cleaning all ~294
// pre-existing errors is a separate, larger project, so a strict gate would
// simply stay red and get ignored.
//
// This gate is the standard ratchet instead: it compares the current error
// set against a checked-in baseline and fails ONLY on errors that are new.
// That makes the gate immediately effective at the failure class that
// actually bit us (a newly introduced type error reaching a release), while
// leaving a monotonically shrinking debt for the follow-up tracks to burn
// down with `--write`.
//
// Usage:
//   node scripts/typecheck-electron-gate.mjs         # check (CI)
//   node scripts/typecheck-electron-gate.mjs --write  # re-record the baseline
//
// Exit codes: 0 = no new errors, 1 = new errors present, 2 = the gate itself
// could not run (tsc missing, unparsable output).

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const baselinePath = resolve(scriptDir, 'typecheck-electron-baseline.txt');
const project = resolve(repoRoot, 'electron/tsconfig.json');

const write = process.argv.includes('--write');

// `path(line,col): error TSxxxx: message`
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/;

function collectErrors() {
  const proc = spawnSync(
    process.execPath,
    [resolve(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', project, '--noEmit', '--pretty', 'false'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;

  // tsc exits 0 when clean and 1 (sometimes 2) when it reports diagnostics.
  // Both mean "we have output to parse"; anything else is a broken run.
  if (proc.status !== 0 && proc.status !== 1 && proc.status !== 2) {
    process.stderr.write(
      `typecheck-electron-gate: tsc could not run (exit ${proc.status}).\n${output}\n`,
    );
    process.exit(2);
  }
  if (!existsSync(resolve(repoRoot, 'node_modules/typescript/bin/tsc'))) {
    process.stderr.write('typecheck-electron-gate: typescript is not installed. Run `npm install`.\n');
    process.exit(2);
  }

  // Key on `<path> <TScode>` with a COUNT, deliberately NOT on line:col.
  // Line numbers shift whenever anything above an error gains or loses a
  // line — adding one import moved 300-odd pre-existing errors by one line
  // and turned the whole baseline into false "new" reports. A count per
  // (file, code) is stable under that churn while still failing when a file
  // gains an additional error of a code it already had.
  const counts = new Map();
  for (const line of output.split(/\r?\n/)) {
    const m = ERROR_LINE.exec(line);
    if (!m) continue;
    const [, file, , , code] = m;
    // Normalise to repo-root-relative, forward slashes, so the baseline is
    // portable across machines and checkouts.
    const rel = file.replace(/\\/g, '/').replace(/^.*?(electron\/)/, '$1');
    const key = `${rel} ${code}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function readBaseline() {
  if (!existsSync(baselinePath)) return new Map();
  const map = new Map();
  for (const line of readFileSync(baselinePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // "<path> <TScode> <count>"
    const m = /^(.*\s)(TS\d+)\s+(\d+)$/.exec(trimmed);
    if (!m) continue;
    map.set(`${m[1]}${m[2]}`, Number(m[3]));
  }
  return map;
}

/** Keys whose current count exceeds the baselined count. */
function regressions(current, baseline) {
  const out = [];
  for (const [key, count] of current) {
    const allowed = baseline.get(key) ?? 0;
    if (count > allowed) out.push({ key, count, allowed });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Keys that disappeared entirely — safe to drop from the baseline. */
function resolvedKeys(current, baseline) {
  const out = [];
  for (const [key, count] of baseline) {
    const now = current.get(key) ?? 0;
    if (now < count) out.push({ key, was: count, now });
  }
  return out;
}

const current = collectErrors();
const baseline = readBaseline();

if (write) {
  const total = [...current.values()].reduce((a, b) => a + b, 0);
  const lines = [
    '# Baseline of KNOWN type errors in the electron main process.',
    '# Managed by scripts/typecheck-electron-gate.mjs — regenerate with `--write`.',
    '# Format: <path> <TScode> <count>',
    '#',
    '# Keys deliberately exclude line:col. Line numbers shift whenever anything',
    '# above an error gains or loses a line, which would turn every existing',
    '# error into a false "new" report. Counting per (file, code) is stable',
    '# under that churn and still fails when a file gains an error of a code it',
    '# already had.',
    '#',
    '# Each fix should let you delete or lower its line here via `--write`;',
    '# never hand-add a line to silence a new error.',
    '#',
    `# ${total} known error(s) across ${current.size} (file, code) key(s).`,
    ...[...current.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`),
    '',
  ];
  writeFileSync(baselinePath, lines.join('\n'), 'utf8');
  process.stdout.write(
    `typecheck-electron-gate: wrote baseline with ${total} known error(s) in ${current.size} key(s).\n`,
  );
  process.exit(0);
}

const regressionsFound = regressions(current, baseline);
const resolved = resolvedKeys(current, baseline);

if (resolved.length > 0) {
  process.stdout.write(
    `typecheck-electron-gate: ${resolved.length} baselined key(s) shrank or disappeared. ` +
      `Re-record with \`--write\` to tighten the baseline.\n`,
  );
}

if (regressionsFound.length > 0) {
  process.stderr.write(
    `\ntypecheck-electron-gate: ${regressionsFound.length} NEW type error(s) in the electron main process.\n` +
      `These exceed the baseline, so they were introduced by this change:\n\n`,
  );
  for (const r of regressionsFound) {
    process.stderr.write(`  ${r.key}  (now ${r.count}, baseline ${r.allowed})\n`);
  }
  process.stderr.write(
    `\nFix them, or if they are pre-existing debt that this change legitimately ` +
      `exposed, re-record the baseline with:\n  node scripts/typecheck-electron-gate.mjs --write\n\n`,
  );
  process.exit(1);
}

const totalNow = [...current.values()].reduce((a, b) => a + b, 0);
process.stdout.write(
  `typecheck-electron-gate: OK — no new type errors (${totalNow} known across ${current.size} key(s)).\n`,
);
process.exit(0);
