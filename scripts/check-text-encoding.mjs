#!/usr/bin/env node
// scripts/check-text-encoding.mjs
// Ratcheting gate for repository text encoding (plan 583, ISS-48).
//
// Why this exists instead of a one-off cleanup: the tree carried 13 UTF-8
// BOMs (nine of them an entire package directory, five with a DOUBLE BOM) and
// two files stored as UTF-16LE, with no encoding contract anywhere in the
// repo. `.gitattributes` pinned line endings and said nothing about encoding.
// Cleaning the tree without a gate just resets the clock.
//
// What it checks, over `git ls-files`:
//   - every tracked text file decodes as strict UTF-8 (no lone surrogates,
//     no legacy codepage bytes)
//   - none starts with a UTF-8 BOM
//   - none is UTF-16 (BOM'd or not) — the shape that produced the failure
//     described in .gitattributes
//   - no file that starts with a shebang has CRLF on that line
//
// Usage:
//   node scripts/check-text-encoding.mjs          # check (CI)
//   node scripts/check-text-encoding.mjs --write  # re-record the baseline
//
// Baseline exists for the same reason as the electron typecheck gate: if a
// file is currently unfixable, the gate should report it once and then stop
// shouting, rather than be permanently red and therefore ignored.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const baselinePath = resolve(scriptDir, 'text-encoding-baseline.json');

const write = process.argv.includes('--write');

// Only extensions where a stray byte is a bug. Binaries and lockfiles are out.
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|toml|ya?ml|hbs)$/i;

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

function startsWith(bytes, sig) {
  return bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
}

/** Strict UTF-8 decode; throws on any invalid sequence. */
function isValidUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function collectViolations() {
  const proc = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    process.stderr.write(`check-text-encoding: git ls-files failed (${proc.status}).\n`);
    process.exit(2);
  }
  const files = proc.stdout.toString('utf8').split('\0').filter(Boolean);
  const violations = [];
  for (const file of files) {
    if (!TEXT_EXT.test(file)) continue;
    const abs = resolve(repoRoot, file);
    if (!existsSync(abs)) continue;
    const bytes = readFileSync(abs);
    if (bytes.length === 0) continue;

    if (startsWith(bytes, UTF16LE_BOM) || startsWith(bytes, UTF16BE_BOM)) {
      violations.push({ file, reason: 'utf16' });
      continue;
    }
    if (startsWith(bytes, UTF8_BOM)) {
      violations.push({ file, reason: 'bom' });
      continue;
    }
    if (!isValidUtf8(bytes)) {
      violations.push({ file, reason: 'not-utf8' });
      continue;
    }
    // A shebang terminated with CRLF. Node loads these fine (it strips the
    // shebang itself), but Vite/esbuild's transform removes only the `#!...`
    // text and leaves the trailing \r, which is an illegal token. The
    // observable failure is a test file that reports "no tests" instead of
    // failing: scripts/check-manifest-keys.test.ts shipped that way in
    // PR #97, so its eight assertions had never run.
    if (bytes[0] === 0x23 && bytes[1] === 0x21) {
      const lf = bytes.indexOf(0x0a);
      if (lf > 0 && bytes[lf - 1] === 0x0d) {
        violations.push({ file, reason: 'crlf-shebang' });
      }
    }
  }
  return violations;
}

const current = collectViolations().sort((a, b) => a.file.localeCompare(b.file));

if (write) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  process.stdout.write(`check-text-encoding: baseline written (${current.length} known).\n`);
  process.exit(0);
}

let known = [];
if (existsSync(baselinePath)) {
  try {
    known = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    process.stderr.write('check-text-encoding: baseline is unreadable; re-record it with --write.\n');
    process.exit(2);
  }
}
const knownKey = new Set(known.map((v) => `${v.file}:${v.reason}`));
const newOnes = current.filter((v) => !knownKey.has(`${v.file}:${v.reason}`));

if (newOnes.length > 0) {
  process.stderr.write(
    `check-text-encoding: ${newOnes.length} NEW encoding violation(s).\n`
    + 'Text content must be UTF-8 with no BOM. See .editorconfig.\n'
    + newOnes.map((v) => `  ${v.file}  (${v.reason})`).join('\n')
    + '\n',
  );
  process.exit(1);
}

if (known.length === 0) {
  process.stdout.write('check-text-encoding: OK — every tracked text file is BOM-less UTF-8.\n');
} else {
  process.stdout.write(`check-text-encoding: OK — no new violations (${known.length} known).\n`);
}
