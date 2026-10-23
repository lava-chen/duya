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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SPECIFIER_CLASS,
  importsOf,
  isTypeOnlyStatement,
  ownerOf,
  resolveTarget,
  tarjan,
  ROOT,
} from './import-graph.mjs';

function assertBarePackageRoot(
  resolver: typeof resolveTarget,
  specifier: string,
  expected: string,
): void {
  expect(resolver(specifier, 'packages/host/src/x.ts')).toBe(expected);
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

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

  it('reads a type-only import whose specifier list is longer than the lookback', () => {
    // Plan 610 T14. The previous implementation cut a fixed 400-character
    // window at the last `;` or `\n}`, so a multi-line `import type` longer than
    // that window lost its head: the last `\n}` was the import's OWN closing
    // brace, the slice began at `"\n} "`, and the statement was reported as a
    // VALUE import.
    //
    // Measured on this tree before the fix: `packages/client-core/src/surface/
    // surface-model.ts:41` is a 22-line `import type` (381 characters from the
    // keyword to the specifier) that was classified value, which inflated that
    // package's value closure from 1 file to 66 by dragging in all of
    // `@duya/agent-protocol`. The erring direction is "closure too large", so it
    // never produced a false pass — but it made a type-only reference look like
    // runtime coupling, which is the distinction every closure gate here rests
    // on.
    const names = Array.from({ length: 40 }, (_, i) => `  Type${i},`);
    const src = `import type {\n${names.join('\n')}\n} from './big.js';\n`;
    expect(src.length).toBeGreaterThan(400);
    expect(importsOfVia(src)).toEqual([{ spec: './big.js', typeOnly: true }]);
  });

  it('still reads a long value import as a value edge', () => {
    // The negative direction for the fix above: a long named-value import must
    // not be swept into "type-only" by a statement-head search that walks too far
    // back. Without this, widening the lookback could make the gate blind in the
    // dangerous direction.
    const names = Array.from({ length: 40 }, (_, i) => `  value${i},`);
    const src = `import {\n${names.join('\n')}\n} from './big.js';\n`;
    expect(src.length).toBeGreaterThan(400);
    expect(importsOfVia(src)).toEqual([{ spec: './big.js', typeOnly: false }]);
  });

  it('does not carry a statement head across a previous statement', () => {
    // The head search must stop at the import it is classifying. A value import
    // followed by a long type-only one: each keeps its own classification, in
    // both orders.
    const names = Array.from({ length: 40 }, (_, i) => `  Type${i},`);
    const longType = `import type {\n${names.join('\n')}\n} from './a.js';\n`;
    const value = "import { b } from './b.js';\n";
    expect(importsOfVia(`${value}${longType}`)).toEqual([
      { spec: './b.js', typeOnly: false },
      { spec: './a.js', typeOnly: true },
    ]);
    expect(importsOfVia(`${longType}${value}`)).toEqual([
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

describe('a bare @duya specifier resolves to the file that declares it', () => {
  // Plan 622 card 01 / 610 T19.
  //
  // The resolver used to map `@duya/<rest>` to `packages/<first segment of
  // rest>` — the subpath DROPPED rather than joined — and then try `<pkg>.ts`
  // and `<pkg>/index.ts`. No package in this repo keeps an entry at its root
  // (every entry is `src/index.ts`), so EVERY bare specifier resolved to
  // `null`: 755 of 755 distinct specifiers on this tree, which is why the
  // slice graph had no cross-package edge at all.

  it('resolves a bare @duya specifier to the file that declares it', () => {
    assertBarePackageRoot(
      resolveTarget,
      '@duya/agent-protocol',
      'packages/agent-protocol/src/index.ts',
    );
  });

  it('keeps the subpath instead of dropping it', () => {
    // The defect was not "one candidate missing" but "the subpath is thrown
    // away", so this is the case that pins the join: the subpath lands under
    // the package's `src/` root, not at the package root.
    expect(resolveTarget('@duya/agent-protocol/testing', 'packages/host/src/x.ts')).toBe(
      'packages/agent-protocol/src/testing/index.ts',
    );
  });

  it('resolves a subpath that only the package exports map names', () => {
    // `@duya/agent-runtime/contextual-user-fragment` lives at
    // `src/context/contextual-user-fragment.ts`, not at
    // `src/contextual-user-fragment.ts`, so joining the subpath under `src/`
    // does not find it — the package's own `exports` map does.
    expect(
      resolveTarget('@duya/agent-runtime/contextual-user-fragment', 'packages/host/src/x.ts'),
    ).toBe('packages/agent-runtime/src/context/contextual-user-fragment.ts');
  });

  it('resolves the root of every workspace package', () => {
    // A package that keeps its entry somewhere other than `src/index.ts` must
    // fail LOUDLY here rather than going silently unresolved, which would hide
    // its edges from the graph the same way the old resolver hid all of them.
    const packagesDir = path.join(ROOT, 'packages');
    const names = readdirSync(packagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(packagesDir, e.name, 'package.json'))
      .filter((p) => existsSync(p))
      .map((p) => JSON.parse(readFileSync(p, 'utf8')).name)
      .filter((n): n is string => typeof n === 'string');
    expect(names.length).toBeGreaterThan(0);
    const unresolved = names.filter((n) => resolveTarget(n, 'packages/host/src/x.ts') === null);
    expect(unresolved).toEqual([]);
  });



  it('fails the bare-root assertion when the src/index.ts candidate is removed (mutation ①)', async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'm51-mutation-1-'));
    const architectureDir = path.join(fixtureRoot, 'scripts/architecture');
    const sourceModule = path.join(ROOT, 'scripts/architecture/import-graph.mjs');
    const sourceHashBefore = sha256(sourceModule);
    const specifier = '@duya/mutation-fixture';
    const expected = 'packages/mutation-fixture/src/index.ts';

    try {
      mkdirSync(architectureDir, { recursive: true });
      for (const name of ['import-graph.mjs', 'strip-comments.mjs', 'workspace-exports.mjs']) {
        copyFileSync(path.join(ROOT, 'scripts/architecture', name), path.join(architectureDir, name));
      }

      const packageRoot = path.join(fixtureRoot, 'packages/mutation-fixture');
      mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
      writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: specifier }), 'utf8');
      writeFileSync(path.join(packageRoot, 'src/index.ts'), 'export {};\n', 'utf8');

      const mutantModule = path.join(architectureDir, 'import-graph.mjs');
      const baseline = await import(`${pathToFileURL(mutantModule).href}?baseline`);
      assertBarePackageRoot(baseline.resolveTarget, specifier, expected);

      const source = readFileSync(mutantModule, 'utf8');
      const indexCandidate = '`${srcRoot}/index.ts`, ';
      expect(source.includes(indexCandidate)).toBe(true);
      writeFileSync(mutantModule, source.replace(indexCandidate, ''), 'utf8');

      const mutant = await import(`${pathToFileURL(mutantModule).href}?mutation`);
      expect(() => assertBarePackageRoot(mutant.resolveTarget, specifier, expected)).toThrow();
      expect(sha256(sourceModule)).toBe(sourceHashBefore);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('returns null for a package that does not exist', () => {
    expect(resolveTarget('@duya/no-such-package', 'packages/host/src/x.ts')).toBeNull();
  });

  it('still separates a type-only bare import from a value bare import', () => {
    // The resolver change must not touch the one distinction this module
    // exists for. A bare specifier that binds a type is erased by the
    // compiler; one that binds a value survives into the bundle.
    const dir = mkdtempSync(path.join(tmpdir(), 'm51-bare-'));
    const file = path.join(dir, 'probe.ts');
    writeFileSync(
      file,
      "import type { X } from '@duya/agent-protocol';\nimport { y } from '@duya/agent-protocol';\n",
      'utf8',
    );
    try {
      expect(importsOf(file)).toEqual([
        { spec: '@duya/agent-protocol', typeOnly: true },
        { spec: '@duya/agent-protocol', typeOnly: false },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
