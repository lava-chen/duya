/**
 * Drift test #2 — the cycle budget never ratchets the wrong way.
 *
 * Design source: 07-agent-protocol-spec.md §15 (#2), §16.2. Baseline: 05:327.
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
 * ## Type-only cycles count
 *
 * `import type` is erased at runtime, so a type-only cycle never breaks the
 * bundle. It still couples two modules' declarations, it is what makes a
 * "move this type to a lower layer" refactor expensive, and it is invisible in
 * a bundle-size measurement. The walker therefore does not distinguish `import`
 * from `import type`.
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

/** Byte-identical to `audit-modules.mjs` SKIP_DIRS_IN_MODULES, on purpose. */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'bundle', 'build', 'release', '.git',
  '__tests__', 'tests', '__mocks__', '__snapshots__',
]);

/** Matches `from '...'`, `import('...')` and `require('...')`, type-only included. */
const IMPORT_RE = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
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

function buildGraph(files: string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const f of files) {
    // KNOWN LIMITATION, deliberate: this walker does not strip comments, while
    // `audit-modules.mjs` does (`scripts/architecture/strip-comments.mjs`). It
    // shares the lexer when it can — importing it would create a
    // `pkg:agent-protocol -> scripts/...` dependency, and this module's entire
    // claim is that it has ZERO of those, so a baselined violation here would
    // contradict the thing the package exists to demonstrate.
    //
    // The cost is bounded and the failure is loud, not silent: if a
    // commented-out import ever lands inside a cycle, the two sides disagree
    // and the cross-check below fails with a message that names the blind
    // spot. That is the intended behaviour of this test.
    const text = readFileSync(f, 'utf8');
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

const files = walk(PACKAGES_DIR);
const graph = buildGraph(files);
const sccs = tarjan(files, graph);
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
      { inTest: sccs.length, auditSays: audited.meta.cyclicGroups },
      'this test and audit-modules.mjs disagree on the cycle count — one of them has a blind spot, so neither number can be trusted as a budget',
    ).toEqual({ inTest: sccs.length, auditSays: sccs.length });
  });

  it(`stays at or below the baseline of ${BASELINE_SCC_COUNT}`, () => {
    expect(
      sccs.length,
      `cyclic groups went from <= ${BASELINE_SCC_COUNT} to ${sccs.length}. 07 §16.2: M2-M11 must not re-tangle what M1 untangles.`,
    ).toBeLessThanOrEqual(BASELINE_SCC_COUNT);
  });

  it('contributes no cycles of its own', () => {
    const offenders = sccs
      .filter((c) => c.some(inProtocol))
      .map((c) => c.map(rel).sort());

    expect(
      offenders,
      'the protocol package is a leaf by construction (07 §1); it cannot participate in a cycle',
    ).toEqual([]);
  });

  it('has no self-loops, which the SCC filter cannot see', () => {
    // Tarjan only reports components of size > 1, so a file importing ITSELF
    // is a cycle the count above would not catch. The protocol package must
    // not have one, because a self-import is always a layering mistake.
    const selfLoops: string[] = [];
    for (const [from, deps] of graph) {
      if (!inProtocol(from)) continue;
      if (deps.some((d) => d === from)) selfLoops.push(rel(from));
    }
    expect(selfLoops, 'a protocol module imports itself').toEqual([]);
  });

  it('is a leaf: nothing outside the package imports it yet', () => {
    // PP-1 builds the package without adopting it. Once PP-2 starts moving
    // consumers, this assertion is expected to change — and changing it is
    // the point, because it must be a deliberate edit rather than a surprise.
    const external: string[] = [];
    for (const [from, deps] of graph) {
      if (inProtocol(from)) continue;
      for (const d of deps) {
        if (inProtocol(d)) external.push(`${rel(from)} -> ${rel(d)}`);
      }
    }
    expect(external.sort(), 'something outside agent-protocol already imports it').toEqual([]);
  });
});
