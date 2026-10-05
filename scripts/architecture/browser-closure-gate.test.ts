/**
 * browser-closure-gate.test.ts — the two directions gate G10 has to satisfy.
 *
 * ## A gate with one direction does not exist
 *
 * 610 §4 rule 2: "每条门禁必须做变异证明:制造它要防的那种回归 → 确认变红 →
 * 完全回退 → 确认树干净。" A detector that only ever returns findings is
 * indistinguishable from a detector that is broken, and a detector that only
 * ever returns nothing is indistinguishable from one that cannot look.
 *
 * So the fixtures below are asserted in BOTH directions, and the live tree is
 * asserted green with a non-zero walked count. The `ok = 0, bad = 0` shape —
 * a green report that walked nothing — is the failure this file exists to make
 * impossible, and the first draft of the gate had exactly that bug:
 * `import-graph.mjs`'s `resolveTarget` maps `@duya/ai` to the package ROOT, so
 * a closure built on it followed no cross-package edge and the one Node module
 * in the tree sat happily outside it.
 *
 * ## Every assertion compares two different sources
 *
 * The expected values are literals or counts measured from a fixture; the
 * actual values are read from the live tree. Nothing here asserts a quantity
 * against itself.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ROOT } from './import-graph.mjs';
import {
  BROWSER_ENTRIES,
  browserClosure,
  collectBrowserClosureReport,
  isBrowserClosureClean,
  isNodeBuiltinSpecifier,
  seedsFor,
} from './browser-closure-gate.mjs';
import type { BrowserClosureReport } from './browser-closure-gate.ts';

/**
 * The fixture lives INSIDE the renderer tree.
 *
 * `mutation-proof-a1.mjs` records why that matters: a fixture parked outside
 * every scanned root produces an EMPTY closure from the start, and the gate
 * then reports "nothing found" no matter what the fixture contains. Pointing
 * this gate at a subdirectory of the real entry keeps the walk real. The
 * directory name is not itself a seed of `apps/desktop/src/renderer`, so the
 * live-tree assertions below are unaffected while the fixture exists, and it is
 * removed in a `finally` either way.
 */
const FIXTURE = 'apps/desktop/src/renderer/__g10_fixture__';
const FIXTURE_ENTRY = `${FIXTURE}/entry.ts`;

function writeFixture(files: Record<string, string>): void {
  const dir = path.join(ROOT, FIXTURE);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body, 'utf8');
  }
}

function dropFixture(): void {
  rmSync(path.join(ROOT, FIXTURE), { recursive: true, force: true });
}

/**
 * The fixture entry is a single FILE, not the fixture directory.
 *
 * With a directory entry every fixture file is a seed, so every finding's `via`
 * is `null` by construction and the parent map is never exercised. A file entry
 * makes `entry -> hop-chain -> hop-terminal` a real edge, which is what lets the
 * assertion below check that a finding names the hop to sever.
 */
function reportForFixture(): BrowserClosureReport {
  return collectBrowserClosureReport([{ rel: FIXTURE_ENTRY, kind: 'file' }]);
}

describe('G10 goes RED on a Node built-in attached to a renderer-shaped entry', () => {
  it('reports both the node: and the bare spelling of the same built-in', () => {
    // Two hops, because a gate that only inspects the entry's own imports would
    // pass this. `node:fs` and bare `fs` are separate hops precisely so that a
    // detector anchored on `node:` alone is caught here rather than in
    // production: `packages/plugin-core/src/security/path-validator.ts` writes
    // `import fs from 'fs'`, and a `node:`-only scan calls that file clean.
    writeFixture({
      'entry.ts': [
        "export { viaPrefixed } from './hop-prefixed.js';",
        "export { viaBare } from './hop-bare.js';",
        "export { viaTypeOnly } from './hop-type-only.js';",
        "export { viaChain } from './hop-chain.js';",
        '',
      ].join('\n'),
      'hop-prefixed.ts': "import { readFileSync } from 'node:fs';\nexport const viaPrefixed = readFileSync;\n",
      'hop-bare.ts': "import { resolve } from 'path';\nexport const viaBare = resolve;\n",
      'hop-type-only.ts':
        "import type { Hash } from 'node:crypto';\nexport type viaTypeOnly = Hash;\n",
      'hop-chain.ts': "export { terminal } from './hop-terminal.js';\n",
      'hop-terminal.ts': "import { createHash } from 'node:crypto';\nexport const terminal = createHash;\n",
    });
    try {
      const report = reportForFixture();
      expect(isBrowserClosureClean(report)).toBe(false);

      const valueSpecs = report.findings.map((f) => f.spec).sort();
      // The four value imports, from three distinct hops plus one two-hop
      // chain. `fs`/`path` are here because bare specifiers count.
      expect(valueSpecs).toEqual(['node:crypto', 'node:fs', 'path']);

      // The type-only hop is reported, and NOT as a finding.
      expect(report.typeOnlyBuiltins.map((f) => f.spec)).toEqual(['node:crypto']);
      expect(report.findings.some((f) => f.file.endsWith('hop-type-only.ts'))).toBe(false);

      // A finding names the edge to sever, not just the module it landed in.
      const chained = report.findings.find((f) => f.spec === 'node:crypto');
      expect(chained?.file).toBe(`${FIXTURE}/hop-terminal.ts`);
      expect(chained?.via).toBe(`${FIXTURE}/hop-chain.ts`);
      expect(chained?.from).toBe(FIXTURE_ENTRY);

      // Non-vacuous: the walk really opened the fixture's modules. One seed,
      // six files in the closure, so five edges were followed.
      expect(report.walked).toBe(6);
      expect(report.entries).toEqual([
        { rel: FIXTURE_ENTRY, seeds: 1, closure: 6 },
      ]);
    } finally {
      dropFixture();
    }
  });

  it('is GREEN on the same fixture with the Node hops removed', () => {
    // The negative direction. Without it, the assertion above could pass
    // because the gate reports a finding for any input at all.
    writeFixture({
      'entry.ts': "export { kept } from './hop-clean.js';\n",
      'hop-clean.ts': "export const kept = 1;\n",
    });
    try {
      const report = reportForFixture();
      expect(report.findings).toEqual([]);
      expect(isBrowserClosureClean(report)).toBe(true);
      // Still walked something, so this green is not the `0/0` shape.
      expect(report.walked).toBe(2);
    } finally {
      dropFixture();
    }
  });
});

describe('G10 on the live tree', () => {
  const report = collectBrowserClosureReport();

  it('is green, and reports the scope the verdict is about', () => {
    expect(report.findings).toEqual([]);
    expect(isBrowserClosureClean(report)).toBe(true);
    // The scope is named, not implied: 610 §4 rule 1 forbids a bare count.
    expect(report.scope).toBe('apps/desktop/src/renderer');
    expect(report.summary).toBe(`0/${report.walked} Node built-ins in apps/desktop/src/renderer`);
  });

  it('walked hundreds of files, so green is not "inspected nothing"', () => {
    // A floor, not an exact count: the renderer grows, and a test that pinned
    // 789 would fail on every added component without anything regressing.
    // The point is only that the walk opened a large first-party graph.
    expect(report.walked).toBeGreaterThan(500);
    expect(report.entries[0].seeds).toBeGreaterThan(100);
  });

  it('reaches across a package boundary, which is where the Node module was', () => {
    // The regression G10 exists for lived in `@duya/ai`, behind exactly one
    // package boundary. A walk that stopped at the package edge would report 0
    // findings and be right by accident; this asserts the boundary is crossed
    // by looking for a first-party workspace file in the closure, resolved from
    // a specifier rather than from the seed list.
    const closure = browserClosure(seedsFor('apps/desktop/src/renderer') ?? []);
    const crossed = [...closure.keys()].filter((f) => f.startsWith('packages/'));
    expect(crossed.length).toBeGreaterThan(50);
    expect(crossed).toContain('packages/conductor/src/renderer/index.ts');
  });

  it('names the web entry as absent rather than skipping it silently', () => {
    // 610 §4 names `apps/web/src/main.tsx` as an entry. It does not exist yet,
    // and the honest report is "absent", not silence — the day the skeleton
    // lands, this assertion is the one that has to be revisited.
    expect(BROWSER_ENTRIES.map((e) => e.rel)).toContain('apps/web/src/main.tsx');
    expect(report.absentEntries).toContain('apps/web/src/main.tsx');
    expect(seedsFor('apps/web/src/main.tsx')).toBeNull();
  });
});

describe('the built-in matcher is not a `node:` search', () => {
  it('accepts both spellings, and rejects a real package', () => {
    for (const spec of ['node:fs', 'node:worker_threads', 'fs', 'path', 'os', 'child_process', 'better-sqlite3']) {
      expect({ spec, matched: isNodeBuiltinSpecifier(spec) }).toEqual({ spec, matched: true });
    }
    // A third-party package named like a relative path must not match, and
    // neither must anything under `@duya/`.
    for (const spec of ['zod', 'react', '@duya/ai', './fs', 'fs-extra', 'node-fetch', 'path-to-regexp']) {
      expect({ spec, matched: isNodeBuiltinSpecifier(spec) }).toEqual({ spec, matched: false });
    }
  });
});

describe('the gate reads the tree, not a fixture it left behind', () => {
  it('has no fixture directory on disk', () => {
    // If a previous run's fixture survived, every live-tree count above would
    // be measured against a polluted tree and still look green.
    expect(existsSync(path.join(ROOT, FIXTURE))).toBe(false);
  });
});
