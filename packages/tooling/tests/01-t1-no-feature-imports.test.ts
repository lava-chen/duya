/**
 * T1 — `tooling` must not import capabilities / connectors / memory.
 *
 * The rule from `02-tooling-and-extensions.md` §3. If tooling imported a
 * feature package it would become "the registry where everything is
 * registered", which is the exact shape this package refuses to take.
 *
 * Mutation proof: add `import type { X } from '@duya/capabilities';` to any
 * file under `src/` — this gate goes red.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

/** The two sides of this comparison come from different sources on purpose:
 *  the expected list is a literal here, the actual specifiers are read off
 *  disk. A gate that compares a value to itself can never be red. */
const FORBIDDEN_SUBSTRINGS = ['capabilities', 'connectors', 'memory'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Extract every module specifier, including type-only, dynamic, and require. */
function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

describe('T1 — tooling imports no feature packages', () => {
  const files = sourceFiles(SRC_DIR);

  it('finds the package sources to scan (guard against an empty scan)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('has no import of capabilities / connectors / memory', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
        for (const forbidden of FORBIDDEN_SUBSTRINGS) {
          if (specifier.includes(forbidden)) {
            violations.push(`${file}: "${specifier}" matches forbidden "${forbidden}"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('imports nothing but its own relative modules (zero runtime deps)', () => {
    const nonRelative: string[] = [];
    for (const file of files) {
      for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
          nonRelative.push(`${file}: "${specifier}"`);
        }
      }
    }
    expect(nonRelative).toEqual([]);
  });

  it('declares no runtime dependencies in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});
