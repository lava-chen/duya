/**
 * worker-module-state-gate.test.ts — teeth, counterexamples and a blind guard.
 *
 * The gate is a ratchet whose clean answer is "no new fingerprints". Zero is
 * also the answer of a scanner that parsed nothing, a metafile that vanished,
 * or an AST walker that only ever sees function bodies. Every case below has
 * both halves: a POSITIVE that must be caught and a COUNTEREXAMPLE that must
 * not be, plus a real-tree assertion that the live scan is not blind.
 *
 * The virtual-repo mutation at the end is the important one. It starts from a
 * clean worker source, adds exactly one module-level `let`, and demands the
 * verdict turn red; without it, a collector edited into `fingerprints: []`
 * would pass every other case here.
 */

import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import {
  BASELINE,
  METAFILE,
  collectWorkerModuleState,
  compareModuleState,
  evaluateModuleState,
  findingsInSource,
  workerSourceInputs,
} from './worker-module-state-gate.mjs';

const REPO_ROOT = path.resolve(__dirname, '../..');

describe('findingsInSource', () => {
  it('catches module-level let/var, mutable collections and non-readonly statics', () => {
    const found = findingsInSource('fixture.ts', `
      let alpha = 1;
      var beta = 2;
      export let gamma = 3;
      const delta = new Map<string, number>();
      const epsilon = new Set([1]) as Set<number>;
      const zeta = new WeakMap<object, number>();
      class Holder {
        static count = 0;
        static readonly KEY = 'k';
      }
    `);
    expect(found.map((f) => f.name)).toEqual([
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'Holder.count',
    ]);
    expect(found.find((f) => f.name === 'delta')?.kind).toBe('collection');
  });

  it('does NOT mistake locals, scalars, strings, comments or regexes for module state', () => {
    // The counterexample is the reason this gate parses an AST. This tree ships
    // prompt templates and gate regexes that literally contain `let x = ...`;
    // a text scan would report them and the baseline would be meaningless.
    const found = findingsInSource('fixture.ts', `
      const scalar = 1;
      const list = [1, 2, 3];
      const config = { a: 1 };
      const text = 'let fake = 1; const bogus = new Map()';
      const template = \`let alsoFake = 2; const alsoBogus = new Set()\`;
      // let commented = new Map();
      /* var blockCommented = 3; */
      const matcher = /let regexFake/g;
      function local() { let inner = 1; const innerMap = new Map(); return inner; }
      class C { method() { let methodLocal = 1; } static readonly fixed = new Map(); }
      for (let i = 0; i < 1; i += 1) {}
      type Alias = { let: string };
    `);
    expect(found).toEqual([]);
  });
});

describe('workerSourceInputs', () => {
  it('scans first-party sources only, never tests, declarations or dependencies', () => {
    const metafile = { inputs: {
      'packages/host/src/a.ts': {},
      'packages/host/src/b.tsx': {},
      'packages/host/src/c.d.ts': {},
      'packages/host/src/__tests__/a.test.ts': {},
      'packages/host/src/a.test.ts': {},
      'packages/host/dist/a.js': {},
      'packages/host/node_modules/dep/index.ts': {},
      'node_modules/dep/index.js': {},
      'apps/desktop/src/main.ts': {},
      'packages/host/src/gone.ts': {},
    } };
    const present = new Set(['packages/host/src/a.ts', 'packages/host/src/b.tsx']);
    expect(workerSourceInputs(metafile, REPO_ROOT, (p) => present.has(path.relative(REPO_ROOT, p).split(path.sep).join('/'))))
      .toEqual(['packages/host/src/a.ts', 'packages/host/src/b.tsx']);
  });
});

describe('evaluateModuleState', () => {
  const clean = { files: ['packages/host/src/a.ts'], fingerprints: ['packages/host/src/a.ts#x'], error: null };
  const baseline = { version: 1, fingerprints: ['packages/host/src/a.ts#x'] };

  it('passes an unchanged tree and welcomes shrinking debt', () => {
    expect(evaluateModuleState(clean, baseline).ok).toBe(true);
    const shrunk = { ...clean, fingerprints: [] };
    const verdict = evaluateModuleState(shrunk, baseline);
    expect(verdict.ok).toBe(true);
    expect(verdict.removed).toEqual(['packages/host/src/a.ts#x']);
  });

  it('fails on new state and names it', () => {
    const grown = { ...clean, fingerprints: [...clean.fingerprints, 'packages/host/src/a.ts#y'] };
    const verdict = evaluateModuleState(grown, baseline);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe(1);
    expect(verdict.added).toEqual(['packages/host/src/a.ts#y']);
    expect(compareModuleState(grown, baseline).removed).toEqual([]);
  });

  it('treats a blind scan as an ENGINE failure, not a clean verdict', () => {
    const blind = { files: [], fingerprints: [], error: null };
    const verdict = evaluateModuleState(blind, baseline);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe(2);
    expect(verdict.reason).toContain('blind');
    const missingMetafile = { files: [], fingerprints: [], error: `missing ${METAFILE}; worker scope is unknown` };
    expect(evaluateModuleState(missingMetafile, baseline).code).toBe(2);
  });

  it('refuses to ratchet against a missing baseline', () => {
    expect(evaluateModuleState(clean, null).code).toBe(1);
    expect(evaluateModuleState(clean, { version: 1 }).reason).toContain(BASELINE);
  });
});

/** A repo that exists only in memory: no temp files, no cleanup, no flakes. */
function virtualRepo(files: Record<string, string>) {
  const root = path.resolve(os.tmpdir(), 'worker-module-state-gate-fixture');
  const relative = (absolute: string): string => path.relative(root, absolute).split(path.sep).join('/');
  return {
    repoRoot: root,
    exists: (absolute: string) => Object.prototype.hasOwnProperty.call(files, relative(absolute)),
    readFile: (absolute: string) => {
      const key = relative(absolute);
      if (!Object.prototype.hasOwnProperty.call(files, key)) throw new Error(`missing ${key}`);
      return files[key];
    },
  };
}

describe('collectWorkerModuleState', () => {
  const metafile = JSON.stringify({ inputs: { 'packages/host/src/a.ts': {} } });

  it('turns RED when one module-level let is added to a clean worker source', () => {
    const cleanFiles = { [METAFILE]: metafile, 'packages/host/src/a.ts': 'const stable = 1;\n' };
    const before = virtualRepo(cleanFiles);
    const cleanReport = collectWorkerModuleState({ ...before });
    expect(cleanReport.files).toEqual(['packages/host/src/a.ts']);
    expect(cleanReport.fingerprints).toEqual([]);

    const mutatedFiles = { ...cleanFiles, 'packages/host/src/a.ts': 'const stable = 1;\nlet sessionGate = true;\n' };
    const after = virtualRepo(mutatedFiles);
    const dirtyReport = collectWorkerModuleState({ ...after });
    expect(dirtyReport.fingerprints).toEqual(['packages/host/src/a.ts#sessionGate']);
    expect(evaluateModuleState(dirtyReport, { version: 1, fingerprints: cleanReport.fingerprints }).ok).toBe(false);
  });

  it('reports a missing metafile as an error instead of a clean scan', () => {
    const repo = virtualRepo({ 'packages/host/src/a.ts': 'let x = 1;\n' });
    const report = collectWorkerModuleState({ ...repo });
    expect(report.error).toContain(METAFILE);
    expect(evaluateModuleState(report, { version: 1, fingerprints: [] }).code).toBe(2);
  });

  it('is not blind on the live tree and sees the state PR #616 introduced', () => {
    const report = collectWorkerModuleState();
    expect(report.files.length).toBeGreaterThan(1000);
    expect(report.error).toBeNull();
    expect(report.fingerprints).toContain('packages/capabilities/src/file-read-state.ts#defaultReadFirstGateEnabled');
    expect(report.fingerprints).toContain('packages/capabilities/src/file-read-state.ts#readFirstGateBySession');
  });
});
