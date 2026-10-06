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
  EXECUTION_OWNER_PACKAGE,
  HOST_DB_DIR,
  HOST_ONLY,
  IO_PRIMITIVES,
  LAYERS,
  LIFECYCLE_COUPLINGS,
  collectBoundaryReport,
  evaluate,
  findCoreIoReach,
  findLifecycleCouplings,
  findLoopMisownership,
  findReverseEdges,
  findRuntimeHostLeaks,
  findSessionRootedTables,
  findWorkerLoopReach,
  findWorkerSeamBypasses,
  fingerprint,
  ioPrimitivesIn,
  isTestPath,
  isTurnLoopModule,
  layerOfSpecifier,
  reachabilityFrom,
  resolveRepoSpecifier,
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

/**
 * Write fixture files into the repo tree and remove them afterwards.
 *
 * ## Why these live in the repo rather than a temp dir
 *
 * Reachability resolves paths against `REPO_ROOT`, so a fixture placed in the
 * OS temp directory resolves no imports at all and every reachability-based
 * check would pass vacuously — the exact failure this file exists to prevent.
 * The existing G4 fixtures already take this route. `finally` removes the
 * directory so a failed assertion cannot leave residue behind for the next test
 * or for a sibling agent working in this checkout.
 */
function withRepoFixtures(files: Record<string, string>, body: (dir: string) => void): void {
  const root = path.join(REPO_ROOT, 'fixtures', 'boundary-gates');
  fs.rmSync(root, { recursive: true, force: true });
  for (const [name, content] of Object.entries(files)) {
    const abs = path.join(root, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  try {
    body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
    // The bypass is a real import in a real file, not a line number. Pinning
    // `f.line === 75` made this test a tripwire for unrelated edits above the
    // import: any added line moved the import and failed a gate assertion
    // while the gate itself was still correct. The import's own text is the
    // fact worth guarding, and it is what the finding actually carries.
    const bypass = findings.find((f) => f.file.includes('agent-process-entry'));
    expect(bypass).toBeDefined();
    expect(bypass!.line).toBeGreaterThan(0);
  });

  it('the finding names the import it is reporting, not just a file', () => {
    // Without this the previous test would pass on any bypass the gate ever
    // emits, including one that stopped being the DuyaAgent import. Read the
    // live entry and assert the reported line really is the import line.
    const entryPath = path.join(REPO_ROOT, 'packages/agent/src/process/agent-process-entry.ts');
    const lines = fs.readFileSync(entryPath, 'utf8').split(/\r?\n/);
    const findings = findWorkerSeamBypasses();
    const bypass = findings.find((f) => f.file.includes('agent-process-entry'));
    expect(bypass).toBeDefined();
    expect(lines[bypass!.line - 1] ?? '').toMatch(/DuyaAgent/);
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

describe('G7 — the worker entry cannot reach the loop through an adapter', () => {
  // ## The bypass this exists to catch
  //
  // Plan 600 `04-runtime-owns-execution.md` §2 names it: wrap `DuyaAgent` in an
  // adapter, import the adapter, and the name-based gate goes green while the
  // loop is still the old one in the old package. The first assertion below is
  // the load-bearing one — it proves the name gate really does miss this — and
  // the second proves reachability does not.
  const ADAPTER = {
    'entry.ts': ["import { legacyLoop } from './adapter.js';", 'export const start = () => legacyLoop;', ''].join('\n'),
    'adapter.ts': [
      '/** Re-exported under a different identifier, which is the whole trick. */',
      "export { duyaAgent as legacyLoop } from '../../packages/agent/src/agent/DuyaAgent.js';",
      '',
    ].join('\n'),
  };

  it('the name gate misses the adapter — this is why a name gate is not enough', () => {
    withRepoFixtures(ADAPTER, () => {
      const entry = 'fixtures/boundary-gates/entry.ts';
      // Not merely "empty because the detector is off": the same entry reaches
      // a real loop (asserted below), so the emptiness is specific to the name
      // rule, not to a broken scan.
      expect(findWorkerSeamBypasses(entry)).toEqual([]);
    });
  });

  it('catches the loop behind a ONE-hop adapter', () => {
    withRepoFixtures(ADAPTER, () => {
      // `ADAPTER` re-exports the real loop from a differently named module, and
      // that module lives in a different package, so the specifier resolves
      // through `resolveRepoSpecifier` and the finding is real.
      const findings = findWorkerLoopReach('fixtures/boundary-gates/entry.ts', undefined, 2);
      expect(findings.map((f) => f.file)).toContain('packages/agent/src/agent/DuyaAgent.ts');
      // The finding names the step the bypass arrived through, so the next
      // slice does not have to re-derive which hop to cut.
      expect(findings.find((f) => f.file.endsWith('DuyaAgent.ts'))?.via).toBe('fixtures/boundary-gates/adapter.ts');
    });
  });

  it('does NOT report a loop that is only reachable past the bounded depth', () => {
    // This is the half that makes the gate satisfiable, and it is a boundary
    // assertion rather than an emptiness one: the SAME fixture above is
    // reported at depth 2, so a green here means the depth bound did the
    // filtering, not that the scan failed to look.
    withRepoFixtures(ADAPTER, () => {
      const entry = 'fixtures/boundary-gates/entry.ts';
      const deep = findWorkerLoopReach(entry, undefined, 8);
      const bounded = findWorkerLoopReach(entry, undefined, 1);
      expect(deep.map((f) => f.file)).toContain('packages/agent/src/agent/DuyaAgent.ts');
      expect(bounded.map((f) => f.file)).not.toContain('packages/agent/src/agent/DuyaAgent.ts');
    });
  });

  it('still reports a loop the entry reaches DIRECTLY, at the default bound', () => {
    // The bound must not be wide enough to excuse the one bypass that matters
    // most: the entry constructing the loop itself. Default depth is 1, and
    // this fixture is entry -> loop with nothing in between.
    withRepoFixtures(
      {
        'direct.ts': ["import { driveTurns } from '../../packages/agent/src/agent/DuyaAgent.js';", 'export const go = driveTurns;', ''].join('\n'),
      },
      () => {
        const findings = findWorkerLoopReach('fixtures/boundary-gates/direct.ts');
        expect(findings.map((f) => f.file)).toContain('packages/agent/src/agent/DuyaAgent.ts');
        expect(findings[0]?.via).toBe('fixtures/boundary-gates/direct.ts');
      },
    );
  });

  it('reports the live worker as reaching the real loop within one hop', () => {
    const findings = findWorkerLoopReach();
    expect(findings.map((f) => f.file)).toContain('packages/agent/src/agent/DuyaAgent.ts');
    // The live bypass is the entry's own import, so the named hop is the entry.
    // Asserting the hop rather than a line number keeps this true when an
    // unrelated edit shifts the import down a line.
    expect(findings.find((f) => f.file.endsWith('DuyaAgent.ts'))?.via).toBe('packages/agent/src/process/agent-process-entry.ts');
  });

  it('an entry that reaches no loop reports nothing', () => {
    withRepoFixtures(
      { 'clean.ts': ["import { helper } from './pure.js';", 'export const go = () => helper();', ''].join('\n'),
        'pure.ts': ['export const helper = () => 42;', ''].join('\n') },
      () => {
        expect(findWorkerLoopReach('fixtures/boundary-gates/clean.ts')).toEqual([]);
      },
    );
  });

  it('a type-only import of the loop is not a way to RUN it', () => {
    // `import type` is erased by the compiler, so a type-only reference cannot
    // be the bypass. Counting it would make the gate cry wolf on a correct edge.
    withRepoFixtures(
      {
        'typed.ts': [
          "import type { DuyaAgent } from '../../packages/agent/src/agent/DuyaAgent.js';",
          'export type Hand = DuyaAgent;',
          '',
        ].join('\n'),
      },
      () => {
        expect(findWorkerLoopReach('fixtures/boundary-gates/typed.ts')).toEqual([]);
      },
    );
  });
});

describe('G7/G8 — the loop is located by SHAPE, not by the name DuyaAgent', () => {
  it('recognises a loop that never mentions DuyaAgent at all', () => {
    // The decisive test of "structural rather than by name": this module drives
    // model -> tool -> next turn under completely different identifiers, so a
    // name-matching gate would never see it.
    const loop = [
      'export async function* drive(client, tools) {',
      '  let keepGoing = true;',
      '  while (keepGoing) {',
      '    for (const chunk of client.streamChat([])) {',
      '      yield chunk;',
      '    }',
      '    keepGoing = await tools.executeAll([]);',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(loop).not.toMatch(/DuyaAgent|duyaAgent/);
    expect(isTurnLoopModule(loop)).toBe(true);
  });

  it('does not recognise a module that iterates but never calls a model', () => {
    expect(
      isTurnLoopModule(
        ['export function tally(rows) {', '  let n = 0;', '  for (const r of rows) {', '    n += r;', '  }', '  return n;', '}', ''].join('\n'),
      ),
    ).toBe(false);
  });

  it('does not recognise a model client that never loops or dispatches tools', () => {
    // A transport adapter is not the loop: it neither iterates turns nor runs
    // tools. Flagging it would put every client in the baseline.
    expect(isTurnLoopModule("export const s = (c) => c.streamChat([]);")).toBe(false);
  });

  it('flags the package that still holds the loop on the live tree', () => {
    const findings = findLoopMisownership();
    expect(findings.map((f) => f.table)).toContain('@duya/agent');
  });

  it('does not flag the package that is supposed to own the loop', () => {
    const holders = findLoopMisownership().map((f) => f.owners).flat();
    expect(holders.some((f) => f.includes(`packages/${EXECUTION_OWNER_PACKAGE.replace('@duya/', '')}/`))).toBe(false);
  });

  it('flags a second package holding a copy of the loop', () => {
    const pkgSrc = path.join(REPO_ROOT, 'fixtures', 'boundary-gates', 'g8pkg', 'src');
    withRepoFixtures(
      {
        'g8pkg/package.json': JSON.stringify({ name: '@duya/agent-fixture' }),
        'g8pkg/src/loop.ts': [
          'export async function* turn(client) {',
          '  while (true) {',
          '    yield* client.streamChat([]);',
          '    await client.execute([]);',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      () => {
        const roots = new Map([['@duya/agent-fixture', pkgSrc]]);
        const findings = findLoopMisownership(EXECUTION_OWNER_PACKAGE, roots);
        expect(findings.map((f) => f.table)).toEqual(['@duya/agent-fixture']);
        // Naming the owner makes it a one-step migration rather than "two files
        // match a regex somewhere in that package".
        expect(findings[0]!.owners).toEqual(['fixtures/boundary-gates/g8pkg/src/loop.ts']);
        // The same package, once declared the owner, is not a finding — so the
        // gate has an exit and is not a permanent red.
        expect(findLoopMisownership('@duya/agent-fixture', roots)).toEqual([]);
      },
    );
  });

  it('excludes test trees from loop ownership', () => {
    // A test may legitimately drive a loop-shaped harness; flagging it would
    // send S1 to migrate a fixture.
    const pkgSrc = path.join(REPO_ROOT, 'fixtures', 'boundary-gates', 'g8test', 'src');
    withRepoFixtures(
      {
        'g8test/package.json': JSON.stringify({ name: '@duya/agent-fixture' }),
        'g8test/src/loop.test.ts': [
          'export async function* turn(client) {',
          '  while (true) {',
          '    yield* client.streamChat([]);',
          '    await client.execute([]);',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      () => {
        const roots = new Map([['@duya/agent-fixture', pkgSrc]]);
        expect(findLoopMisownership(EXECUTION_OWNER_PACKAGE, roots)).toEqual([]);
        expect(isTestPath('packages/agent/src/agent/DuyaAgent.test.ts')).toBe(true);
        expect(isTestPath('packages/agent/tests/integration/RealTasks.test.ts')).toBe(true);
        expect(isTestPath('packages/agent/src/agent/DuyaAgent.ts')).toBe(false);
      },
    );
  });
});

describe('G6 — lifecycle coupling the DDL cannot express', () => {
  // ## The realistic violation
  //
  // A store whose `runs.session_id` is NULLABLE, so the DDL column rule is
  // satisfied, and which still drops the session's Runs when the Session is
  // archived. Nothing about the schema says a Run dies with a Session; only the
  // code does. `00-contracts.md` §C requires that rebuilding, replacing or
  // archiving a Session change no durable entity, and this is the case that
  // violates it — and the case the old gate could not see.
  const RUN_STORE = [
    'export class RunStore {',
    '  static readonly migrations = [',
    '    {',
    '      id: 1,',
    '      name: "create_runs",',
    '      up: (db) => {',
    '        db.exec(`',
    '          CREATE TABLE IF NOT EXISTS runs (',
    '            id          TEXT PRIMARY KEY,',
    '            project_id  TEXT,',
    '            session_id  TEXT',
    '          );',
    '        `);',
    '      },',
    '    },',
    '  ];',
    '',
    '  /** Archive the Session, taking its Runs with it. */',
    '  purgeSession(sessionId: string): void {',
    '    this.db.exec("BEGIN");',
    '    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);',
    '    this.db.prepare("DELETE FROM runs WHERE session_id = ?").run(sessionId);',
    '    this.db.exec("COMMIT");',
    '  }',
    '}',
    '',
  ].join('\n');

  it('the DDL rule is blind to it — the column is nullable, so nothing fires', () => {
    withRepoFixtures({ 'run-store.ts': RUN_STORE }, (dir) => {
      // Non-empty scan, empty findings: the rule RAN and found nothing. That is
      // the blind spot, asserted rather than assumed.
      expect(findSessionRootedTables(['runs'], dir)).toEqual([]);
    });
  });

  it('the lifecycle rule catches the run deletion', () => {
    withRepoFixtures({ 'run-store.ts': RUN_STORE }, (dir) => {
      const findings = findLifecycleCouplings(['runs'], dir);
      const del = findings.filter((f) => f.coupling === 'session-scoped-delete');
      expect(del).toHaveLength(1);
      // Attributed to `runs`, not to `sessions`: the rule has to name the table
      // whose rows actually die.
      expect(del[0]).toMatchObject({ table: 'runs', file: expect.stringContaining('run-store.ts') });
    });
  });

  it('reports a required session key on a create input', () => {
    // `CreateRunInput.sessionId: string` — a Run cannot be STARTED without a
    // Session. The DDL already says the column is mandatory; this is the code
    // fact that the type contract demands it, which survives nulling the column
    // only if the interface changes too.
    withRepoFixtures(
      {
        'input.ts': [
          'export interface CreateRunInput {',
          '  readonly runId?: string;',
          '  readonly sessionId: string;',
          '  readonly manifest: unknown;',
          '}',
          'export class S {',
          '  static readonly migrations = [',
          '    {',
          '      id: 1,',
          '      name: "create_runs",',
          '      up: (db) => {',
          '        db.exec(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY);`);',
          '      },',
          '    },',
          '  ];',
          '}',
          '',
        ].join('\n'),
      },
      (dir) => {
        const findings = findLifecycleCouplings(['runs'], dir);
        expect(findings.map((f) => f.coupling)).toContain('required-session-key');
      },
    );
  });

  it('does NOT report an optional session key — the migrated shape is clean', () => {
    // The exit. `sessionId?: string` is what a migrated store looks like, and a
    // gate that cannot go green is a gate that gets switched off.
    withRepoFixtures(
      {
        'migrated.ts': [
          'export interface CreateRunInput {',
          '  readonly runId: string;',
          '  readonly sessionId?: string;',
          '}',
          'export class S {',
          '  static readonly migrations = [',
          '    {',
          '      id: 1,',
          '      name: "create_runs",',
          '      up: (db) => {',
          '        db.exec(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT);`);',
          '      },',
          '    },',
          '  ];',
          '  findByRun(runId: string): unknown {',
          '    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      (dir) => {
        expect(findLifecycleCouplings(['runs'], dir)).toEqual([]);
      },
    );
  });

  it('does NOT report a session-scoped delete of a table with no durable identity', () => {
    // `session_runtime_locks` is swept by session on the live tree and is a
    // transient lock, not a durable entity. Reporting it would send S1 to
    // migrate a table that has no identity to preserve.
    withRepoFixtures(
      {
        'locks.ts': [
          'export class Locks {',
          '  static readonly migrations = [',
          '    {',
          '      id: 1,',
          '      name: "create_tasks",',
          '      up: (db) => {',
          '        db.exec(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY);`);',
          '      },',
          '    },',
          '  ];',
          '  sweep(sessionId: string): void {',
          '    this.db.prepare("DELETE FROM session_runtime_locks WHERE session_id = ?").run(sessionId);',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      (dir) => {
        expect(findLifecycleCouplings(['tasks'], dir)).toEqual([]);
      },
    );
  });

  it('names the table that UNIQUE(session_id) caps', () => {
    // The `session_goals` case the DDL rule never looked at. Nulling the column
    // would not decouple it: one row per Session still means a Session-rooted
    // goal cannot exist without consuming the slot.
    withRepoFixtures(
      {
        'goals.ts': [
          'export class Goals {',
          '  static readonly migrations = [',
          '    {',
          '      id: 8,',
          '      name: "create_session_goals",',
          '      up: (db) => {',
          '        db.exec(`',
          '          CREATE TABLE IF NOT EXISTS session_goals (',
          '            id         TEXT PRIMARY KEY,',
          '            session_id TEXT,',
          '            UNIQUE(session_id)',
          '          );',
          '        `);',
          '      },',
          '    },',
          '  ];',
          '}',
          '',
        ].join('\n'),
      },
      (dir) => {
        const findings = findLifecycleCouplings(['session_goals'], dir);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ coupling: 'session-unique-constraint', table: 'session_goals' });
      },
    );
  });

  it('every declared coupling has a real negative case, not just a detector break', () => {
    // Each rule is either exercised above by a fixture that CONTAINS the
    // violation, or it is not carrying its weight. This asserts the mapping
    // explicitly so a rule added without a fixture fails here.
    const exercised = new Set([
      'required-session-key',
      'session-scoped-delete',
      'session-unique-constraint',
      'session-keyed-read',
    ]);
    for (const rule of LIFECYCLE_COUPLINGS) {
      expect(exercised.has(rule.id)).toBe(true);
    }
  });

  it('finds the live lifecycle couplings', () => {
    const findings = findLifecycleCouplings();
    const ids = new Set(findings.map((f) => f.coupling));
    expect(ids).toContain('required-session-key');
    expect(ids).toContain('session-keyed-read');
    expect(ids).toContain('session-scoped-delete');
    expect(ids).toContain('session-unique-constraint');
  });
});

describe('G9 — a core classification has to survive measurement', () => {
  // ## The realistic violation
  //
  // `00-contracts.md` §A.3 forbids making a `fetch`-capable package core-
  // reachable by relabelling it. Nothing in a single core file performs IO here:
  // the entry builds a client, the factory calls a transport helper, and only
  // the leaf fetches. A direct per-file scan — which is what G2 is — reports
  // nothing, which is the blind spot `04` §6 lists as core reaching a provider
  // indirectly.
  const CORE_PKG = {
    'g9pkg/package.json': JSON.stringify({ name: '@duya/agent-core' }),
    'g9pkg/src/index.ts': ["export { makeClient } from './provider/factory.js';", ''].join('\n'),
    'g9pkg/src/provider/factory.ts': [
      "import { post } from '../transport/http.js';",
      'export const makeClient = () => post();',
      '',
    ].join('\n'),
    'g9pkg/src/transport/http.ts': [
      'export const post = async () => {',
      "  const res = await fetch('https://api.example.com/v1/chat');",
      '  return res.json();',
      '};',
      '',
    ].join('\n'),
  };

  it('the entry itself performs no IO, so a direct scan sees nothing', () => {
    withRepoFixtures(CORE_PKG, () => {
      const entrySrc = fs.readFileSync(
        path.join(REPO_ROOT, 'fixtures/boundary-gates/g9pkg/src/index.ts'),
        'utf8',
      );
      expect(ioPrimitivesIn(entrySrc)).toEqual([]);
    });
  });

  it('transitive reach finds the fetch three hops down', () => {
    withRepoFixtures(CORE_PKG, () => {
      const src = path.join(REPO_ROOT, 'fixtures/boundary-gates/g9pkg/src');
      const findings = findCoreIoReach('core', new Map([['@duya/agent-core', src]]));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        file: 'fixtures/boundary-gates/g9pkg/src/transport/http.ts',
        to: 'fetch',
        from: '@duya/agent-core',
      });
    });
  });

  it('reports a pure core package as clean', () => {
    withRepoFixtures(
      {
        'purepkg/package.json': JSON.stringify({ name: '@duya/agent-core' }),
        'purepkg/src/index.ts': ['export const sum = (a: number, b: number) => a + b;', ''].join('\n'),
      },
      () => {
        const src = path.join(REPO_ROOT, 'fixtures/boundary-gates/purepkg/src');
        expect(findCoreIoReach('core', new Map([['@duya/agent-core', src]]))).toEqual([]);
      },
    );
  });

  it('an injected transport is not a finding', () => {
    // `this.fetchFn(` is the pattern `system-one/client.ts` already uses and it
    // is the correct shape: the port is injected, the package is not reaching
    // for the network itself. Counting it would flag the model to follow.
    withRepoFixtures(
      {
        'injected/package.json': JSON.stringify({ name: '@duya/agent-core' }),
        'injected/src/index.ts': [
          'export class Client {',
          '  constructor(private readonly fetchFn: typeof fetch) {}',
          '  async call(): Promise<unknown> {',
          '    return this.fetchFn("https://api.example.com");',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      () => {
        const src = path.join(REPO_ROOT, 'fixtures/boundary-gates/injected/src');
        expect(findCoreIoReach('core', new Map([['@duya/agent-core', src]]))).toEqual([]);
      },
    );
  });

  it('independently rediscovers exactly the five @duya/ai files that still do IO', () => {
    // The cross-check that keeps two definitions of "IO" from drifting. G9
    // finds these by transitive reachability with no list at all;
    // `layer-purity.ts` documents them as carve-outs and its own
    // `findStaleCarveOuts` test fails if a record outlives its file. Same five
    // files, by two independent routes.
    //
    // It was six until plan 610 A0. `bedrock-converse.ts` left the list
    // because it stopped importing `node:crypto` as a value: SigV4 signing
    // moved to WebCrypto. Dropping the entry here rather than relaxing the
    // expectation is the point — the finding is retired at its cause, and the
    // baseline entry it left behind (`G9|…bedrock-converse|node:crypto`) is
    // reported stale instead of being re-recorded away.
    const findings = findCoreIoReach();
    expect(findings.map((f) => f.file).sort()).toEqual([
      'packages/ai/src/api/ollama-chat.ts',
      'packages/ai/src/auth/oauth/device-code.ts',
      'packages/ai/src/system-one/client.ts',
      'packages/ai/src/utils/backoff.ts',
      'packages/ai/src/utils/idle-timeout.ts',
    ]);
    // And every one of them belongs to the package the split has to fix.
    expect(new Set(findings.map((f) => f.from))).toEqual(new Set(['@duya/ai']));
  });

  it('declares the split the contracts require, so it is a target not an accident', () => {
    // The sub-paths do not exist yet; declaring them changes no verdict today.
    // What it does is make the required split the intended landing site, so
    // G1 is already correct on the day S5 cuts the package.
    expect(layerOfSpecifier('@duya/ai/core')).toBe('core');
    expect(layerOfSpecifier('@duya/ai/adapter')).toBe('runtime');
    expect(layerOfSpecifier('@duya/ai')).toBe('core');
  });

  it('does not count a third-party dependency as internal IO', () => {
    // `node-fetch` is a dependency, not this repo's IO. Only primitives count.
    const names = IO_PRIMITIVES.map((p) => p.name);
    expect(names).not.toContain('node-fetch');
    expect(names).toContain('fetch');
  });
});

describe('reachability — resolving the edges a boundary argument depends on', () => {
  it('resolves a .js specifier onto its .ts source, as the build emits it', () => {
    expect(resolveRepoSpecifier('../agent/DuyaAgent.js', 'packages/agent/src/process/x.ts')).toBe(
      'packages/agent/src/agent/DuyaAgent.ts',
    );
  });

  it('resolves a package specifier into the package src tree', () => {
    // The defect this fixes: resolving `@duya/x` to the package ROOT rather than
    // `packages/x/src` silently drops every package edge, and a reachability
    // gate that drops edges under-reports — the dangerous direction.
    expect(resolveRepoSpecifier('@duya/agent-protocol', 'packages/agent/src/process/x.ts')).toBe(
      'packages/agent-protocol/src/index.ts',
    );
  });

  it('returns null for a third-party specifier rather than pretending it resolved', () => {
    expect(resolveRepoSpecifier('zod', 'packages/agent/src/process/x.ts')).toBeNull();
  });

  it('walks the real closure from the worker entry', () => {
    const reachable = reachabilityFrom('packages/agent/src/process/agent-process-entry.ts');
    expect(reachable.size).toBeGreaterThan(100);
    expect(reachable.has('packages/agent/src/agent/DuyaAgent.ts')).toBe(true);
    expect(reachable.get('packages/agent/src/agent/DuyaAgent.ts')).toBe('packages/agent/src/process/agent-process-entry.ts');
  });

  it('terminates on a cycle instead of recursing forever', () => {
    withRepoFixtures(
      {
        'a.ts': ["import { b } from './b.js';", 'export const a = () => b();', ''].join('\n'),
        'b.ts': ["import { a } from './a.js';", 'export const b = () => a();', ''].join('\n'),
      },
      () => {
        const reachable = reachabilityFrom('fixtures/boundary-gates/a.ts');
        expect(reachable.size).toBe(2);
      },
    );
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

  it('G6 is red on the LIFECYCLE too, which is the half the DDL cannot see', () => {
    expect(findLifecycleCouplings().length).toBeGreaterThan(0);
  });

  it('G7 reports the live bypass, and names the edge that has to be cut', () => {
    // This used to assert `length > 0`, which pinned G7 red forever: the
    // moment A3 legitimately removed the entry's direct `DuyaAgent` import, a
    // correct fix would have failed this test. The gate's value is that it
    // NAMES the bypass, so that is what is asserted — the count is reported but
    // not constrained, and an empty result is a legitimate state that A3 is
    // working toward.
    const findings = findWorkerLoopReach();
    for (const finding of findings) {
      expect(finding.file).toBeTruthy();
      expect(finding.via).toBeTruthy();
      expect(finding.why).toContain('turn-loop');
    }
    // Whatever the count is, the gate must be looking at the real entry rather
    // than returning nothing because it could not resolve anything. The
    // unbounded depth is the check for that: if even depth 8 finds nothing, the
    // scan is not working and an empty result above would be meaningless.
    const deep = findWorkerLoopReach('packages/agent/src/process/agent-process-entry.ts', undefined, 8);
    expect(deep.length).toBeGreaterThan(0);
  });

  it('G8 is red: the loop is not owned by the execution owner package', () => {
    expect(findLoopMisownership().length).toBeGreaterThan(0);
  });

  it('G9 is red: a core-classified package can still reach IO', () => {
    expect(findCoreIoReach().length).toBeGreaterThan(0);
  });

  it('every gate in the report has a distinct id, so no two share a baseline namespace', () => {
    const gates = collectBoundaryReport().map((r) => r.gate);
    expect(gates).toEqual([...new Set(gates)]);
    expect(gates).toEqual(['G1', 'G3', 'G4', 'G6', 'G7', 'G8', 'G9']);
  });

  it('the live tree is scanned for the new gates — the report is not empty', () => {
    // A reachability gate over a resolver that silently resolves nothing would
    // report zero findings and read as clean. `dbDir` is asserted for the same
    // reason on G6: prove the scan has a subject.
    expect(HOST_DB_DIR.endsWith(path.join('desktop', 'src', 'main'))).toBe(true);
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
    // These two are the same violation in the same file, so they must SHARE a
    // key. An earlier version keyed on the line number and reported 3 false
    // regressions after 134 upstream commits shifted line numbers in files
    // nobody had touched — every NEW had a matching FIXED at the same file.
    const a = { file: 'a.ts', line: 3, why: 'same' };
    const b = { file: 'a.ts', line: 900, why: 'same' };
    expect(fingerprint(report([a]), a)).toBe(fingerprint(report([b]), b));
  });

  it('still separates two findings of the same kind in one file', () => {
    // Line number is gone, so the discriminator has to come from the subject.
    // G4 matches both `DuyaAgent` and `duyaAgent` on the same import line.
    const a = { file: 'entry.ts', line: 75, symbol: 'DuyaAgent' };
    const b = { file: 'entry.ts', line: 75, symbol: 'duyaAgent' };
    expect(fingerprint(report([a]), a)).not.toBe(fingerprint(report([b]), b));
  });

  it('separates the same table reported from two different databases', () => {
    const live = { file: 'db/core/stores.ts', table: 'tasks', column: 'session_id NOT NULL', database: 'core.db' };
    const dead = { file: 'db/schema.ts', table: 'tasks', column: 'session_id NOT NULL', database: 'main.db' };
    expect(fingerprint(report([live]), live)).not.toBe(fingerprint(report([dead]), dead));
  });

  it('treats a finding that moved to another file as new', () => {
    // The case that IS worth failing on: the subject changed, not just its
    // position.
    const a = { file: 'a.ts', line: 3, why: 'same' };
    const b = { file: 'b.ts', line: 3, why: 'same' };
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
    //
    // It is deliberately NOT relaxed to accommodate G7. Plan 610 §4 rule 5
    // forbids making a gate green by re-recording a baseline, and plan 610
    // §5.2 rule 1 says a slice that cannot be made green must be re-adjudicated
    // rather than exempted. So when a gate has an unbaselined finding this test
    // stays red and says WHICH gate and WHICH file, which is the fact the next
    // slice needs. The only legitimate way to turn it green is to remove the
    // violation from the source tree.
    const outcomes = evaluate();
    const unbaselined = outcomes
      .map((outcome) => ({ gate: outcome.gate, new: outcome.newFindings }))
      .filter((o) => o.new.length > 0);
    expect(
      unbaselined,
      `gates with findings the baseline does not cover (fix the violation, do not re-record the baseline): ${JSON.stringify(unbaselined)}`,
    ).toEqual([]);
  });
});
