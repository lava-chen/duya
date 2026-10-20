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
//   - none carries mojibake
//
// Why mojibake is a separate rule and not a stronger UTF-8 check: mojibake
// is BYTE-VALID UTF-8. When GBK-mojibake text is written back out, the
// damaged pair (U+9225 followed by an ASCII `?`) is itself a well-formed
// multi-byte sequence, so `isValidUtf8` returns true and every rule above
// passes. A decode gate therefore cannot fail on this defect class no matter
// how strict it gets — only a content inspection can. That is why the rules
// below look at characters, not bytes. See `MOJIBAKE_RULES` for the
// false-positive argument per rule.
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

/**
 * Mojibake signatures, each with the false-positive argument that earns it a
 * place in the gate.
 *
 * Every literal below is written as a \u escape on purpose. Spelling the
 * patterns out as real characters would put the very bytes this gate hunts
 * for inside the gate, and the detector would eventually trip over its own
 * source. Keeping this table pure ASCII makes that structurally impossible.
 *
 * The recurring hazard: several signatures are themselves valid CJK
 * codepoints (U+9225 is an obscure ideograph; U+9539 is a component
 * character). A naive blacklist of "these characters" would fire on any
 * legitimately Chinese source file. The rules are therefore written to match
 * the DAMAGED CONTEXT rather than the damaged character alone:
 *
 *   - CJK-range rules require an adjacent ASCII `?` or the full three-char
 *     锟斤拷 token. Real Chinese text does not place a halfwidth `?`
 *     directly against a CJK ideograph, and 锟斤拷 is not a word.
 *   - Latin-1/CP1252 rules require a lead byte followed by the specific
 *     sequence that only a double-decode produces.
 *   - U+FFFD is the replacement character itself and is never authored.
 *
 * Deliberately NOT matched: a bare U+9225 / U+9539, or any generic
 * "CJK ideograph followed by ?". Both are individually plausible in genuine
 * Chinese prose, and a gate that cries wolf on real content gets deleted.
 */
const MOJIBAKE_RULES = [
  // The replacement character. Only ever produced by a lossy decode.
  { label: 'replacement-char', re: /\uFFFD/ },
  // A UTF-8 BOM that was decoded as CP1252/Latin-1 somewhere upstream.
  { label: 'bom-decoded-as-latin1', re: /\u00EF\u00BF\u00BD/ },
  // UTF-8 bytes decoded as CP1252 twice: an em dash or curly quote. This
  // subsumes the curly-quote variants, which share its first two characters,
  // so they need no separate rule.
  { label: 'cp1252-punctuation', re: /\u00E2\u20AC/ },
  // UTF-8 bytes decoded as CP1252: a Latin-1 letter carrying a diacritic.
  { label: 'cp1252-letter', re: /\u00C3[\u0080-\u00FF]/ },
  // The GBK signature: an em dash (E2 80 94) read as GBK, where the third
  // byte has no mapping and becomes `?`. Committed in
  // packages/cli/src/chat.ts and printed by `duya chat`.
  { label: 'gbk-em-dash', re: /\u9225\?/ },
  // The canonical UTF-8-through-GBK replacement token.
  { label: 'gbk-replacement', re: /\u9539\u65A4\u62C7/ },
];

/**
 * Report every mojibake signature in `text`, with 1-based line numbers.
 *
 * @param {string} text Decoded file content.
 * @returns {{ label: string, line: number, sample: string }[]}
 */
export function findMojibake(text) {
  const findings = [];
  for (const { label, re } of MOJIBAKE_RULES) {
    const pattern = new RegExp(re.source, 'g');
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      findings.push({ label, line, sample: match[0] });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
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
    // Mojibake decodes cleanly, so it can only be caught by looking at the
    // characters themselves. This runs on every BOM-less, valid-UTF-8 file.
    const mojibake = findMojibake(new TextDecoder('utf-8').decode(bytes));
    if (mojibake.length > 0) {
      const lines = [...new Set(mojibake.map((m) => m.line))].join(', ');
      const labels = [...new Set(mojibake.map((m) => m.label))].join(', ');
      // `reason` stays stable so the baseline ratchet keys on a defect class,
      // not on line numbers that any unrelated edit above would shift.
      violations.push({ file, reason: 'mojibake', detail: `${labels} on line(s) ${lines}` });
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
    + newOnes.map((v) => `  ${v.file}  (${v.reason}${v.detail ? `: ${v.detail}` : ''})`).join('\n')
    + '\n'
    + 'If the flagged bytes were already damaged on disk, fix the text; if they\n'
    + 'were damaged in transit, fix the tool that produced them.\n',
  );
  process.exit(1);
}

if (known.length === 0) {
  process.stdout.write('check-text-encoding: OK — every tracked text file is BOM-less UTF-8 with no mojibake.\n');
} else {
  process.stdout.write(`check-text-encoding: OK — no new violations (${known.length} known).\n`);
}
