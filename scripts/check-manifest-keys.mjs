#!/usr/bin/env node
/**
 * check-manifest-keys.mjs — fail on duplicate keys in tracked JSON manifests.
 *
 * Why this exists: JSON.parse keeps the LAST occurrence of a duplicate key
 * and silently drops the earlier one. A duplicated `"scripts"` entry
 * therefore does not fail the build, does not fail `npm run`, and is
 * invisible in review — it just quietly replaces the earlier definition.
 * That is how `pretest:coverage` ended up declared twice: the second
 * definition (the sqlite ABI hook) won, so the test-collection gate
 * wired into the first one never ran at all. A gate that silently does
 * not gate is worse than no gate, because it is trusted.
 *
 * This scans the raw text instead of the parsed value, so it sees every
 * occurrence rather than the surviving one. It is a small JSON scanner,
 * not a full parser: it only needs to know which strings are object keys,
 * which requires tracking container nesting and whether the next string
 * in an object is a key position.
 *
 * Scope: tracked `*package.json` manifests only. Duplicate keys are
 * legal-ish in loose JSON consumers elsewhere (tsconfig, VS Code
 * settings), so this deliberately does not police all JSON in the repo.
 *
 * Exit codes: 0 clean, 1 duplicates found.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Walk the raw JSON text and report every object key that occurs more
 * than once within the same object.
 *
 * @returns {{ key: string, line: number, firstLine: number }[]}
 */
export function findDuplicateKeys(text) {
  const duplicates = [];
  // Each frame is an open container. Objects track their key positions;
  // arrays only need to be tracked so nesting stays balanced.
  const stack = [];
  let line = 1;
  let inString = false;
  let escaped = false;
  let stringStart = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (ch === '\n') line += 1;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        // A string sitting in a key position of the enclosing object is
        // a member name, not a value.
        const top = stack[stack.length - 1];
        if (top && top.isObject && top.expectKey) {
          const key = text.slice(stringStart + 1, i);
          if (top.keys.has(key)) {
            duplicates.push({ value: key, line, firstLine: top.keyLines.get(key) });
          } else {
            top.keys.add(key);
            top.keyLines.set(key, line);
          }
          top.expectKey = false;
        }
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stringStart = i;
      continue;
    }
    if (ch === '\n') {
      line += 1;
      continue;
    }
    if (ch === '{') {
      stack.push({ isObject: true, expectKey: true, keys: new Set(), keyLines: new Map() });
      continue;
    }
    if (ch === '[') {
      stack.push({ isObject: false });
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      continue;
    }
    if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top && top.isObject) top.expectKey = true;
      continue;
    }
    if (ch === ':') {
      const top = stack[stack.length - 1];
      if (top && top.isObject) top.expectKey = false;
      continue;
    }
  }

  return duplicates;
}

/**
 * Returns the tracked manifests, or the root one when git is unavailable
 * (e.g. running inside a packaged artifact).
 */
function listTrackedManifests() {
  try {
    const out = execFileSync('git', ['ls-files', '*package.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    // Not a git checkout (e.g. a packaged artifact): fall back to the
    // root manifest only rather than failing the gate.
    return ['package.json'];
  }
}

function main() {
  const manifests = listTrackedManifests();
  let failures = 0;

  for (const rel of manifests) {
    const abs = path.join(REPO_ROOT, rel);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    const duplicates = findDuplicateKeys(text);
    for (const dup of duplicates) {
      failures += 1;
      process.stderr.write(
        `${rel}:${dup.line}: duplicate key "${dup.value}" (first declared at line ${dup.firstLine})\n`,
      );
    }
  }

  if (failures > 0) {
    process.stderr.write(
      `\ncheck-manifest-keys: ${failures} duplicate manifest key(s).\n` +
        '  JSON keeps only the last occurrence, so the earlier entry is silently\n' +
        '  ignored. Merge the definitions instead of repeating the key.\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `check-manifest-keys: OK — no duplicate keys across ${manifests.length} manifest(s).\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
