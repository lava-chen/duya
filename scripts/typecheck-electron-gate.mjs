#!/usr/bin/env node
// typecheck-electron-gate.mjs — ratcheting typecheck gate for the Electron
// main process (plan 583, ISS-01).
//
// Why this exists instead of a plain `tsc --noEmit` in CI: the electron tree
// had never been typechecked at all (the root tsconfig excludes
// `apps/desktop/src/main/**`, and `typecheck:all` therefore never compiled the
// main process), which is
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
const project = resolve(repoRoot, 'apps/desktop/tsconfig.main.json');

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

  const seen = new Set();
  for (const line of output.split(/\r?\n/)) {
    const m = ERROR_LINE.exec(line);
    if (!m) continue;
    const [, file, lineNo, colNo, code] = m;
    // Normalise to repo-root-relative, forward slashes, so the baseline is
    // portable across machines and checkouts. The main process lives under
    // `apps/desktop/src/main/` since the electron/ -> apps/desktop relocation.
    const rel = file.replace(/\\/g, '/').replace(/^.*?(apps\/desktop\/src\/main\/)/, '$1');
    seen.add(`${rel}:${lineNo}:${colNo} ${code}`);
  }
  return seen;
}

function readBaseline() {
  if (!existsSync(baselinePath)) return new Set();
  return new Set(
    readFileSync(baselinePath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}

const current = collectErrors();
const baseline = readBaseline();

if (write) {
  const lines = [
    '# Baseline of KNOWN type errors in the electron main process.',
    '# Managed by scripts/typecheck-electron-gate.mjs — regenerate with `--write`.',
    '# Format: <path>:<line>:<col> <TScode>',
    '#',
    '# This file exists so the gate can fail on NEW errors while the ~294',
    '# pre-existing ones are paid down. Each fix should delete its line here',
    '# via `--write`; never hand-add a line to silence a new error.',
    '#',
    `# ${current.size} known error(s).`,
    ...[...current].sort(),
    '',
  ];
  writeFileSync(baselinePath, lines.join('\n'), 'utf8');
  process.stdout.write(`typecheck-electron-gate: wrote baseline with ${current.size} known error(s).\n`);
  process.exit(0);
}

const introduced = [...current].filter((e) => !baseline.has(e));
const resolved = [...baseline].filter((e) => !current.has(e));

if (resolved.length > 0) {
  process.stdout.write(
    `typecheck-electron-gate: ${resolved.length} previously-known error(s) are now gone ` +
      `(${baseline.size - current.size} net). Re-record with \`--write\` to shrink the baseline.\n`,
  );
}

if (introduced.length > 0) {
  process.stderr.write(
    `\ntypecheck-electron-gate: ${introduced.length} NEW type error(s) in the electron main process.\n` +
      `These are not in the baseline, so they were introduced by this change:\n\n`,
  );
  for (const e of introduced.sort()) process.stderr.write(`  ${e}\n`);
  process.stderr.write(
    `\nFix them, or if they are pre-existing debt that this change legitimately ` +
      `exposed, re-record the baseline with:\n  node scripts/typecheck-electron-gate.mjs --write\n\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `typecheck-electron-gate: OK — no new type errors (${current.size} known, ${baseline.size} baselined).\n`,
);
process.exit(0);
