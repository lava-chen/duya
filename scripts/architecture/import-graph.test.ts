/**
 * import-graph.test.ts — the resolver the M5.1 map is built on.
 *
 * ## Why the type/value split needs its own tests
 *
 * Everything downstream inherits this classification: the cut list is a list of
 * VALUE edges, and the inventory's category counts assume the resolver finds
 * the files the audits find. If the split is wrong in the direction that
 * matters, the cut list is wrong — and a cut list that calls a type-only edge a
 * runtime dependency sends M5.2 to delete something the build needs.
 *
 * So the split is tested against real statements, including the ones that make
 * it hard: a type-only import and a value import in the SAME file, an
 * `export type` re-export, a dynamic `import()`, a `require()`, and a
 * commented-out import that must not be seen at all.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SPECIFIER_CLASS,
  importsOf,
  isTypeOnlyStatement,
  ownerOf,
  resolveTarget,
  tarjan,
  ROOT,
} from './import-graph.mjs';

describe('the specifier class is shared, not retyped', () => {
  it('is the same literal the two audit scripts use', () => {
    // G0.3 records that hand-copied `[^"']` literals let a match span CR/LF and
    // produced a false violation that differed per platform. This is the third
    // consumer, so the copies are compared rather than trusted.
    //
    // The check builds the SAME regex the scripts build and compares its source
    // text, which is exact: a divergence in any character fails here. The
    // scripts inline the class rather than importing it, which is the thing
    // being policed.
    const canonical = String.raw`/(?:from\s+|import\s*\(|require\s*\()\s*["']([^"'\r\n]+)["']/g`;
    for (const file of ['audit-imports.mjs', 'audit-modules.mjs', 'verify-cycle.mjs', 'validate-scc.mjs']) {
      const src = readFileSync(path.join(ROOT, 'scripts/architecture', file), 'utf8');
      // A literal substring search, not a re-derived regex: the scripts write
      // the pattern as source text, so the honest comparison is between that
      // text and ours. `includes` cannot silently agree with itself.
      expect({ file, containsCanonical: src.includes(canonical) }).toEqual({
        file,
        containsCanonical: true,
      });
    }
  });

  it('refuses a specifier that spans a line break', () => {
    // The regression the G0.3 fix was for, asserted directly: a match must not
    // open inside a string and close on a later line.
    const nasty = "const s = 'rename from ';\n    else if (x.startsWith(`";
    const found = [...nasty.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*["']([^"'\r\n]+)["']/g)];
    for (const f of found) expect(f[1]).not.toContain('\n');
  });
});

describe('type-only statements are told apart from value statements', () => {
  it('reads an import type as a type edge', () => {
    const src = "import type { X } from './x.js';\n";
    expect(importsOfVia(src)).toEqual([{ spec: './x.js', typeOnly: true }]);
  });

  it('reads an export type re-export as a type edge', () => {
    const src = "export type { X } from './x.js';\n";
    expect(importsOfVia(src)).toEqual([{ spec: './x.js', typeOnly: true }]);
  });

  it('reads a plain import as a value edge', () => {
    const src = "import { x } from './x.js';\n";
    expect(importsOfVia(src)).toEqual([{ spec: './x.js', typeOnly: false }]);
  });

  it('does not match a bare side-effect import, exactly as the audits do not', () => {
    // A real, SHARED limitation, asserted rather than hidden.
    // `(?:from\s+|import\s*\(|require\s*\()` has no alternative for
    // `import './register.js'`, so the two audit scripts miss it too. Changing
    // that here would make this resolver disagree with the counts the
    // architecture gate is baselined on, which is a larger change than M5.1 is
    // allowed to make silently.
    //
    // MEASURED, not assumed: `Select-String '^\s*import\s+['"]'` over
    // `packages/**` and `apps/**` returns ZERO matches, so no file in the tree
    // depends on this. The form is recorded here so that if it ever appears,
    // this test is the place that says the graph is now missing an edge.
    const src = "import './register.js';\n";
    expect(importsOfVia(src)).toEqual([]);
  });

  it('reads a dynamic import as a value edge', () => {
    // `import('y')` emits a real load, whatever the binding is used for.
    const src = "const m = await import('./lazy.js');\n";
    expect(importsOfVia(src)).toEqual([{ spec: './lazy.js', typeOnly: false }]);
  });

  it('reads a require as a value edge', () => {
    const src = "const m = require('./cjs.js');\n";
    expect(importsOfVia(src)).toEqual([{ spec: './cjs.js', typeOnly: false }]);
  });

  it('does not let a type-only import vouch for a later value import', () => {
    // The window bug this guards: without cutting the window at the previous
    // statement, the `import type` at the top would classify the value import
    // at the bottom as type-only, and the cut list would call a live runtime
    // dependency erasable.
    const src = "import type { A } from './a.js';\nimport { b } from './b.js';\n";
    expect(importsOfVia(src)).toEqual([
      { spec: './a.js', typeOnly: true },
      { spec: './b.js', typeOnly: false },
    ]);
  });

  it('ignores an import inside a comment', () => {
    // `strip-comments.mjs` exists because a doc comment quoting `from '...'`
    // became a live edge. An edge that is only prose must stay invisible.
    //
    // This goes through the REAL file entry point, not the string helper: the
    // helper deliberately skips the comment stripper (it only exercises the
    // regex and the statement test), so asserting comment behaviour on it would
    // be testing something the production path never does.
    const dir = mkdtempSync(path.join(tmpdir(), 'm51-comments-'));
    const file = path.join(dir, 'probe.ts');
    writeFileSync(
      file,
      "/** see `from './ghost.js'` for details */\nimport { real } from './real.js';\n",
      'utf8',
    );
    try {
      expect(importsOf(file)).toEqual([{ spec: './real.js', typeOnly: false }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errs toward value when it cannot tell', () => {
    // Documented bias: a false `value` costs an entry to investigate, a false
    // `type` deletes a live dependency. Assert the direction, not a value.
    expect(isTypeOnlyStatement("const x = 1;", 5)).toBe(false);
  });
});

describe('the SCC pass agrees with the one it was copied from', () => {
  it('groups a three-node cycle and leaves a tree alone', () => {
    const graph = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
      ['d', new Set(['a'])],
    ]);
    const sccs = tarjan(graph);
    expect(sccs).toHaveLength(1);
    expect([...sccs[0]].sort()).toEqual(['a', 'b', 'c']);
  });

  it('reports nothing for an acyclic graph', () => {
    const graph = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set()],
    ]);
    expect(tarjan(graph)).toEqual([]);
  });
});

describe('owners and targets resolve the way the audits resolve them', () => {
  it('labels each host boundary', () => {
    expect(ownerOf('apps/desktop/src/main/ipc/x.ts')).toBe('electron-main');
    expect(ownerOf('apps/desktop/src/renderer/components/x.tsx')).toBe('src-renderer');
    expect(ownerOf('apps/desktop/src/preload/index.ts')).toBe('electron-preload');
    expect(ownerOf('packages/agent/src/index.ts')).toBe('pkg:agent');
  });

  it('resolves a .ts specifier written as .js, the way NodeNext does', () => {
    // The repo writes `./x.js` for `./x.ts` everywhere. A resolver that did not
    // know this would report most of the graph as unresolved.
    const target = resolveTarget('./index.js', 'packages/agent-protocol/src/testing/index.ts');
    expect(target).not.toBeNull();
  });

  it('returns null rather than inventing a file', () => {
    expect(resolveTarget('./does-not-exist.js', 'packages/agent/src/index.ts')).toBeNull();
  });
});

/** Classify imports in a source STRING, via the same code path as a real file. */
function importsOfVia(src: string): { spec: string; typeOnly: boolean }[] {
  const out: { spec: string; typeOnly: boolean }[] = [];
  // The module reads files, so the string is fed through the same regex and the
  // same statement test rather than a copy of them.
  const re = new RegExp(
    `(?:from\\s+|import\\s*\\(|require\\s*\\()\\s*["'](${SPECIFIER_CLASS})["']`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out.push({ spec: m[1], typeOnly: isTypeOnlyStatement(src, m.index) });
  }
  return out;
}

// Keep the real file-based entry point referenced so a rename breaks this file.
void importsOf;
