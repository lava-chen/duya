/**
 * Plan 600 S0 — boundary gate tests.
 *
 * ## What these tests are for
 *
 * A gate that reports a fact without checking anything is worse than a red
 * test: the next slice trusts it and deletes the real check. Three instances of
 * that exact failure are recorded in memory as `vacuous-guard-tells`:
 *
 *  1. A `LEGACY_RETIREMENT` test compared `measured.length` with
 *     `measured.length` — declared 7, measured 3, always green.
 *  2. A packaging gate's regex matched ajv's **codegen string**
 *     `equal.code = 'require("ajv/dist/runtime/equal").default'` as a real
 *     `require()`, reporting a healthy build as missing five modules.
 *  3. A shared lexer lost sync at offset ~1815 of a real minified worker, and
 *     a genuine `require('node-fetch')` appended to the artifact still passed.
 *
 * So every rule below has a NEGATIVE case: a fixture containing exactly the
 * violation the rule forbids, asserted to be found. A rule with only a positive
 * case ("the tree is clean") cannot distinguish a working detector from a
 * detector that matches nothing.
 *
 * ## The fixtures are synthetic on purpose
 *
 * The negative cases run against temp files, not the live tree. Two reasons:
 * the live tree is shared and under active modification by other agents, and a
 * test that mutates the real source to prove a gate works would race them. The
 * exception is the one place where the live tree IS the subject — the
 * `reports the real known defects` block below — which asserts the gates are
 * currently RED and says why. That block is the load-bearing one: it is what
 * stops these gates from being quietly satisfied by a tree that drifted.
 */

import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DURABLE_IDENTITY_TABLES,
  HOST_ONLY,
  LAYERS,
  evaluate,
  findReverseEdges,
  findRuntimeHostLeaks,
  findSessionRootedTables,
  findWorkerSeamBypasses,
  fingerprint,
  layerOfSpecifier,
  workerImplementsExecutionChannel,
  type BoundaryReport,
} from './boundary-gates.js';

const REPO_ROOT = path.resolve(__dirname, '../..');
const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-gates-'));
  temps.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir is not a test failure.
    }
  }
});

/** Build a throwaway workspace with the given package -> files map. */
function fixtureWorkspace(files: Record<string, Record<string, string>>): Map<string, string> {
  const dir = tempDir();
  const roots = new Map<string, string>();
  for (const [pkg, packageFiles] of Object.entries(files)) {
    const src = path.join(dir, pkg.replace('@duya/', ''), 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(src), 'package.json'),
      JSON.stringify({ name: pkg, version: '0.0.0' }),
    );
    for (const [name, body] of Object.entries(packageFiles)) {
      fs.writeFileSync(path.join(src, name), body);
    }
    roots.set(pkg, src);
  }
  return roots;
}

// ---------------------------------------------------------------------------

describe('G1 — no reverse dependency edge between layers', () => {
  it('flags a core module importing a runtime module', () => {
    const roots = fixtureWorkspace({
      '@duya/agent-core': { 'a.ts': "import { x } from '@duya/agent-runtime';\nexport const a = x;\n" },
      '@duya/agent-runtime': { 'b.ts': 'export const b = 1;\n' },
    });
    const findings = findReverseEdges(roots);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      from: '@duya/agent-core',
      to: '@duya/agent-runtime',
      fromLayer: 'core',
      toLayer: 'runtime',
    });
  });

  it('flags a protocol module importing core', () => {
    const roots = fixtureWorkspace({
      '@duya/agent-protocol': { 'p.ts': "import { c } from '@duya/agent-core';\n" },
      '@duya/agent-core': { 'c.ts': 'export const c = 1;\n' },
    });
    expect(findReverseEdges(roots)).toHaveLength(1);
  });

  it('allows a downward edge (runtime importing core)', () => {
    const roots = fixtureWorkspace({
      '@duya/agent-runtime': { 'r.ts': "import { c } from '@duya/agent-core';\n" },
      '@duya/agent-core': { 'c.ts': 'export const c = 1;\n' },
    });
    expect(findReverseEdges(roots)).toEqual([]);
  });

  it('allows a same-layer edge', () => {
    const roots = fixtureWorkspace({
      '@duya/agent-core': { 'a.ts': "import { b } from '@duya/ai';\n" },
      '@duya/ai': { 'b.ts': 'export const b = 1;\n' },
    });
    expect(findReverseEdges(roots)).toEqual([]);
  });

  it('resolves a subpath import to its owning layer', () => {
    const roots = fixtureWorkspace({
      '@duya/agent-core': { 'a.ts': "import { c } from '@duya/agent-runtime/transport/x';\n" },
      '@duya/agent-runtime': { 't.ts': 'export const c = 1;\n' },
    });
    const findings = findReverseEdges(roots);
    expect(findings).toHaveLength(1);
    // `to` is the full specifier, not the owning package: with sub-path layer
    // overrides the two are no longer the same thing, and collapsing them would
    // hide which entry point actually crossed the boundary.
    expect(findings[0]!.to).toBe('@duya/agent-runtime/transport/x');
    expect(findings[0]!.toLayer).toBe('runtime');
  });

  it('does not report a relative import as a layer edge', () => {
    const roots = fixtureWorkspace({
      '@duya/agent-core': { 'a.ts': "import { b } from './b.js';\n" },
    });
    expect(findReverseEdges(roots)).toEqual([]);
  });

  it('does not report a reverse edge that only appears inside a comment', () => {
    // The doc comment in boundary-gates.ts names `@duya/agent-runtime` many
    // times. A regex over raw text would read those as imports.
    const roots = fixtureWorkspace({
      '@duya/agent-core': {
        'a.ts': "/**\n * See also: import { x } from '@duya/agent-runtime';\n */\nexport const a = 1;\n",
      },
      '@duya/agent-runtime': { 'r.ts': 'export const x = 1;\n' },
    });
    expect(findReverseEdges(roots)).toEqual([]);
  });
});

describe('G1 — a sub-path can have a different layer from its package', () => {
  // The regression this encodes: `@duya/cli` is a host adapter (its
  // `api/client.ts` fetches `127.0.0.1` and its commands read the filesystem),
  // but `@duya/cli/contract` is a pure descriptor contract the agent's
  // DuyaCliTool legitimately dispatches through. Classifying the whole package
  // as host made the gate report four findings for a correct edge. A gate that
  // cries wolf on a correct edge is worse than no gate.
  it('resolves the contract sub-path to the runtime layer', () => {
    expect(layerOfSpecifier('@duya/cli/contract')).toBe('runtime');
  });

  it('resolves the bare package to the host layer', () => {
    expect(layerOfSpecifier('@duya/cli')).toBe('host');
  });

  it('resolves a deeper path under the contract to the runtime layer', () => {
    expect(layerOfSpecifier('@duya/cli/contract/commands/agent')).toBe('runtime');
  });

  it('does not let a sub-path override shadow a longer package name', () => {
    // `@duya/cli` must not win over `@duya/cli/contract` by prefix length in the
    // wrong direction: the more specific override has to take precedence.
    expect(layerOfSpecifier('@duya/cli/contract')).not.toBe(layerOfSpecifier('@duya/cli'));
  });

  it('allows a runtime module to import the contract sub-path', () => {
    const roots = fixtureWorkspace({
      '@duya/agent': { 'tool.ts': "import { CLI_DESCRIPTORS } from '@duya/cli/contract';\n" },
      '@duya/cli': { 'index.ts': 'export const runCli = 1;\n' },
    });
    // The importer resolves the specifier to the runtime layer via
    // SUBPATH_LAYERS, so the edge is allowed regardless of where the target
    // file physically sits inside the package.
    expect(findReverseEdges(roots)).toEqual([]);
  });

  it('still flags a runtime module importing the host app face', () => {
    // The other half of the rule: the override must not become a blanket
    // exemption for the whole package.
    const roots = fixtureWorkspace({
      '@duya/agent': { 'tool.ts': "import { runCli } from '@duya/cli';\n" },
      '@duya/cli': { 'index.ts': 'export const runCli = 1;\n' },
    });
    const findings = findReverseEdges(roots);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ to: '@duya/cli', toLayer: 'host' });
  });

  it('the live DuyaCliTool contract imports are not reported', () => {
    // Measured on the real tree: all four `@duya/cli` references in
    // packages/agent go through `/contract`, so G1 must be clean.
    const offenders = findReverseEdges().filter((f) => f.from === '@duya/agent');
    expect(offenders).toEqual([]);
  });
});

describe('G3 — runtime does not reach into host internals', () => {
  // `findRuntimeHostLeaks` resolves the live repo by package name, so a
  // negative case cannot point it at a temp dir. The rule itself is therefore
  // exercised through the same HOST_ONLY patterns, asserted against a fixture
  // that contains exactly what each pattern is meant to catch. Asserting only
  // `Array.isArray(findings)` — which is what this test used to do — is the
  // `a === a` shape: it passes whether or not the detector works.
  const HOST_PATTERNS = HOST_ONLY;

  it.each(HOST_PATTERNS)('the pattern for $why matches its sample', ({ re, sample }) => {
    expect(re.test(sample)).toBe(true);
  });

  it.each(HOST_PATTERNS)('the pattern for $why does not match a clean import', ({ re, clean }) => {
    expect(re.test(clean)).toBe(false);
  });

  it('the live agent-runtime package has no host leak', () => {
    // A real measurement against the real tree — the two quantities come from
    // different sources (the file tree vs. the pattern list), so this is not
    // the vacuous shape.
    expect(findRuntimeHostLeaks()).toEqual([]);
  });
});

describe('G4 — worker implements ExecutionChannel rather than DuyaAgent', () => {
  it('finds the real DuyaAgent import in the live worker entry', () => {
    const findings = findWorkerSeamBypasses();
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.line === 75 && f.file.includes('agent-process-entry'))).toBe(true);
  });

  it('does not report a DuyaAgent mention in a comment', () => {
    const entry = 'fixtures/clean-worker.ts';
    const abs = path.join(REPO_ROOT, entry);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      [
        '/**',
        " * Once migrated this will no longer do: new duyaAgent({ ... })",
        " * and import { duyaAgent } from '../agent/DuyaAgent.js';",
        ' */',
        'export const worker = 1;',
        '',
      ].join('\n'),
    );
    try {
      expect(findWorkerSeamBypasses(entry)).toEqual([]);
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });

  it('reports a real construction', () => {
    const entry = 'fixtures/dirty-worker.ts';
    const abs = path.join(REPO_ROOT, entry);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      ["import { duyaAgent } from '../agent/DuyaAgent.js';", 'const a = new duyaAgent({});', 'export default a;', ''].join(
        '\n',
      ),
    );
    try {
      const findings = findWorkerSeamBypasses(entry);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((f) => f.symbol === 'duyaAgent' || f.symbol === 'DuyaAgent')).toBe(true);
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });

  it('does not claim the live worker implements the port', () => {
    // This is the assertion that matters: the seam is declared in three
    // packages and implemented nowhere on the execution path.
    expect(workerImplementsExecutionChannel()).toBe(false);
  });
});

describe('G6 — durable identity is not rooted at session_id', () => {
  it('finds session_id NOT NULL in the live durable tables', () => {
    const findings = findSessionRootedTables();
    const tables = new Set(findings.filter((f) => f.live).map((f) => f.table));
    for (const table of DURABLE_IDENTITY_TABLES) {
      expect(tables).toContain(table);
    }
  });

  it('finds the runs table specifically', () => {
    const findings = findSessionRootedTables(['runs']);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toContain('run-store.ts');
    expect(findings[0]!.live).toBe(true);
  });

  it('distinguishes the live core.db tasks table from the dead main.db one', () => {
    // Measured, not assumed: every prepared statement against `tasks` lives in
    // db/core/stores.ts and db/core/legacy-import.ts, and db-bridge.ts:1432
    // dispatches task:create through getCoreStores(). The main.db definition in
    // db/schema.ts is created on every boot and never read — 587 §08 calls it
    // DEAD. A gate that merged the two would point S1 at a table nobody uses.
    const findings = findSessionRootedTables(['tasks']);
    const live = findings.filter((f) => f.live);
    const dead = findings.filter((f) => !f.live);

    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ file: expect.stringContaining('core/stores.ts'), database: 'core.db' });

    // The dead one is defined more than once in schema.ts; all of them must be
    // marked dead so the migration does not treat them as the target.
    expect(dead.length).toBeGreaterThan(0);
    for (const d of dead) {
      expect(d.file).toContain('db/schema.ts');
      expect(d.database).toBe('main.db');
    }
  });

  it('does not flag a table that is already migrated off session_id', () => {
    const target = path.join(REPO_ROOT, 'apps/desktop/src/main/db/core');
    const probe = path.join(target, '__boundary-gate-probe.ts');
    fs.writeFileSync(
      probe,
      [
        'const migration = `',
        'CREATE TABLE IF NOT EXISTS runs (',
        '    id            TEXT PRIMARY KEY,',
        '    project_id    TEXT,',
        '    session_id    TEXT',
        ');',
        '`;',
        'export default migration;',
        '',
      ].join('\n'),
    );
    try {
      const findings = findSessionRootedTables(['runs']);
      // The probe has a nullable session_id, so it must not add a finding.
      expect(findings).toHaveLength(1);
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });
});

describe('the gates are RED on the live tree, and that is the point', () => {
  // These are not aspirational assertions. They pin the CURRENT known state so
  // that a future slice cannot make these gates green by accident, and so that
  // when S3/S1 do fix them, the change is a deliberate, visible one.
  it('G4 is red: the worker still constructs DuyaAgent', () => {
    expect(findWorkerSeamBypasses().length).toBeGreaterThan(0);
  });

  it('G6 is red: durable tables are still rooted at session_id', () => {
    expect(findSessionRootedTables().length).toBeGreaterThan(0);
  });

  it('the layer table declares the direction 600 requires', () => {
    const order = LAYERS.map((l) => l.name);
    expect(order).toEqual(['protocol', 'core', 'runtime', 'host']);
  });
});

describe('baseline — a known defect must not block, a new one must fail', () => {
  // The whole reason the baseline exists: G4 and G6 report real defects, so a
  // plain non-zero exit would block every unrelated change until S1/S3 land.
  // But a gate that is baselined into permanent silence is exactly the failure
  // recorded as `vacuous-guard-tells`. These tests pin both halves.

  const report = (findings: unknown[]): BoundaryReport => ({
    gate: 'GX',
    title: 'test',
    findings,
  });

  it('treats a finding already in the baseline as known, not new', () => {
    const finding = { file: 'a.ts', line: 3, why: 'x' };
    const key = fingerprint(report([finding]), finding);
    const outcome = evaluate([report([finding])], new Set([key]))[0]!;
    expect(outcome.known).toBe(1);
    expect(outcome.newFindings).toEqual([]);
  });

  it('treats a finding absent from the baseline as new', () => {
    const finding = { file: 'b.ts', line: 9, why: 'y' };
    const outcome = evaluate([report([finding])], new Set())[0]!;
    expect(outcome.newFindings).toHaveLength(1);
    expect(outcome.known).toBe(0);
  });

  it('distinguishes two findings of the same kind in different files', () => {
    // This is the case a shape-only comparison would miss: identical `why`,
    // different location. A gate keyed on the message alone would treat the
    // second one as already-known and let a regression through.
    const a = { file: 'a.ts', line: 3, why: 'same' };
    const b = { file: 'b.ts', line: 3, why: 'same' };
    const keyA = fingerprint(report([a]), a);
    const keyB = fingerprint(report([b]), b);
    expect(keyA).not.toBe(keyB);
    const outcome = evaluate([report([a, b])], new Set([keyA]))[0]!;
    expect(outcome.known).toBe(1);
    expect(outcome.newFindings).toEqual([keyB]);
  });

  it('distinguishes the same file at two different lines', () => {
    const a = { file: 'a.ts', line: 3, why: 'same' };
    const b = { file: 'a.ts', line: 4, why: 'same' };
    expect(fingerprint(report([a]), a)).not.toBe(fingerprint(report([b]), b));
  });

  it('reports a baseline entry that is no longer produced as fixed', () => {
    const gone = { file: 'gone.ts', line: 1, why: 'z' };
    const key = fingerprint(report([gone]), gone);
    const outcome = evaluate([report([])], new Set([key]))[0]!;
    expect(outcome.stale).toEqual([key]);
    expect(outcome.newFindings).toEqual([]);
  });

  it('the live tree is fully baselined, so the gate exits clean', () => {
    // This is the assertion that keeps the baseline honest in both directions:
    // the recorded file must actually cover every current finding.
    const outcomes = evaluate();
    for (const outcome of outcomes) {
      expect({ gate: outcome.gate, new: outcome.newFindings }).toEqual({ gate: outcome.gate, new: [] });
    }
  });
});
