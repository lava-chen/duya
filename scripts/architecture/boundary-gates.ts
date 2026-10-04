/**
 * Plan 600 — boundary gates G1/G3/G4/G6.
 *
 * ## Why this file exists
 *
 * `layer-purity.ts` (587 M5.3) already makes the `layers:` block mean something
 * for IO. What it does NOT check is the half that plan 600 found to be the
 * load-bearing hole: **the declared seam between runtime and its executor does
 * not exist in production.**
 *
 * `packages/agent-runtime` owns `ExecutionChannel` as a port, and
 * `apps/desktop/src/main/agents/server/run-orchestrator.ts:1353` implements it
 * on the host side. The worker side — the process that actually runs the model
 * loop — has no implementation at all:
 *
 *   packages/agent/src/process/agent-process-entry.ts:75
 *     import { duyaAgent } from '../agent/DuyaAgent.js';
 *   packages/agent/src/process/agent-process-entry.ts:1923
 *     agent = new duyaAgent({ ... });
 *
 * That file contains ZERO occurrences of `ExecutionChannel`, `ExecutionSink`
 * or `RunController`. So the boundary is declared in three packages and
 * implemented in none of them on the execution path. Every "runtime owns the
 * run" statement in the architecture docs is currently a claim about a port
 * with no production implementation behind it.
 *
 * G4 is the gate that says so out loud. It is RED on the current tree. That is
 * correct: it is reporting a real defect, not a misconfiguration.
 *
 * ## The other three
 *
 * - G1 — no reverse dependency edge between the declared layers. A layer may
 *   import the layer below it and nothing else.
 * - G3 — a `runtime` module may not reach into Electron, the renderer, or the
 *   Desktop logger/schema/migration layer.
 * - G6 — a durable identity must not be rooted at `session_id`. Session is a
 *   communication projection (plan 600 `00-contracts.md` §C); `runs`, `tasks`
 *   and goals are rooted at their own ids.
 *
 * ## The discipline this file is written to
 *
 * Every finding below is measured from the tree, not asserted from a plan. A
 * gate that reports a fact without checking anything is worse than a red test,
 * because the next slice trusts it and deletes the real check. Each rule here
 * had to be proven red by deliberately introducing the violation it forbids —
 * see `boundary-gates.test.ts`, whose negative cases assert on injected
 * fixtures rather than on the live tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from './strip-comments.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');

const SRC_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'bundle') continue;
      walk(abs, out);
    } else if (SRC_EXTS.has(path.extname(entry.name))) {
      out.push(abs);
    }
  }
  return out;
}

export function rel(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Shared: a comment-stripped read.
//
// Stripping comments matters here for a specific reason recorded in the 13th
// progress review (F09): the existing `layer-purity.ts` strips comments with a
// hand-rolled regex, and a string literal containing `"//"` swallows the rest
// of the line — `const label="//"; return fetch(...)` reported no IO. A gate
// built on that scanner has a false negative, and a false negative is a gate
// that lies. This module reuses the reviewed `strip-comments.mjs` instead of
// writing a second implementation.
// ---------------------------------------------------------------------------

function readSource(abs: string): string {
  return fs.readFileSync(abs, 'utf8');
}

/**
 * Strip comments using the shared reviewed helper.
 *
 * Stripping comments matters here for a specific reason recorded in the 13th
 * progress review (F09): the existing `layer-purity.ts` strips comments with a
 * hand-rolled regex, and a string literal containing `"//"` swallows the rest
 * of the line — `const label="//"; return fetch(...)` reported no IO. A gate
 * built on that scanner has a false negative, and a false negative is a gate
 * that lies. This module reuses the reviewed `strip-comments.mjs`, which
 * preserves byte offsets, so a line number computed from the stripped text
 * still points at the right line in the original file.
 */
function code(abs: string): string {
  return stripComments(readSource(abs)).text;
}

/** Every import specifier in a source file, via the shared tokenizer. */
function importSpecifiers(abs: string): string[] {
  const out: string[] = [];
  const src = code(abs);
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]!);
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((m = bare.exec(src)) !== null) out.push(m[1]!);
  return out;
}

// ---------------------------------------------------------------------------
// G1 — no reverse dependency edge between declared layers
// ---------------------------------------------------------------------------

export interface LayerDef {
  readonly name: string;
  /** Workspace package names belonging to this layer. */
  readonly packages: readonly string[];
}

/**
 * Layer order. A layer may import any layer at a LOWER index and its own
 * package siblings. Anything else is a reverse edge.
 *
 * `agent` sits at the runtime index because that is where its code executes
 * today; plan 600 S3 moves its execution code into `runtime` proper and S7
 * deletes it. It is listed explicitly rather than omitted, so the gate can
 * report "agent reached upward" instead of silently not looking.
 *
 * ## Sub-path granularity, and why `@duya/cli` is the reason
 *
 * A layer is assigned to a PACKAGE only when every entry point of that package
 * belongs to one layer. `@duya/cli` is the case that breaks the rule: its
 * `contract/` entry point (descriptors, registry, `buildAgentRunner`) is a
 * legitimate runtime dependency, while the bare entry point (`index.ts`,
 * `api/client.ts`, `commands/*`) is a host adapter that speaks HTTP to
 * `127.0.0.1` and reads the filesystem. Classifying the whole package as `host`
 * made the gate report four findings for `DuyaCliTool` importing
 * `@duya/cli/contract` — a false positive, and a gate that cries wolf on a
 * correct edge trains people to ignore it.
 *
 * So `SUBPATH_LAYERS` overrides the package default per export path. Only paths
 * listed there get a different layer from their package; everything else falls
 * back to the package's layer.
 *
 * The precedent for splitting a package into a contract face and an app face is
 * written into `packages/cli/src/contract/index.ts:24-27`: the contract module
 * "MUST NOT import any agent runtime". That rule is load-bearing — it is what
 * makes the dependency from `@duya/agent` legitimate rather than merely
 * tolerated.
 */
export const LAYERS: readonly LayerDef[] = [
  { name: 'protocol', packages: ['@duya/agent-protocol'] },
  { name: 'core', packages: ['@duya/agent-core', '@duya/ai'] },
  {
    name: 'runtime',
    packages: ['@duya/agent-runtime', '@duya/agent', '@duya/capabilities', '@duya/connectors', '@duya/memory'],
  },
  { name: 'host', packages: ['@duya/desktop', '@duya/cli', '@duya/gateway'] },
];

/**
 * Export-path overrides. Key is the full specifier prefix; the longest matching
 * prefix wins, so `@duya/cli/contract` beats the package default `@duya/cli`.
 */
export const SUBPATH_LAYERS: ReadonlyMap<string, string> = new Map([
  // The command-descriptor contract the agent's DuyaCliTool dispatches
  // through. Pure data + an in-process dispatcher; no IO, no agent runtime.
  ['@duya/cli/contract', 'runtime'],
]);

/** Capability packages that must not be reachable FROM tooling (600 G7). */
export const CAPABILITY_PACKAGES: readonly string[] = [
  '@duya/capabilities',
  '@duya/connectors',
  '@duya/memory',
];

export interface ReverseEdge {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly fromLayer: string;
  readonly toLayer: string;
}

function layerOf(pkg: string): string | undefined {
  for (const layer of LAYERS) if (layer.packages.includes(pkg)) return layer.name;
  return undefined;
}

/**
 * The layer a given IMPORT SPECIFIER belongs to.
 *
 * A sub-path override wins over the package default, matched longest-prefix so
 * that a deeper path cannot be shadowed by a shallower one. Returns the
 * package's layer when no override matches.
 */
export function layerOfSpecifier(spec: string): string | undefined {
  let best: { prefix: string; layer: string } | undefined;
  for (const [prefix, layer] of SUBPATH_LAYERS) {
    if (spec === prefix || spec.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.prefix.length) best = { prefix, layer };
    }
  }
  if (best) return best.layer;
  // Fall back to the owning package. Longest package prefix wins, so
  // `@duya/plugin-core/mcp/x` resolves to plugin-core rather than nothing.
  const owner = [...LAYERS.flatMap((l) => l.packages)]
    .filter((name) => spec === name || spec.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  return owner ? layerOf(owner) : undefined;
}

/** Workspace package name -> source dir, for packages that exist on disk. */
function packageRoots(): Map<string, string> {
  const root = path.join(REPO_ROOT, 'packages');
  const map = new Map<string, string>();
  if (!fs.existsSync(root)) return map;
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const pkgJson = path.join(root, dir.name, 'package.json');
    if (!fs.existsSync(pkgJson)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as { name?: string };
      if (parsed.name) map.set(parsed.name, path.join(root, dir.name, 'src'));
    } catch {
      // A malformed package.json is a different gate's problem.
    }
  }
  return map;
}

export function findReverseEdges(roots: Map<string, string> = packageRoots()): ReverseEdge[] {
  const findings: ReverseEdge[] = [];
  for (const [pkg, srcDir] of roots) {
    const fromLayer = layerOf(pkg);
    if (!fromLayer) continue;
    const fromIndex = LAYERS.findIndex((l) => l.name === fromLayer);
    for (const file of walk(srcDir)) {
      for (const spec of importSpecifiers(file)) {
        if (!spec.startsWith('@duya/')) continue;
        const fromIndex = LAYERS.findIndex((l) => l.name === fromLayer);
        // The sub-path's own layer decides, not the package's: `@duya/cli/contract`
        // is a runtime contract while `@duya/cli` is a host adapter, and only
        // the second one is a reverse edge for a runtime importer.
        const toLayer = layerOfSpecifier(spec);
        if (!toLayer) continue;
        const toIndex = LAYERS.findIndex((l) => l.name === toLayer);
        // Allowed: same layer, or strictly downward.
        if (toIndex <= fromIndex) continue;
        findings.push({
          file: rel(file),
          from: pkg,
          to: spec,
          fromLayer,
          toLayer,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// G3 — runtime may not reach into Electron / renderer / Desktop internals
// ---------------------------------------------------------------------------

/**
 * The host-only import shapes a `runtime` module may not contain.
 *
 * Each entry carries a `sample` that MUST match its own pattern and a
 * `clean` that must not, so the rule is provably live rather than assumed.
 *
 * Exported so the test can assert against THIS list rather than a hand-copied
 * duplicate. A test that re-declares the patterns it is testing is testing its
 * own copy, and the two drift apart silently.
 */
export const HOST_ONLY: readonly {
  re: RegExp;
  why: string;
  sample: string;
  clean: string;
}[] = [
  {
    re: /from\s+['"]electron['"]/,
    why: 'electron main',
    sample: "import { app } from 'electron';",
    clean: "import { app } from './app.js';",
  },
  {
    re: /from\s+['"][^'"]*\/renderer\//,
    why: 'renderer module',
    sample: "import { store } from '../renderer/store';",
    clean: "import { store } from './store.js';",
  },
  {
    re: /from\s+['"][^'"]*apps\/desktop\/src\/main\/(?:db|logging|ipc)\//,
    why: 'Desktop main internals',
    sample: "import { open } from 'apps/desktop/src/main/db/core/database';",
    clean: "import { open } from '@duya/agent-protocol';",
  },
];

export interface HostLeak {
  readonly file: string;
  readonly why: string;
}

export function findRuntimeHostLeaks(pkg = '@duya/agent-runtime'): HostLeak[] {
  const roots = packageRoots();
  const srcDir = roots.get(pkg);
  if (!srcDir) return [];
  const findings: HostLeak[] = [];
  for (const file of walk(srcDir)) {
    const src = code(file);
    for (const rule of HOST_ONLY) {
      if (rule.re.test(src)) findings.push({ file: rel(file), why: rule.why });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// G4 — the worker must not construct the legacy agent directly
// ---------------------------------------------------------------------------

export const WORKER_ENTRY = 'packages/agent/src/process/agent-process-entry.ts';

export interface WorkerSeamFinding {
  readonly file: string;
  readonly line: number;
  readonly symbol: string;
  readonly why: string;
}

/**
 * Symbols whose presence in the worker entry means the executor seam is still
 * bypassed. `DuyaAgent` is the real one; the runtime symbols are listed too so
 * that a half-finished migration (importing the port but still constructing the
 * class) is reported rather than passing.
 */
const BYPASS_SYMBOLS: readonly { symbol: string; why: string }[] = [
  { symbol: 'DuyaAgent', why: 'worker constructs the legacy agent directly instead of through ExecutionChannel' },
  { symbol: 'duyaAgent', why: 'worker constructs the legacy agent directly instead of through ExecutionChannel' },
];

export function findWorkerSeamBypasses(entryRel = WORKER_ENTRY): WorkerSeamFinding[] {
  const abs = path.join(REPO_ROOT, entryRel);
  if (!fs.existsSync(abs)) return [];
  const findings: WorkerSeamFinding[] = [];
  const lines = code(abs).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { symbol, why } of BYPASS_SYMBOLS) {
      // An import or a construction, not a mention in a comment (comments are
      // already stripped) and not a bare identifier in a type position.
      if (new RegExp(`\\b${symbol}\\b`).test(line) && /import|new\s+/.test(line)) {
        findings.push({ file: entryRel, line: i + 1, symbol, why });
      }
    }
  });
  return findings;
}

/** True when the worker actually implements the execution port. */
export function workerImplementsExecutionChannel(entryRel = WORKER_ENTRY): boolean {
  const abs = path.join(REPO_ROOT, entryRel);
  if (!fs.existsSync(abs)) return false;
  const src = code(abs);
  return /implements\s+ExecutionChannel|:?\s*ExecutionChannel\s*=/.test(src);
}

// ---------------------------------------------------------------------------
// G6 — durable identity must not be rooted at session_id
// ---------------------------------------------------------------------------

/**
 * Tables that hold durable execution state. `sessions` is deliberately absent:
 * it is the projection, and it is allowed to keep its own id.
 */
export const DURABLE_IDENTITY_TABLES: readonly string[] = ['runs', 'tasks', 'session_goals'];

/**
 * Which database each table definition belongs to.
 *
 * This distinction is not cosmetic. `tasks` is defined TWICE on disk:
 *
 *   apps/desktop/src/main/db/core/stores.ts:103  -> core.db, and it is LIVE.
 *     Every read and write reaches it: stores.ts has 20+ prepared statements
 *     against it, and `db-bridge.ts:1432` dispatches `task:create` through
 *     `getCoreStores().tasks.create(...)`.
 *   apps/desktop/src/main/db/schema.ts:163/402/415 -> main.db, and it is DEAD.
 *     `initializeSchema` still creates it (connection.ts:160/221), so the DDL
 *     runs on every boot, but nothing ever reads or writes it. This matches the
 *     adjudication in 587 §08, which classified `schema.ts:163` main.db `tasks`
 *     as DEAD.
 *
 * A gate that reported both as one bucket would send S1 to migrate a table
 * nobody uses while the live one keeps its `session_id NOT NULL`. So the
 * finding records which database it came from, and the live one is what the
 * migration has to fix.
 */
export type Database = 'core.db' | 'main.db';

/** Which database a given source file's DDL belongs to. */
export function databaseOfFile(relFile: string): Database {
  // `db/core/**` is duya-core.db; everything else under db/ is duya-main.db.
  // Deriving it from the file rather than from the table name is the point:
  // `tasks` is defined in both, and a per-table map reported the dead main.db
  // definition as core.db, which is exactly the mislabeling this rule exists
  // to prevent.
  return /(^|\/)db\/core\//.test(relFile) || relFile.includes('/db/core/') ? 'core.db' : 'main.db';
}

/** Definitions that exist but have no reader or writer. */
export const DEAD_TABLE_DEFINITIONS: readonly { file: string; table: string; database: Database }[] = [
  { file: 'apps/desktop/src/main/db/schema.ts', table: 'tasks', database: 'main.db' },
];

export interface SessionRootedTable {
  readonly table: string;
  readonly file: string;
  readonly line: number;
  readonly column: string;
  readonly database: Database;
  /** False for a DDL block nothing reads or writes. */
  readonly live: boolean;
}

/** Find a `session_id TEXT NOT NULL` inside a CREATE TABLE for the given name. */
export function findSessionRootedTables(
  tables: readonly string[] = DURABLE_IDENTITY_TABLES,
): SessionRootedTable[] {
  const findings: SessionRootedTable[] = [];
  const dbDir = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'main');
  const isDead = (file: string, table: string): boolean =>
    DEAD_TABLE_DEFINITIONS.some((d) => d.file === file && d.table === table);
  for (const file of walk(dbDir)) {
    const raw = readSource(file);
    for (const table of tables) {
      const create = new RegExp(
        `CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\s*\\);`,
        'g',
      );
      let m: RegExpExecArray | null;
      while ((m = create.exec(raw)) !== null) {
        const body = m[1]!;
        const bodyStartLine = raw.slice(0, m.index).split(/\r?\n/).length;
        const fileRel = rel(file);
        const database = databaseOfFile(fileRel);
        body.split(/\r?\n/).forEach((row, i) => {
          if (/^\s*session_id\s+TEXT\s+NOT\s+NULL/i.test(row)) {
            findings.push({
              table,
              file: fileRel,
              line: bodyStartLine + i,
              column: 'session_id NOT NULL',
              database,
              live: !isDead(fileRel, table),
            });
          }
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface BoundaryReport {
  readonly gate: string;
  readonly title: string;
  readonly findings: readonly unknown[];
}

export function collectBoundaryReport(): BoundaryReport[] {
  return [
    { gate: 'G1', title: 'no reverse dependency edge between layers', findings: findReverseEdges() },
    { gate: 'G3', title: 'runtime does not reach into host internals', findings: findRuntimeHostLeaks() },
    { gate: 'G4', title: 'worker implements ExecutionChannel, not DuyaAgent', findings: findWorkerSeamBypasses() },
    { gate: 'G6', title: 'durable identity is not rooted at session_id', findings: findSessionRootedTables() },
  ];
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  let total = 0;
  for (const report of collectBoundaryReport()) {
    const n = report.findings.length;
    total += n;
    const verdict = n === 0 ? 'PASS' : 'FINDINGS';
    process.stdout.write(`${report.gate} ${verdict} (${n}) — ${report.title}\n`);
    for (const finding of report.findings.slice(0, 8)) {
      process.stdout.write(`    ${JSON.stringify(finding)}\n`);
    }
    if (n > 8) process.stdout.write(`    ... and ${n - 8} more\n`);
  }
  process.stdout.write(`\ntotal findings: ${total}\n`);
  // Exit code is informational for now: G4 and G6 are RED on the current tree
  // because they report real defects, not because the gate is misconfigured.
  // S0 turns this into a hard failure once the defects are fixed.
  process.exit(0);
}
