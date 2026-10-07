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
 * The negative cases run against planted fixtures, not the live tree. Two
 * reasons: the live tree is shared and under active modification by other
 * agents, and a test that mutates the real source to prove a gate works would
 * race them. A live-tree assertion is therefore only ever paired with a
 * CONTROL — a planted fixture carrying the violation, or the real file on the
 * other side of the verdict — so an empty live result can never be confused
 * with a gate that stopped matching. That is the load-bearing discipline: the
 * `the gates pin the CURRENT live state` block below measures the repository
 * as it stands, and every one of its lines proves its detector works before it
 * asserts what that detector currently says.
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
  turnLoopSites,
  WORKER_LOOP_MAX_DEPTH,
  workerImplementsExecutionChannel,
  type BoundaryReport,
} from './boundary-gates.js';
import { stripComments } from './strip-comments.mjs';

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

/**
 * A turn cycle in the shape the detector recognises: one loop body carrying two
 * driven streams, the model leg and the tool leg.
 *
 * It is PLANTED, never borrowed from the live tree. `DuyaAgent.ts` used to hold
 * a real one and several tests below borrowed it, which made every one of them a
 * statement about the repository's CURRENT state rather than about the
 * detector. When the legacy loop was deleted — the work the whole series is for
 * — the detector correctly stopped finding it and those tests went red for
 * having been right. A self-test must not be a second copy of the gate's
 * output: the day the gate turns green, the tests that assert it is red are the
 * ones that break.
 *
 * Named `legacyLoop` and living in its own module under its own directory,
 * which is what the detector has to notice anyway.
 */
const PLANTED_LOOP = [
  'export async function* legacyLoop(tools) {',
  '  let keepGoing = true;',
  '  while (keepGoing) {',
  '    for await (const event of tools.modelStream([])) {',
  '      yield event;',
  '    }',
  '    for await (const outcome of tools.dispatch([])) {',
  '      keepGoing = outcome;',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

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
  //
  // The loop is `PLANTED_LOOP` from the top of this file, not the real
  // `DuyaAgent` — see its docstring for why. `ADAPTER` is the bypass shape:
  // entry -> adapter -> a loop in a differently named module under a
  // differently named directory.
  const ADAPTER = {
    'entry.ts': ["import { legacyLoop } from './adapter.js';", 'export const start = () => legacyLoop;', ''].join('\n'),
    'adapter.ts': [
      '/** Re-exported under a different identifier, which is the whole trick. */',
      "export { legacyLoop } from './legacy-pkg/loop-owner.js';",
      '',
    ].join('\n'),
    'legacy-pkg/loop-owner.ts': PLANTED_LOOP,
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
      // `ADAPTER` re-exports a PLANTED loop from a differently named module,
      // and that module lives in a different directory, so the specifier
      // resolves through `resolveRepoSpecifier` and the finding is real.
      const findings = findWorkerLoopReach('fixtures/boundary-gates/entry.ts', undefined, 2);
      expect(findings.map((f) => f.file)).toContain('fixtures/boundary-gates/legacy-pkg/loop-owner.ts');
      // The finding names the step the bypass arrived through, so the next
      // slice does not have to re-derive which hop to cut.
      expect(findings.find((f) => f.file.endsWith('loop-owner.ts'))?.via).toBe('fixtures/boundary-gates/adapter.ts');
    });
  });

  it('does NOT report a loop that is only reachable past the bounded depth', () => {
    // This is the half that makes the gate satisfiable, and it is a boundary
    // assertion rather than an emptiness one: the SAME fixture above is
    // reported at depth 2, so a green here means the depth bound did the
    // filtering, not that the scan failed to look.
    //
    // The far end of the fixture is the PLANTED loop in `legacy-pkg/`, not
    // the real `DuyaAgent.ts` — for the same reason `ADAPTER` carries its own
    // loop. A depth-8 walk over the live entry now finds nothing anywhere, so
    // pinning `DuyaAgent.ts` here would be pinning the empty set twice and
    // saying nothing about the bound.
    withRepoFixtures(ADAPTER, () => {
      const entry = 'fixtures/boundary-gates/entry.ts';
      const deep = findWorkerLoopReach(entry, undefined, 8);
      const bounded = findWorkerLoopReach(entry, undefined, 1);
      expect(deep.map((f) => f.file)).toContain('fixtures/boundary-gates/legacy-pkg/loop-owner.ts');
      expect(bounded.map((f) => f.file)).not.toContain('fixtures/boundary-gates/legacy-pkg/loop-owner.ts');
      // Both ends are the fixture, so the only thing that differs between the
      // two scans is the depth argument.
      expect(deep.length).toBeGreaterThan(0);
    });
  });

  it('still reports a loop the entry reaches DIRECTLY, at the default bound', () => {
    // The bound must not be wide enough to excuse the one bypass that matters
    // most: the entry constructing the loop itself. Default depth is 1, and
    // this fixture is entry -> loop with nothing in between.
    withRepoFixtures(
      {
        'direct.ts': ["import { legacyLoop } from './loop-owner.js';", 'export const go = legacyLoop;', ''].join('\n'),
        'loop-owner.ts': PLANTED_LOOP,
      },
      () => {
        const findings = findWorkerLoopReach('fixtures/boundary-gates/direct.ts');
        expect(findings.map((f) => f.file)).toContain('fixtures/boundary-gates/loop-owner.ts');
        expect(findings[0]?.via).toBe('fixtures/boundary-gates/direct.ts');
      },
    );
  });

  it('checks the entry ITSELF at depth 0, and reports it when the entry is the loop', () => {
    // Depth 0 used to be skipped by a bare `if (file === entryRel) continue`,
    // with nothing recording why the process root — the one module whose job is
    // to drive the loop — was exempt from the gate about driving the loop. It is
    // now a subject like any other, and the skip is gone.
    withRepoFixtures(
      {
        'self.ts': [
          'export async function* worker(request, tools) {',
          '  let keepGoing = true;',
          '  while (keepGoing) {',
          '    for await (const event of tools.modelStream([])) {',
          '      yield event;',
          '    }',
          '    for await (const outcome of tools.dispatch([])) {',
          '      keepGoing = outcome;',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      () => {
        const findings = findWorkerLoopReach('fixtures/boundary-gates/self.ts');
        expect(findings.map((f) => f.file)).toEqual(['fixtures/boundary-gates/self.ts']);
        // Reported as the entry's OWN bypass with its own `why`, so the finding
        // says which of the two cases it is instead of reading like a
        // reachability hit on the file that owns the loop.
        expect(findings[0]?.via).toBe('fixtures/boundary-gates/self.ts');
        expect(findings[0]?.why).toContain('IS the turn loop');
      },
    );
  });

  it('the live entry CALLS the loop without being one, so depth 0 reports nothing today', () => {
    // The measurement behind including depth 0. The entry's 33 loops contain no
    // driven streams, so adding the entry to the subject set changed no verdict
    // on this tree: it CALLS the loop at `agent-process-entry.ts:3047`, and
    // calling a loop is not owning one. If this ever goes red, the entry grew a
    // turn cycle of its own — that is a finding to report, not a test to relax.
    const entryRel = 'packages/agent/src/process/agent-process-entry.ts';
    const src = stripComments(fs.readFileSync(path.join(REPO_ROOT, entryRel), 'utf8')).text;
    expect(turnLoopSites(src)).toEqual([]);
    expect(isTurnLoopModule(src)).toBe(false);
    expect(findWorkerLoopReach().map((f) => f.file)).not.toContain(entryRel);
  });

  it('reports NO live loop reachable from the worker entry — the legacy cycle is GONE', () => {
    // INVERTED, deliberately. This used to assert that the live entry reaches
    // the real loop in `packages/agent/src/agent/DuyaAgent.ts` within one hop,
    // i.e. it asserted the debt was still outstanding. Plan 610 deleted that
    // cycle, so the debt is paid and the only true statement left is the empty
    // one. It is still a real guard and not a deleted test: reintroduce a
    // loop anywhere in the entry's depth-<=1 closure and this goes red, which
    // is exactly what a boundary gate is for.
    //
    // The control is what keeps it from reading as green for the wrong reason.
    // `expect(findWorkerLoopReach()).toEqual([])` also passes if the scan
    // silently stopped working, so the same call is exercised against a planted
    // loop the planted entry reaches at depth 1 first.
    withRepoFixtures(
      {
        'probe-entry.ts': ["import { legacyLoop } from './probe-loop.js';", 'export const go = legacyLoop;', ''].join('\n'),
        'probe-loop.ts': PLANTED_LOOP,
      },
      () => {
        expect(
          findWorkerLoopReach('fixtures/boundary-gates/probe-entry.ts').map((f) => f.file),
        ).toEqual(['fixtures/boundary-gates/probe-loop.ts']);
      },
    );

    const findings = findWorkerLoopReach();
    // Named rather than `toEqual([])` so a failure says WHICH module reached
    // the loop and through which import, instead of printing an empty array.
    expect(findings.map((f) => `${f.file} via ${f.via}`)).toEqual([]);
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

describe('G7/G8 — the loop is located by SHAPE, and the shape contains no names', () => {
  /**
   * A turn cycle carrying the two legs the predicate actually reads: the model
   * request and the tool-result backfill, each consumed as a stream inside ONE
   * loop body. This mirrors the real cycle at `DuyaAgent.ts:1825` (legs at
   * `:2464` and `:2764`) instead of inventing a shape no real loop has — the
   * previous fixture here used plain `for` + `await`, which the shipped
   * predicate does not and should not match.
   */
  const turnLoop = [
    'export async function* drive(client, tools) {',
    '  let keepGoing = true;',
    '  while (keepGoing) {',
    '    for await (const chunk of client.streamChat([])) {',
    '      yield chunk;',
    '    }',
    '    for await (const outcome of tools.executeAll([])) {',
    '      keepGoing = outcome;',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  /** Every identifier the fixture owns, mapped to a name the predicate has never seen. */
  const RENAME = {
    drive: 'alpha',
    client: 'beta',
    tools: 'gamma',
    keepGoing: 'delta',
    chunk: 'epsilon',
    outcome: 'zeta',
    streamChat: 'eta',
    executeAll: 'theta',
  };

  const renamed = (src: string): string => {
    let out = src;
    for (const [from, to] of Object.entries(RENAME)) out = out.split(from).join(to);
    return out;
  };

  it('recognises a loop that never mentions DuyaAgent at all', () => {
    expect(turnLoop).not.toMatch(/DuyaAgent|duyaAgent/);
    expect(isTurnLoopModule(turnLoop)).toBe(true);
  });

  it('survives renaming EVERY identifier — the property the predicate is required to keep', () => {
    // This is the regression the 2026-10-06 change exists to prevent. The
    // previous three-clause version could be silenced by DELETING the
    // model-leg markers from `DuyaAgent.ts` (`buildTurnModelLeg` /
    // `TurnModelLeg` / `ModelPort`), which flipped `isTurnLoopModule` to false
    // with the cycle still in place. A gate that renaming can silence is not a
    // boundary gate, so rename-resistance is a requirement, not an accident.
    const rewritten = renamed(turnLoop);
    // Control first: if the rename did not happen, the assertion below would be
    // asserting nothing — the exact `vacuous-guard-tells` shape this file's
    // header warns about.
    expect(rewritten).not.toMatch(/drive|client|tools|keepGoing|chunk|outcome|streamChat|executeAll/);
    expect(rewritten).toMatch(/for await/);
    expect(isTurnLoopModule(rewritten)).toBe(true);
    // Same site, not merely the same boolean: the predicate still locates the
    // loop at the same line after every identifier changed.
    expect(turnLoopSites(rewritten)).toEqual(turnLoopSites(turnLoop));
  });

  it('is NOT satisfied by one leg alone — one driven stream is not a cycle', () => {
    // The counterweight to the test above. If a single `for await` were enough,
    // the gate would be satisfiable by deletion again with a different marker,
    // and the threshold would be arbitrary in the other direction.
    const oneLeg = [
      'export async function* drive(client) {',
      '  let keepGoing = true;',
      '  while (keepGoing) {',
      '    for await (const chunk of client.streamChat([])) {',
      '      yield chunk;',
      '    }',
      '    keepGoing = false;',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(isTurnLoopModule(oneLeg)).toBe(false);
    expect(isTurnLoopModule(renamed(oneLeg))).toBe(false);
  });

  it('cannot be silenced by deleting the model-leg markers — the hole this closed', () => {
    // The mutation, not the file, is what this is about. Deleting the model-leg
    // identifiers used to flip `isTurnLoopModule` to false with the cycle still
    // in place, and it was found against the real 1476-line `DuyaAgent.ts`.
    //
    // That file no longer contains a cycle — deleting it is the point of plan
    // 610 — so the mutation is now reproduced against a FIXTURE that carries
    // BOTH halves it needs: a full two-leg cycle AND all five markers that were
    // load-bearing under the old three-clause predicate. That is the same
    // experiment with a subject that still exists.
    const MARKER_HOLDER = [
      "import type { ModelPort } from '../ports.js';",
      '',
      'class LegacyRunner {',
      '  TurnModelLeg = 1;',
      '  buildTurnModelLeg(port: ModelPort) {',
      '    return port;',
      '  }',
      '  drain() {',
      '    const pipeline = new ToolExecutionPipeline();',
      '    return pipeline.getRemainingResults();',
      '  }',
      '}',
      '',
    ].join('\n');
    const withMarkers = MARKER_HOLDER + turnLoop;

    // Control: the markers really are present, so the redactions below have
    // something to remove. Asserting only the post-mutation result would also
    // pass if the markers were never there.
    expect(withMarkers).toMatch(/buildTurnModelLeg|TurnModelLeg|ModelPort/);
    expect(isTurnLoopModule(withMarkers)).toBe(true);

    const withoutModelLegMarkers = withMarkers
      .split('buildTurnModelLeg')
      .join('redactedOne')
      .split('TurnModelLeg')
      .join('redactedTwo')
      .replace(/\bModelPort\b/g, 'redactedThree');
    // Control: the mutation really removed the markers.
    expect(withoutModelLegMarkers).not.toMatch(/buildTurnModelLeg|TurnModelLeg|ModelPort/);
    // The assertion that matters: still red.
    expect(isTurnLoopModule(withoutModelLegMarkers)).toBe(true);
    expect(turnLoopSites(withoutModelLegMarkers)).toEqual(turnLoopSites(withMarkers));

    // And the tool leg is the same story, so both are pinned rather than one.
    const withoutToolMarkers = withoutModelLegMarkers
      .split('ToolExecutionPipeline')
      .join('redactedFour')
      .split('getRemainingResults')
      .join('redactedFive');
    expect(withoutToolMarkers).not.toMatch(/ToolExecutionPipeline|getRemainingResults/);
    expect(isTurnLoopModule(withoutToolMarkers)).toBe(true);

    // The other half, on the real file. This is the assertion that goes green
    // the moment a cycle is added back, and it is what makes the fixture above
    // necessary rather than redundant: `DuyaAgent.ts` is the module that USED
    // to be the counterexample, and it is now clean for the right reason.
    const live = stripComments(
      fs.readFileSync(path.join(REPO_ROOT, 'packages/agent/src/agent/DuyaAgent.ts'), 'utf8'),
    ).text;
    expect(isTurnLoopModule(live)).toBe(false);
    expect(turnLoopSites(live)).toEqual([]);
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

  it('no longer flags @duya/agent — the legacy cycle left that package', () => {
    // INVERTED. This asserted that `@duya/agent` still held a copy of the turn
    // loop, which was true only while `DuyaAgent.streamChat` existed. Plan 610
    // deleted it, so the fact is now the absence, and the absence is the point
    // of the gate: a loop may live in exactly one package, the execution
    // owner, and `@duya/agent` is not it.
    //
    // Control: the same call with an extra NON-owner package holding a planted
    // loop still reports that package. Without this the `not.toContain` below
    // would also pass on a scanner that reports nothing at all, which is the
    // `vacuous-guard-tells` shape this file exists to prevent. Paired with the
    // live `run-engine.ts` control on the "G8 reports nothing" line below, the
    // two halves are: the predicate still sees the real cycle, and no package
    // other than the owner holds one.
    const pkgSrc = path.join(REPO_ROOT, 'fixtures', 'boundary-gates', 'g8live', 'src');
    withRepoFixtures(
      {
        'g8live/package.json': JSON.stringify({ name: '@duya/agent-not-owner' }),
        'g8live/src/cycle.ts': turnLoop,
      },
      () => {
        const roots = new Map([['@duya/agent-not-owner', pkgSrc]]);
        expect(findLoopMisownership(EXECUTION_OWNER_PACKAGE, roots).map((f) => f.table)).toEqual([
          '@duya/agent-not-owner',
        ]);
      },
    );

    expect(findLoopMisownership().map((f) => f.table)).not.toContain('@duya/agent');
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
          'export async function* turn(client, tools) {',
          '  while (true) {',
          '    for await (const event of client.streamChat([])) {',
          '      yield event;',
          '    }',
          '    for await (const outcome of tools.executeAll([])) {',
          '      yield outcome;',
          '    }',
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

// ---------------------------------------------------------------------------
// The legs one CALL FRAME down. See the `turnLoopSites` docstring for why the
// inline-only rule measured `run-engine.ts` as "not a turn loop", and for the
// reason this matters before A3-2b6 rather than after it.
//
// These fixtures mirror the REAL engine shape — a `for` cycle whose body calls
// two private methods, each of which drives one `for await` leg — rather than a
// shape invented for the test. The negatives carry more weight than the
// positives here, because a widened predicate is exactly the kind of change that
// goes green by matching everything.
// ---------------------------------------------------------------------------
describe('G7/G8 — a leg one call frame down still counts, and the follow stops there', () => {
  /** The decomposition the runtime engine actually uses. */
  const DECOMPOSED_LOOP = [
    'class Engine {',
    '  async #streamModel(ports: Ports, request: Request): Promise<null> {',
    '    for await (const frame of ports.model.stream(request)) {',
    '      use(frame);',
    '    }',
    '    return null;',
    '  }',
    '',
    '  async #drainOutcomes(ports: Ports, signal: AbortSignal): Promise<void> {',
    '    for await (const item of ports.tools.drain(signal)) {',
    '      use(item);',
    '    }',
    '  }',
    '',
    '  async run(ports: Ports): Promise<void> {',
    '    for (let turn = 1; ; turn++) {',
    '      await this.#streamModel(ports, build(turn));',
    '      await this.#drainOutcomes(ports, ports.signal);',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  it('reports a loop whose two legs live in methods the body CALLS', () => {
    // The whole point of the change. Before it, this file measured false and
    // the runtime execution owner was invisible to both G7 and G8.
    expect(DECOMPOSED_LOOP).not.toMatch(/for\s+await[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n\s*for\s+await/);
    expect(isTurnLoopModule(DECOMPOSED_LOOP)).toBe(true);
    const sites = turnLoopSites(DECOMPOSED_LOOP);
    expect(sites).toHaveLength(1);
    // The site is the `for (let turn …)` header, not one of the leg methods:
    // finding a leg on its own would be the wrong answer.
    expect(DECOMPOSED_LOOP.split('\n')[sites[0]!.line - 1]).toContain('for (let turn');
  });

  it('finds the LIVE runtime engine, which the inline-only rule could not see', () => {
    // The non-vacuity proof against the real tree rather than a fixture: the
    // module the whole cutover is moving the cycle into.
    const src = stripComments(
      fs.readFileSync(path.join(REPO_ROOT, 'packages/agent-runtime/src/engine/run-engine.ts'), 'utf8'),
    ).text;
    expect(isTurnLoopModule(src)).toBe(true);
    // Guard against the assertion becoming vacuous: the loop body really does
    // carry zero inline legs, so this cannot be passing for the old reason.
    const bodyLine = turnLoopSites(src)[0]!.line;
    expect(src.split('\n').slice(bodyLine - 1, bodyLine + 280).join('\n')).not.toMatch(/\bfor\s+await\b/);
  });

  it('still reports the INLINE shape — the widening did not replace the old rule', () => {
    const inline = [
      'export async function* drive(client, tools) {',
      '  let keepGoing = true;',
      '  while (keepGoing) {',
      '    for await (const chunk of client.streamChat([])) {',
      '      yield chunk;',
      '    }',
      '    for await (const outcome of tools.executeAll([])) {',
      '      keepGoing = outcome;',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(isTurnLoopModule(inline)).toBe(true);
    expect(turnLoopSites(inline)[0]!.legs).toBe(2);
  });

  it('does NOT follow the legs into ANOTHER module — no cross-module following', () => {
    // The negative that bounds the follow along the IMPORT axis. Both legs live
    // in a different file, so this module has zero legs of its own and must not
    // be reported. Following the import would make this a transitive call
    // graph, which is explicitly out of scope.
    const local = [
      "import { bothLegs } from './legs.js';",
      '',
      'export async function* drive(ports) {',
      '  for (let turn = 1; ; turn++) {',
      '    await bothLegs(ports);',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(isTurnLoopModule(local)).toBe(false);
    expect(turnLoopSites(local)).toEqual([]);
  });

  it('does NOT follow the legs TWO frames down when the INTERMEDIATE contributes a leg', () => {
    // The negative that actually bounds the follow along the CALL axis, and the
    // one the first version of this test failed to reach.
    //
    // The shipped depth-2 test put BOTH legs two frames down with nothing in
    // between, so the intermediate contributed 0 and the fixture returned 0 for
    // the wrong reason — it never touched the leak. This shape is the one that
    // caught it: `middle` has ONE inline leg AND calls `inner`, which has
    // another. A callee that counted its whole block range scored `middle` as 2
    // and matched the module, i.e. two frames while the contract says one.
    //
    // `middle` must contribute exactly 1 (its own `for await`), and `inner`'s
    // leg is a second frame and must not count, so the total is 1 — under the
    // threshold of 2.
    const intermediateContributes = [
      'async function outer() {',
      '  for (let t = 0; t < 3; t++) {',
      '    await middle();',
      '  }',
      '}',
      'async function middle() {',
      '  async function inner() { for await (const a of s()) {} }',
      '  await inner();',
      '  for await (const b of s()) {}',
      '}',
      '',
    ].join('\n');
    expect(isTurnLoopModule(intermediateContributes)).toBe(false);
    expect(turnLoopSites(intermediateContributes)).toEqual([]);
  });

  it('does NOT follow the legs TWO frames down when both sit in the leaf', () => {
    // The complementary depth-2 shape: both legs are in `inner` and neither
    // `outer` nor the leaf's caller contributes any.
    const twoFrames = [
      'async function inner(ports) {',
      '  for await (const a of ports.model.stream()) { use(a); }',
      '  for await (const b of ports.tools.drain()) { use(b); }',
      '}',
      '',
      'async function outer(ports) {',
      '  await inner(ports);',
      '}',
      '',
      'export async function drive(ports) {',
      '  for (let turn = 1; ; turn++) {',
      '    await outer(ports);',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(isTurnLoopModule(twoFrames)).toBe(false);
  });

  it('still reaches the engine shape: two DIRECT callees, one inline leg each', () => {
    // The counterweight to the two negatives above, and the reason the one-frame
    // bound does not cost us the real engine. `run-engine.ts`'s loop body calls
    // `#streamModel` and `#drainOutcomes` directly and each holds exactly one
    // `for await`, so one frame is enough — asserted here and against the live
    // file above rather than assumed from the shape.
    const directCallees = [
      'class E {',
      '  async #streamModel(ports) {',
      '    for await (const frame of ports.model.stream()) { use(frame); }',
      '    return null;',
      '  }',
      '  async #drainOutcomes(ports) {',
      '    for await (const item of ports.tools.drain()) { use(item); }',
      '  }',
      '  async run(ports) {',
      '    for (let turn = 1; ; turn++) {',
      '      await this.#streamModel(ports);',
      '      await this.#drainOutcomes(ports);',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    const sites = turnLoopSites(directCallees);
    expect(sites).toHaveLength(1);
    expect(sites[0]!.legs).toBe(2);
  });

  it('does NOT count a loop with only ONE leg, however it is decomposed', () => {
    // The threshold counterweight, and the case that would make the gate
    // satisfiable by deletion again. One driven stream is not a cycle.
    const oneLegInline = [
      'export async function* drive(client) {',
      '  while (true) {',
      '    for await (const chunk of client.streamChat([])) {',
      '      yield chunk;',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(isTurnLoopModule(oneLegInline)).toBe(false);

    // Same, one frame down: the body calls two methods but only one has a leg.
    const oneLegDelegated = [
      'class Engine {',
      '  async #model(ports) {',
      '    for await (const frame of ports.model.stream()) { use(frame); }',
      '  }',
      '  async #tools(ports) {',
      '    use(ports.tools);',
      '  }',
      '  async run(ports) {',
      '    for (let turn = 1; ; turn++) {',
      '      await this.#model(ports);',
      '      await this.#tools(ports);',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(isTurnLoopModule(oneLegDelegated)).toBe(false);
  });

  it('does NOT count a leg from a method the loop body never CALLS', () => {
    // Sibling method, same class, holding both legs. The body does not call it,
    // so the cycle it would represent is not the loop's.
    const uncalled = [
      'class Engine {',
      '  async #elsewhere(ports) {',
      '    for await (const a of ports.model.stream()) { use(a); }',
      '    for await (const b of ports.tools.drain()) { use(b); }',
      '  }',
      '  async run(ports) {',
      '    for (let turn = 1; ; turn++) {',
      '      await tick();',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(isTurnLoopModule(uncalled)).toBe(false);
  });

  it('counts a DELEGATED leg once even when the body calls it twice', () => {
    // Guards the sum against double-counting: two call sites, one definition.
    const doubled = [
      'class Engine {',
      '  async #model(ports) {',
      '    for await (const frame of ports.model.stream()) { use(frame); }',
      '  }',
      '  async #tools(ports) {',
      '    for await (const item of ports.tools.drain()) { use(item); }',
      '  }',
      '  async run(ports) {',
      '    for (let turn = 1; ; turn++) {',
      '      await this.#model(ports);',
      '      await this.#tools(ports);',
      '      await this.#model(ports);',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(turnLoopSites(doubled)[0]!.legs).toBe(2);
  });

  it('survives renaming EVERY identifier of a DECOMPOSED loop', () => {
    // Rename-resistance applied to the NEW shape. If the widening had started
    // matching method NAMES, this is where it would show.
    const renamedSrc = DECOMPOSED_LOOP
      .split('Engine').join('alpha')
      .split('streamModel').join('beta')
      .split('drainOutcomes').join('gamma')
      .split('build').join('delta')
      .split('use').join('epsilon')
      .split('ports').join('zeta')
      .split('request').join('eta')
      .split('frame').join('theta')
      .split('item').join('iota');
    // Control: the rename really happened and the structural tokens survived.
    expect(renamedSrc).not.toMatch(/Engine|streamModel|drainOutcomes|build|use|ports/);
    expect(renamedSrc).toMatch(/for await/);
    expect(renamedSrc).toMatch(/for \(let turn/);
    expect(isTurnLoopModule(renamedSrc)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G7's exclusion of the sanctioned execution owner. See the `WORKER_LOOP_MAX_DEPTH`
// docstring for the cutover this exists for.
// ---------------------------------------------------------------------------
describe('G7 — the sanctioned execution owner is excluded, and only that', () => {
  /** A turn cycle decomposed the way the engine decomposes it. */
  const DECOMPOSED = [
    'export async function* drive(ports) {',
    '  for (let turn = 1; ; turn++) {',
    '    await streamModel(ports);',
    '    await drainOutcomes(ports);',
    '  }',
    '}',
    '',
    'async function streamModel(ports) {',
    '  for await (const frame of ports.model.stream()) {',
    '    use(frame);',
    '  }',
    '}',
    '',
    'async function drainOutcomes(ports) {',
    '  for await (const item of ports.tools.drain()) {',
    '    use(item);',
    '  }',
    '}',
    '',
  ].join('\n');

  const ENTRY = ["import { drive } from './ownerpkg/src/cycle.js';", 'export const go = drive;', ''].join('\n');
  const CYCLE_REL = 'fixtures/boundary-gates/ownerpkg/src/cycle.ts';
  /** A package root standing in for the execution owner, declared by parameter. */
  const OWNER_PKG = '@duya/fixture-owner';
  const OWNER_SRC = path.join(REPO_ROOT, 'fixtures', 'boundary-gates', 'ownerpkg', 'src');

  it('REPORTS a decomposed cycle in an ordinary package at depth 1 — the positive control', () => {
    // If this went green the exclusion would be a blanket mute, and the whole
    // change would be indistinguishable from "matches nothing".
    withRepoFixtures(
      { 'entry.ts': ENTRY, 'ownerpkg/src/cycle.ts': DECOMPOSED },
      () => {
        const findings = findWorkerLoopReach('fixtures/boundary-gates/entry.ts');
        expect(findings.map((f) => f.file)).toEqual([CYCLE_REL]);
        expect(findings[0]?.via).toBe('fixtures/boundary-gates/entry.ts');
      },
    );
  });

  it('does NOT report the same shape once that package is declared the owner', () => {
    // The negative control. The owner is passed as a PARAMETER rather than
    // written into `packages/agent-runtime/src`, because this test file's header
    // forbids mutating the live tree to prove a gate works — another agent is
    // working in this checkout.
    withRepoFixtures(
      { 'entry.ts': ENTRY, 'ownerpkg/src/cycle.ts': DECOMPOSED },
      () => {
        // Control: the predicate really does see this file on its own terms, so
        // the emptiness below is the exclusion and not a broken fixture.
        const cycleSrc = stripComments(fs.readFileSync(path.join(REPO_ROOT, CYCLE_REL), 'utf8')).text;
        expect(isTurnLoopModule(cycleSrc)).toBe(true);
        expect(turnLoopSites(cycleSrc)).toHaveLength(1);

        // Same file, same entry, no owner declared → reported.
        expect(findWorkerLoopReach('fixtures/boundary-gates/entry.ts').map((f) => f.file)).toEqual([CYCLE_REL]);

        // Same file, same entry, its package declared the owner → not a finding.
        const asOwner = findWorkerLoopReach(
          'fixtures/boundary-gates/entry.ts',
          new Map([[OWNER_PKG, OWNER_SRC]]),
          WORKER_LOOP_MAX_DEPTH,
          OWNER_PKG,
        );
        expect(asOwner).toEqual([]);
      },
    );
  });

  it('reports no live red anymore — the exclusion is scoped, and the tree is clean', () => {
    // INVERTED. This used to prove the owner exclusion was NOT a blanket mute
    // by pointing at a live finding outside the owner package. That evidence is
    // gone, so the scoping has to be argued from the FIXTURE, which is stronger
    // anyway: the two tests above run the same planted cycle twice, once with a
    // non-owner package reported and once with the owner package declared, so
    // what is excluded is a package path and nothing else.
    //
    // What is left to pin HERE is the live half: no module in the worker's
    // depth-<=1 closure carries a cycle any more. Control first, or an empty
    // live result could just as well mean the scan stopped working.
    withRepoFixtures(
      {
        'owner-entry.ts': ["import { legacyLoop } from './owner-loop.js';", 'export const go = legacyLoop;', ''].join('\n'),
        'owner-loop.ts': PLANTED_LOOP,
      },
      () => {
        // A planted loop outside `@duya/agent-runtime` is still reported, so
        // the live emptiness below is the tree and not the exclusion swallowing
        // everything.
        expect(
          findWorkerLoopReach('fixtures/boundary-gates/owner-entry.ts').map((f) => f.file),
        ).toEqual(['fixtures/boundary-gates/owner-loop.ts']);
      },
    );

    const findings = findWorkerLoopReach();
    expect(findings.map((f) => `${f.file} via ${f.via}`)).toEqual([]);
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

describe('the gates pin the CURRENT live state — G7 and G8 are green, the rest are red', () => {
  // These are not aspirational assertions. Each one pins the CURRENT known
  // state of a gate, in whichever direction that state currently lies, so that
  // a slice cannot move a gate without a test turning red and the move being
  // visible.
  //
  // The block is deliberately titled after the state rather than asserting that
  // state. G7 and G8 went GREEN when plan 610 deleted the `DuyaAgent.streamChat`
  // turn loop; a title saying "the gates are RED" would have become a false
  // claim about the tree, and a describe whose name is untrue is worse than no
  // describe at all. Their lines below are real guards in the green direction —
  // reintroduce a cycle and they report it.
  it('G4 is red: the worker still constructs DuyaAgent', () => {
    expect(findWorkerSeamBypasses().length).toBeGreaterThan(0);
  });

  it('G6 is red: durable tables are still rooted at session_id', () => {
    expect(findSessionRootedTables().length).toBeGreaterThan(0);
  });

  it('G6 is red on the LIFECYCLE too, which is the half the DDL cannot see', () => {
    expect(findLifecycleCouplings().length).toBeGreaterThan(0);
  });

  it('G7 reports nothing live, and still names the edge whenever it does', () => {
    // INVERTED, with the naming half preserved and moved onto a fixture.
    //
    // This used to assert `length > 0`, which pinned G7 red forever: the moment
    // A3 legitimately removed the entry's direct `DuyaAgent` import, a correct
    // fix would have failed this test. It was then relaxed to assert only that
    // every finding carries a file, a hop and a `why`, plus that an unbounded
    // depth-8 walk of the LIVE entry found something.
    //
    // Both of those had to move, because the live tree is now clean at every
    // depth and asserting the depth-8 walk finds something would re-pin G7 red
    // forever in the exact place the fix landed. So:
    //
    //  - "every finding names its edge" is asserted against a PLANTED loop
    //    three hops down, which is the property that matters — a finding a
    //    slice cannot act on is not a finding.
    //  - "the scan is not silently broken" is the same planted loop found at
    //    depth 8 and NOT found at the default bound of 1. That is the old
    //    depth-8 check, with a subject that exists.
    const DEEP_CHAIN = {
      'chain-entry.ts': ["import { a } from './hop1.js';", 'export const go = a;', ''].join('\n'),
      'hop1.ts': ["export { a } from './hop2.js';", ''].join('\n'),
      'hop2.ts': ["export { legacyLoop as a } from './hop3.js';", ''].join('\n'),
      'hop3.ts': PLANTED_LOOP,
    };
    withRepoFixtures(DEEP_CHAIN, () => {
      const entry = 'fixtures/boundary-gates/chain-entry.ts';
      const deep = findWorkerLoopReach(entry, undefined, 8);
      for (const finding of deep) {
        expect(finding.file).toBeTruthy();
        expect(finding.via).toBeTruthy();
        expect(finding.why).toContain('turn-loop');
      }
      expect(deep.map((f) => f.file)).toEqual(['fixtures/boundary-gates/hop3.ts']);
      // The naming half has teeth only if the hop is the one that is actually
      // reported, so the three re-exports in between are pinned too.
      expect(deep[0]?.via).toBe('fixtures/boundary-gates/hop2.ts');
      // And the bounded walk really is what excluded it.
      expect(findWorkerLoopReach(entry).map((f) => f.file)).toEqual([]);
    });

    // The live half: nothing reachable from the worker entry at any depth.
    expect(findWorkerLoopReach('packages/agent/src/process/agent-process-entry.ts', undefined, 8).map((f) => f.file)).toEqual([]);
  });

  it('G8 reports nothing: the only cycle is the one the execution owner owns', () => {
    // INVERTED, with the subject proved rather than assumed.
    //
    // `findLoopMisownership()` returning `[]` proves nothing on its own — it is
    // also what a gate that never matches returns. So this asserts both halves:
    // the predicate still recognises the REAL cycle, which now lives in
    // `packages/agent-runtime/src/engine/run-engine.ts`, and no package outside
    // that owner holds one. G8 green here means the cycle was MOVED, not that
    // the gate went blind.
    const engine = stripComments(
      fs.readFileSync(path.join(REPO_ROOT, 'packages/agent-runtime/src/engine/run-engine.ts'), 'utf8'),
    ).text;
    expect(isTurnLoopModule(engine)).toBe(true);
    expect(findLoopMisownership().map((f) => `${f.table} holds ${f.owners.join(',')}`)).toEqual([]);
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
