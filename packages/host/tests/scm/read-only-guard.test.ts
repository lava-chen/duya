import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Slice C is a READ-ONLY observer: it may call `gh pr view`, `gh pr list`,
 * `gh pr checks` and GET-only `gh api`. A write command in this directory would
 * turn an observation into a side effect, and that is not a code-review
 * preference — it is the slice boundary.
 *
 * This test greps the real source. It is the guard, not a comment about one:
 * it runs in CI, matches both the array form (`['pr', 'merge']`) and prose
 * (`pr merge`), and fails with file:line so the offending line is obvious.
 */
const SCM_SRC = fileURLToPath(new URL('../../src/scm', import.meta.url));

interface ForbiddenRule {
  label: string;
  pattern: RegExp;
}

const FORBIDDEN: ForbiddenRule[] = [
  {
    label: 'write-capable pr subcommand (array form)',
    pattern: /['"]pr['"]\s*,\s*['"](?:create|merge|close|reopen|edit|review|comment|ready|lock|unlock)['"]/gi,
  },
  {
    label: 'write-capable pr subcommand (literal)',
    pattern: /\bpr\s+(?:create|merge|close|reopen|edit|review|comment|ready|lock|unlock)\b/gi,
  },
  {
    label: 'request method override (array form)',
    pattern: /['"]--?(?:X|method)['"]/gi,
  },
  {
    label: 'request method override (literal)',
    pattern: /\bapi\s+(?:-X|--method)\b/gi,
  },
  {
    label: 'repo mutation (array form)',
    pattern: /['"]repo['"]\s*,\s*['"](?:edit|delete|rename|archive|transfer)['"]/gi,
  },
];

const READ_ONLY_COMMAND = /['"]pr['"]\s*,\s*['"](?:view|list|checks|status|diff)['"]/i;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found.sort();
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

describe('scm read-only guard', () => {
  const files = sourceFiles(SCM_SRC);

  it('scans every scm source file', () => {
    expect(files.length).toBeGreaterThan(0);
    const names = files.map((file) => path.basename(file));
    expect(names).toContain('gh-cli.ts');
    expect(names).toContain('observe.ts');
  });

  it('contains no write-capable gh invocation', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const rule of FORBIDDEN) {
        for (const match of source.matchAll(rule.pattern)) {
          const index = match.index ?? 0;
          offenders.push(
            `${path.relative(SCM_SRC, file)}:${lineOf(source, index)} [${rule.label}] ${match[0]}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still issues the read-only commands the guard is guarding', () => {
    // Positive control: if someone renames the directory or the grep stops
    // reading real command text, the guard above would silently pass. This
    // asserts the text it is looking for is actually there.
    const combined = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(READ_ONLY_COMMAND.test(combined)).toBe(true);
  });
});
