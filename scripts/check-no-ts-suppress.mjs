#!/usr/bin/env node
/**
 * check-no-ts-suppress.mjs — fail on file-level TypeScript suppression.
 *
 * Why this exists: `// @ts-nocheck` turns off semantic checking for a whole
 * file while leaving every line above it looking perfectly ordinary. It does
 * not fail the build, does not fail `npm run`, and is invisible in review.
 *
 * Four Feishu adapter files carried one. The audit read them as "four files
 * with unknown type debt"; the actual cost was a single line —
 * `comment-handler.ts` imported `FeishuConfigOptions` from `./types.js`, an
 * export that has not existed for a long time, and nothing noticed. The
 * same files were exempt from every future error too, so the debt could
 * have grown without limit.
 *
 * Policy:
 *   - `@ts-nocheck`  banned outright, zero tolerance.
 *   - `@ts-ignore`   banned except for an explicit allowlist below, which
 *                    must be justified in review.
 *   - `@ts-expect-error` allowed. It is self-policing: TypeScript errors if
 *                    the suppressed line has no error, so it cannot rot the
 *                    way the other two can.
 *
 * Exit codes: 0 clean, 1 suppression found.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files that are exempt because they are this gate's own fixtures.
 *
 * A test for this gate has to contain the banned tokens verbatim, otherwise
 * it is not testing anything. Exempting them explicitly — and reporting the
 * exemption in the summary — keeps the gate honest instead of quietly
 * skipping whatever it happens to dislike.
 */
const SELF_TEST_FILES = new Set(['scripts/check-no-ts-suppress.test.ts']);

/**
 * `@ts-ignore` sites that are accepted. Each one needs a reason here; adding
 * an entry is a deliberate act, not a side effect of running out of ideas.
 * Keyed by repo-relative path so a line-number shift elsewhere does not
 * silently un-allowlist (or re-allowlist) something.
 */
const ALLOWED_IGNORES = new Map([
  [
    'packages/agent/src/utils/imageResizer.ts',
    'jimp ships no usable types for the v1 import surface',
  ],
]);

/**
 * Collect every TypeScript suppression comment in a source file.
 *
 * Scans raw text rather than the AST on purpose: a directive only takes
 * effect where it physically sits, so the text is the thing being policed.
 *
 * @param {string} text
 * @returns {{ kind: 'nocheck' | 'ignore' | 'expect-error', line: number, text: string }[]}
 */
export function findSuppressions(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('@ts-nocheck')) {
      found.push({ kind: 'nocheck', line: i + 1, text: line.trim() });
      continue;
    }
    if (line.includes('@ts-ignore')) {
      found.push({ kind: 'ignore', line: i + 1, text: line.trim() });
      continue;
    }
    if (line.includes('@ts-expect-error')) {
      found.push({ kind: 'expect-error', line: i + 1, text: line.trim() });
    }
  }
  return found;
}

/** Repo-relative, forward-slashed paths of every tracked TypeScript file. */
function trackedTypeScriptFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--', '*.ts', '*.tsx'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\0').filter(Boolean);
}

function main() {
  const files = trackedTypeScriptFiles();
  const violations = [];
  let expectErrorCount = 0;
  let allowedIgnoreCount = 0;
  const exemptFiles = [];

  for (const rel of files) {
    if (SELF_TEST_FILES.has(rel)) {
      exemptFiles.push(rel);
      continue;
    }
    let text;
    try {
      text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue; // deleted between ls-files and read; not this gate's problem
    }
    const hits = findSuppressions(text);
    if (hits.length === 0) continue;

    const allowReason = ALLOWED_IGNORES.get(rel);
    let ignoresHere = 0;

    for (const hit of hits) {
      if (hit.kind === 'expect-error') {
        expectErrorCount++;
      } else if (hit.kind === 'nocheck') {
        violations.push(
          `${rel}:${hit.line}  @ts-nocheck disables type checking for the whole file\n` +
            `      ${hit.text}`,
        );
      } else {
        ignoresHere++;
        if (allowReason) {
          allowedIgnoreCount++;
        } else {
          violations.push(
            `${rel}:${hit.line}  @ts-ignore is not on the allowlist\n` +
              `      ${hit.text}`,
          );
        }
      }
    }

    if (allowReason && ignoresHere > 1) {
      violations.push(
        `${rel}  allowlisted for @ts-ignore but now has ${ignoresHere} of them; ` +
          `the allowlist entry is stale`,
      );
    }
  }

  if (violations.length > 0) {
    console.error('check-no-ts-suppress: FAILED');
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      '\n  Fix the underlying type error. If a suppression is genuinely ' +
        'unavoidable, add it to ALLOWED_IGNORES in this script with a reason.',
    );
    process.exit(1);
  }

  console.log(
    `check-no-ts-suppress: OK — 0 @ts-nocheck, ` +
      `${allowedIgnoreCount} allowlisted @ts-ignore, ` +
      `${expectErrorCount} @ts-expect-error across ${files.length} file(s)` +
      (exemptFiles.length > 0 ? `, ${exemptFiles.length} fixture file(s) exempt: ${exemptFiles.join(', ')}` : '') +
      '.',
  );
}

main();
