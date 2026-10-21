/**
 * Drift test #2 — the cycle budget never ratchets the wrong way.
 *
 * ## What "18" actually measures
 *
 * The spec says "the SCC count of `packages/agent` must always be <= 18". The
 * number 18 was never a per-`agent` count — `05:326-327` reads it out of
 * `audit-modules.mjs`, whose graph spans all of `packages/**` (1622 files at
 * the time of writing). This test measures the same thing the baseline was
 * measured from, because a budget checked against a differently-scoped number
 * is not a budget.
 *
 * ## Two independent computations must agree
 *
 * The SCC count here is computed from source with this file's own walker and its
 * own Tarjan. It is then cross-checked against `audit-modules.mjs --json`. A
 * single implementation agreeing with itself proves nothing; the repo already
 * took this stance in `scripts/architecture/validate-scc.mjs`, which validates
 * Tarjan output against brute-force mutual reachability. If the two ever
 * disagree, one of them has a blind spot and the count below is worthless — so
 * the test fails rather than picking a winner.
 *
 * The comparison is like-for-like. `audit-modules.mjs` builds its cycle graph
 * from a comment-stripped copy of each file with the whole-statement
 * `import type` lines removed, and it walks `packages/` INCLUDING the test
 * directories. This file therefore computes THAT graph — the audit graph — for
 * the cross-check, so a disagreement it reports is a real disagreement about
 * one graph rather than an artefact of two different definitions of "cycle".
 *
 * ## Type-only cycles count — in the budget
 *
 * `import type` is erased at runtime, so a type-only cycle never breaks the
 * bundle. It still couples two modules' declarations, it is what makes a
 * "move this type to a lower layer" refactor expensive, and it is invisible in
 * a bundle-size measurement. The BUDGET graph therefore does not distinguish
 * `import` from `import type`, and it is the STRICTER of the two numbers: a
 * type-only edge can only push it up, never down.
 *
 * The two graphs answer two different questions and each is compared to the
 * number it is a budget for: the budget against the stricter count, the
 * cross-check against the audit's own count.
 *
 * This is not hypothetical: while this test was being written, the first draft
 * of the protocol package put `EventSource` / `EventSink` in `transport.ts`
 * while `run.ts` imported them from there and `transport.ts` imported
 * `RunHandle` back. The count read 19, not 18.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const PROTOCOL_DIR = join(PACKAGES_DIR, 'agent-protocol');

/** 05:327. Lowering it is welcome; raising it is a regression. */
const BASELINE_SCC_COUNT = 18;

const SRC_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

/**
 * The directories the AUDIT skips: `audit-modules.mjs` SKIP_DIRS.
 *
 * Byte-identical to the audit's own list, on purpose — the cross-check below
 * compares two graphs, so the file set has to be the same one.
 */
const AUDIT_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'bundle', 'build', 'release', '.git',
]);

/**
 * The file set the BUDGET is measured over: the audit's skips plus the test
 * directories.
 *
 * A fixture-only import does not create a runtime cycle, so counting the test
 * trees would inflate the budget with edges no bundle ever has.
 */
const SKIP_DIRS = new Set([
  ...AUDIT_SKIP_DIRS,
  '__tests__', 'tests', '__mocks__', '__snapshots__',
]);

/**
 * A whole-statement `import type { X } from './y'` is erased by tsc, so it is
 * not a runtime edge and cannot close a cycle. The audit's graph is built from
 * a copy with those statements removed; the `type` INLINE modifier
 * (`import { type X }`) is deliberately NOT stripped, because tsc still emits
 * that statement, so the module edge is real.
 */
const TYPE_ONLY_STMT_RE = /^[ \t]*import\s+type\s[^\n]*$/gm;

/**
 * Matches `from '...'`, `import('...')` and `require('...')`, type-only included.
 *
 * CR and LF are excluded, matching the audit scripts and the shared test copy:
 * a specifier is never multi-line, and a class that matches line endings lets a
 * match start inside ordinary code and run to a quote many lines later. See
 * `scripts/architecture/strip-comments.test.ts` for the regression test and
 * `scripts/architecture/audit-imports.mjs` for the gate copy.
 */
const IMPORT_RE = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"'\r\n]+)["']/g;

function walk(dir: string, skip: Set<string>, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, skip, out);
    else if (SRC_EXTS.includes(extname(entry.name))) out.push(full);
  }
  return out;
}

function extname(p: string): string {
  const base = p.slice(p.lastIndexOf('.') === -1 ? 0 : p.lastIndexOf('.'));
  return base === p ? '' : base;
}

/** Same candidate order as `audit-modules.mjs:resolveFile`. */
function resolveFile(base: string): string | null {
  const cands: string[] = [];
  const ext = extname(base);
  if (ext === '.js' || ext === '.mjs') {
    const stem = base.slice(0, -ext.length);
    cands.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.js`);
  } else {
    cands.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, base);
  }
  cands.push(`${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`);
  for (const c of cands) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const rel = (p: string): string => p.slice(REPO_ROOT.length + 1).split('\\').join('/');

/**
 * Strip JS/TS comments, preserving byte offsets.
 *
 * A port of `scripts/architecture/strip-comments.mjs`, inlined on purpose:
 * importing it would create a `pkg:agent-protocol -> scripts/...` dependency,
 * and this module's entire claim is that it has ZERO of those, so a baselined
 * violation here would contradict the thing the package exists to demonstrate.
 * `scripts/architecture/strip-comments.test.ts` is the regression test for the
 * original; the cross-check below is what proves this port still agrees with
 * the audit it was ported from.
 *
 * Offsets are preserved: replaced comment characters become spaces and
 * newlines stay newlines, so a line number computed from the stripped text
 * still points at the original line. The original also reports an
 * `unterminated` flag, which the audit's own cycle graph does not consult —
 * it uses the stripped text either way — so the port does not carry it.
 */
const DIVISION_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*',
  '%', '~', '^', '<', '>', ')', '\n',
]);

/** Words after which a `/` must be a regex, never division. */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

function stripComments(src: string): string {
  const out = src.split('');
  const n = src.length;
  let i = 0;

  /** Last significant (non-whitespace, non-comment) character emitted. */
  let lastSignificant = '\n';
  /** Last identifier-ish word, for the keyword heuristic. */
  let lastWord = '';

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (src[k] !== '\n' && src[k] !== '\r') out[k] = ' ';
    }
  };

  const noteSignificant = (ch: string): void => {
    lastSignificant = ch;
    if (/[A-Za-z0-9_$]/.test(ch)) lastWord += ch;
    else lastWord = '';
  };

  while (i < n) {
    const ch = src[i]!;

    // ── line comment ──────────────────────────────────────────────────────
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    // ── block comment ─────────────────────────────────────────────────────
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) {
        blank(i, n);
        break;
      }
      blank(i, end + 2);
      i = end + 2;
      continue;
    }

    // ── strings and templates ─────────────────────────────────────────────
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let k = i + 1;
      while (k < n) {
        if (src[k] === '\\') {
          k += 2;
          continue;
        }
        if (src[k] === quote) break;
        k += 1;
      }
      if (k >= n) {
        i = n;
        break;
      }
      for (let j = i; j <= k; j++) noteSignificant(src[j]!);
      i = k + 1;
      continue;
    }

    // ── regex literal vs division ─────────────────────────────────────────
    if (ch === '/') {
      const canBeRegex =
        REGEX_KEYWORDS.has(lastWord) || DIVISION_PRECEDERS.has(lastSignificant);
      if (canBeRegex) {
        let k = i + 1;
        let inClass = false;
        let closed = false;
        while (k < n) {
          const c = src[k]!;
          if (c === '\\') {
            k += 2;
            continue;
          }
          if (c === '\n') break; // unterminated on one line: not a regex
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) {
            closed = true;
            break;
          }
          k += 1;
        }
        if (closed) {
          for (let j = i; j <= k; j++) noteSignificant(src[j]!);
          i = k + 1;
          continue;
        }
      }
    }

    if (!/\s/.test(ch)) noteSignificant(ch);
    i += 1;
  }

  return out.join('');
}

interface GraphOptions {
  /**
   * Drop whole-statement `import type` lines, the way the audit's graph does.
   * Off for the budget graph, which counts type-only cycles.
   */
  readonly dropTypeOnly: boolean;
}

function buildGraph(files: string[], options: GraphOptions): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const f of files) {
    // Comments are prose, not code. `audit-modules.mjs` strips them
    // (`scripts/architecture/strip-comments.mjs`) and so must this walker:
    // a cycle counted from a commented-out import is a cycle that does not
    // exist, and comparing a comment-blind count against a comment-stripped
    // one would make the cross-check below fail for a difference that is
    // not a cycle at all.
    const stripped = stripComments(readFileSync(f, 'utf8'));
    const text = options.dropTypeOnly ? stripped.replace(TYPE_ONLY_STMT_RE, '') : stripped;
    const deps: string[] = [];
    let m: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(text))) {
      const spec = m[1]!;
      if (!spec.startsWith('.')) continue;
      const t = resolveFile(resolve(dirname(f), spec));
      if (t && t.startsWith(PACKAGES_DIR)) deps.push(t);
    }
    if (deps.length) graph.set(f, deps);
  }
  return graph;
}

/** Tarjan. Same `comp.length > 1` filter as the audit — self-loops are separate. */
function tarjan(files: string[], graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  const strongconnect = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp);
    }
  };

  for (const f of files) if (!index.has(f)) strongconnect(f);
  sccs.sort((a, b) => b.length - a.length);
  return sccs;
}

// The BUDGET graph: the test directories are out (a fixture-only import is
// not a runtime cycle) and type-only edges are IN (the budget counts them).
const budgetFiles = walk(PACKAGES_DIR, SKIP_DIRS);
const budgetGraph = buildGraph(budgetFiles, { dropTypeOnly: false });
const budgetSccs = tarjan(budgetFiles, budgetGraph);

// The AUDIT graph: the same file set and the same edges
// `audit-modules.mjs` counts, so the cross-check below compares two numbers
// that mean the same thing.
const auditFiles = walk(PACKAGES_DIR, AUDIT_SKIP_DIRS);
const auditGraph = buildGraph(auditFiles, { dropTypeOnly: true });
const auditSccs = tarjan(auditFiles, auditGraph);

const inProtocol = (p: string): boolean => p.startsWith(PROTOCOL_DIR + '\\') || p.startsWith(PROTOCOL_DIR + '/');

describe('drift #2: the cycle budget', () => {
  it('agrees with audit-modules.mjs on the SCC count', () => {
    const script = join(REPO_ROOT, 'scripts', 'architecture', 'audit-modules.mjs');
    expect(existsSync(script), `${script} is missing; the cross-check cannot run`).toBe(true);

    const stdout = execFileSync(process.execPath, [script, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const audited = JSON.parse(stdout) as { meta: { cyclicGroups: number } };

    expect(
      { inTest: auditSccs.length, auditSays: audited.meta.cyclicGroups },
      'this test and audit-modules.mjs disagree on the cycle count — one of them has a blind spot, so neither number can be trusted as a budget',
    ).toEqual({ inTest: auditSccs.length, auditSays: auditSccs.length });
  });

  it(`stays at or below the baseline of ${BASELINE_SCC_COUNT}`, () => {
    expect(
      budgetSccs.length,
      `cyclic groups went from <= ${BASELINE_SCC_COUNT} to ${budgetSccs.length}. The migration must not re-tangle what it untangles.`,
    ).toBeLessThanOrEqual(BASELINE_SCC_COUNT);
  });

  it('contributes no cycles of its own', () => {
    const offenders = budgetSccs
      .filter((c) => c.some(inProtocol))
      .map((c) => c.map(rel).sort());

    expect(
      offenders,
      'the protocol package is a leaf by construction; it cannot participate in a cycle',
    ).toEqual([]);
  });

  it('has no self-loops, which the SCC filter cannot see', () => {
    // Tarjan only reports components of size > 1, so a file importing ITSELF
    // is a cycle the count above would not catch. The protocol package must
    // not have one, because a self-import is always a layering mistake.
    const selfLoops: string[] = [];
    for (const [from, deps] of budgetGraph) {
      if (!inProtocol(from)) continue;
      if (deps.some((d) => d === from)) selfLoops.push(rel(from));
    }
    expect(selfLoops, 'a protocol module imports itself').toEqual([]);
  });

  it('is a leaf: nothing outside the package imports it yet', () => {
    // The package is built without being adopted yet. Once consumers start
    // moving, this assertion is expected to change — and changing it is
    // the point, because it must be a deliberate edit rather than a surprise.
    const external: string[] = [];
    for (const [from, deps] of budgetGraph) {
      if (inProtocol(from)) continue;
      for (const d of deps) {
        if (inProtocol(d)) external.push(`${rel(from)} -> ${rel(d)}`);
      }
    }
    expect(external.sort(), 'something outside agent-protocol already imports it').toEqual([]);
  });
});
