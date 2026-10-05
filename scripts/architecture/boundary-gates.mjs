#!/usr/bin/env node
/**
 * CLI entry for the plan 600 boundary gates. Self-contained: no `tsx`, no
 * vitest, no new dependency.
 *
 * ## Why a second file instead of running the .ts directly
 *
 * `tsx` is not a dependency of this repository, so `npm run` cannot execute a
 * TypeScript file. Rather than add a devDependency to run one script, the
 * detector logic lives in plain ESM JavaScript (`boundary-gates.mjs`) and the
 * TypeScript file is only the typed re-export used by the unit tests.
 *
 * The duplication is deliberate and narrow: the LOGIC is written once, in the
 * `.mjs`. `boundary-gates.ts` imports that module and adds type annotations,
 * so there is no second implementation to drift.
 *
 * Run:  node scripts/architecture/boundary-gates.mjs [--write]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from './strip-comments.mjs';
import { importsOf } from './import-graph.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');

const SRC_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

function walk(dir, out = []) {
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

export function rel(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

const readSource = (abs) => fs.readFileSync(abs, 'utf8');
/** Comment-stripped source; `stripComments` preserves byte offsets. */
const code = (abs) => stripComments(readSource(abs)).text;

function importSpecifiers(abs) {
  const out = [];
  const src = code(abs);
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((m = bare.exec(src)) !== null) out.push(m[1]);
  return out;
}

// ── layers ──────────────────────────────────────────────────────────────────

export const LAYERS = [
  { name: 'protocol', packages: ['@duya/agent-protocol'] },
  { name: 'core', packages: ['@duya/agent-core', '@duya/ai'] },
  {
    name: 'runtime',
    packages: ['@duya/agent-runtime', '@duya/agent', '@duya/capabilities', '@duya/connectors', '@duya/memory'],
  },
  { name: 'host', packages: ['@duya/desktop', '@duya/cli', '@duya/gateway'] },
];

/**
 * Export-path overrides, matched longest-prefix first. `@duya/cli/contract` is a
 * pure descriptor contract the agent legitimately depends on, while the bare
 * `@duya/cli` is a host adapter (HTTP to 127.0.0.1 plus node:fs). Classifying
 * the package as a whole made the gate report a correct edge as a violation.
 *
 * The `@duya/ai` pair is the SPLIT THAT DOES NOT EXIST YET, declared so the
 * gate is already correct on the day S5 cuts it. `00-contracts.md` §A.3
 * requires a mixed package to be split into a pure core export and an adapter
 * export, and forbids making a `fetch`-capable package core-reachable by
 * relabelling it. Today `packages/ai/package.json` publishes ONE export path
 * (`.`) whose barrel re-exports both the pure transforms and the `fetch`
 * clients, so there is no sub-path to classify and the whole package has to be
 * treated as core — a lie of convenience. Declaring `/core` and `/adapter`
 * changes no verdict today (nothing imports either) and makes the split the
 * intended target rather than an accident. G9 is what actually enforces it: it
 * measures whether a `core`-classified package can REACH IO, which a sub-path
 * declaration alone would only assert.
 */
export const SUBPATH_LAYERS = new Map([
  ['@duya/cli/contract', 'runtime'],
  ['@duya/ai/core', 'core'],
  ['@duya/ai/adapter', 'runtime'],
]);

const layerOf = (pkg) => LAYERS.find((l) => l.packages.includes(pkg))?.name;

export function layerOfSpecifier(spec) {
  let best;
  for (const [prefix, layer] of SUBPATH_LAYERS) {
    if (spec === prefix || spec.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.prefix.length) best = { prefix, layer };
    }
  }
  if (best) return best.layer;
  const owner = LAYERS.flatMap((l) => l.packages)
    .filter((name) => spec === name || spec.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  return owner ? layerOf(owner) : undefined;
}

function packageRoots() {
  const root = path.join(REPO_ROOT, 'packages');
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const pkgJson = path.join(root, dir.name, 'package.json');
    if (!fs.existsSync(pkgJson)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      if (parsed.name) map.set(parsed.name, path.join(root, dir.name, 'src'));
    } catch {
      // A malformed package.json is a different gate's problem.
    }
  }
  return map;
}

export function findReverseEdges(roots = packageRoots()) {
  const findings = [];
  for (const [pkg, srcDir] of roots) {
    const fromLayer = layerOf(pkg);
    if (!fromLayer) continue;
    const fromIndex = LAYERS.findIndex((l) => l.name === fromLayer);
    for (const file of walk(srcDir)) {
      for (const spec of importSpecifiers(file)) {
        if (!spec.startsWith('@duya/')) continue;
        const toLayer = layerOfSpecifier(spec);
        if (!toLayer) continue;
        if (LAYERS.findIndex((l) => l.name === toLayer) <= fromIndex) continue;
        findings.push({ file: rel(file), from: pkg, to: spec, fromLayer, toLayer });
      }
    }
  }
  return findings;
}

// ── G3 ──────────────────────────────────────────────────────────────────────

export const HOST_ONLY = [
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

export function findRuntimeHostLeaks(pkg = '@duya/agent-runtime') {
  const srcDir = packageRoots().get(pkg);
  if (!srcDir) return [];
  const findings = [];
  for (const file of walk(srcDir)) {
    const src = code(file);
    for (const rule of HOST_ONLY) {
      if (rule.re.test(src)) findings.push({ file: rel(file), why: rule.why });
    }
  }
  return findings;
}

// ── G4 ──────────────────────────────────────────────────────────────────────

export const WORKER_ENTRY = 'packages/agent/src/process/agent-process-entry.ts';

const BYPASS_SYMBOLS = [
  { symbol: 'DuyaAgent', why: 'worker constructs the legacy agent directly instead of through ExecutionChannel' },
  { symbol: 'duyaAgent', why: 'worker constructs the legacy agent directly instead of through ExecutionChannel' },
];

export function findWorkerSeamBypasses(entryRel = WORKER_ENTRY) {
  const abs = path.join(REPO_ROOT, entryRel);
  if (!fs.existsSync(abs)) return [];
  const findings = [];
  code(abs)
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const { symbol, why } of BYPASS_SYMBOLS) {
        if (new RegExp(`\\b${symbol}\\b`).test(line) && /import|new\s+/.test(line)) {
          findings.push({ file: entryRel, line: i + 1, symbol, why });
        }
      }
    });
  return findings;
}

export function workerImplementsExecutionChannel(entryRel = WORKER_ENTRY) {
  const abs = path.join(REPO_ROOT, entryRel);
  if (!fs.existsSync(abs)) return false;
  const src = code(abs);
  return /implements\s+ExecutionChannel|:?\s*ExecutionChannel\s*=/.test(src);
}

// ── the turn loop, located by SHAPE rather than by name ─────────────────────

/**
 * ## Why "reachability" instead of "does the entry say `DuyaAgent`"
 *
 * The name check is necessary and nowhere near sufficient. Plan 600
 * `04-runtime-owns-execution.md` §2 names the bypass exactly: wrap
 * `DuyaAgent.streamChat` in an adapter, call the adapter, and the name check
 * goes green while the loop is still the old one in the old package. An
 * adapter cannot avoid IMPORTING the module it wraps, so reachability is the
 * property that actually holds the boundary.
 *
 * ## Where "the loop implementation" is, precisely
 *
 * `00-contracts.md` §A and `04` §2 define the loop by responsibility, not by
 * file name: a cycle of model request, tool execution, result backfill, and
 * next turn. So it is detected by SHAPE — a module that (a) iterates, (b) opens
 * a model stream, and (c) dispatches tools, because a cycle is exactly those
 * three things.
 *
 * ### Clause (b) had drifted to a spelling, not the responsibility (2026-10-05)
 *
 * It used to be `/\.streamChat\s*\(/` alone, and the docstring above it claimed
 * the predicate selected "the real loop, the worker entry, and one integration
 * test". Re-measured on this tree it selected **only the worker entry**:
 * slice S2 moved the model request behind the `model-leg` seam
 * (`buildTurnModelLeg` / `createTurnLegModelPort`), so `DuyaAgent.ts` no longer
 * contains a literal `.streamChat(` call, while `agent-process-entry.ts` still
 * does. A gate that fires on the entry and not on the loop is worse than no
 * gate: it points the next slice at the wrong file.
 *
 * So (b) now also accepts the *seam* that opens the turn's model stream, not
 * only a direct call. Selectivity was measured rather than assumed — over the
 * 2194 non-test source files under `packages/`, `apps/desktop/src`, `electron/`
 * and `scripts/`, requiring all three clauses together:
 *
 *   | (b) variant                | files matched |
 *   | -------------------------- | ------------- |
 *   | `streamChat(` only (old)   | 1 — the entry, NOT the loop |
 *   | `+ model-leg seam`         | 3 — the loop, the entry, `agent-runtime/src/engine/ports.ts` |
 *   | `+ llmClient / AIClient`   | 5 — starts matching unrelated files |
 *
 * `agent-runtime/src/engine/ports.ts` is the known over-read: it DECLARES the
 * loop's ports, so it carries (a) and (c) and names the seam. It is reported
 * rather than hidden, because the same "report more, never less" rule that
 * governs the limits below applies to an ambiguous shape.
 *
 * The selectivity is the evidence the predicate has teeth; a variant matching
 * hundreds of files would be a grep with extra steps.
 *
 * ## What this still cannot see
 *
 * A COPY of the loop pasted into a new module matches the same shape and is
 * caught as a second owner by G8. A loop reached only through a dynamic
 * `import(variable)` is not resolved — `importsOf` reads static specifiers
 * only, the same documented limit `import-graph.mjs` carries. And the three
 * clauses are matched per MODULE, not per block: a module that iterates for an
 * unrelated reason and separately owns a model stream would match. All three
 * limits make the check report MORE, never less.
 */
export const TURN_LOOP_SHAPE = {
  /** A repetition construct: the next turn of the cycle. */
  repetition: /\b(?:while|for)\s*\(/,
  /**
   * Opening a model stream: the model request — either called directly, or
   * through the per-turn model-leg seam that slice S2 introduced. Accepting
   * the seam is what keeps this clause on the RESPONSIBILITY; pinning it to
   * one method name is what let it drift off the real loop entirely.
   */
  modelStream:
    /\.streamChat\s*\(|\b(?:buildTurnModelLeg|createTurnLegModelPort|TurnModelLeg|ModelPort)\b/,
  /** Dispatching a tool: the tool execution and its backfill. */
  toolExecution: /\.execute(?:All)?\s*\(|ToolExecutionPipeline|getRemainingResults/,
};

/** Test trees are not the subject: a test may drive a loop legitimately. */
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isTestPath(relFile) {
  return TEST_PATH.test(relFile);
}

/** Does this module's CODE have the shape of the model/tool/next-turn cycle? */
export function isTurnLoopModule(src) {
  return (
    TURN_LOOP_SHAPE.repetition.test(src) &&
    TURN_LOOP_SHAPE.modelStream.test(src) &&
    TURN_LOOP_SHAPE.toolExecution.test(src)
  );
}

/**
 * Resolve an in-repo specifier to the repo-relative source file it names.
 *
 * `import-graph.mjs`'s `resolveTarget` maps `@duya/x` to `packages/x`, which is
 * the package ROOT; every source file actually lives under `packages/x/src`, so
 * a bare `@duya/ai` never resolved there. Reachability that silently fails to
 * resolve a package edge under-reports, which is the dangerous direction, so the
 * workspace half is resolved here instead.
 *
 * Returns null when nothing resolves — an unresolved specifier is a different
 * gate's finding, and treating it as "no edge" only ever adds reachability back.
 */
export function resolveRepoSpecifier(spec, fromRel, roots = packageRoots()) {
  const candidates = [];
  if (spec.startsWith('@duya/')) {
    const [, pkgDir, ...rest] = spec.split('/');
    const srcDir = [...roots.values()].find((dir) => path.basename(path.dirname(dir)) === pkgDir);
    if (!srcDir) return null;
    const base = path.join(srcDir, ...rest);
    candidates.push(base, base.replace(/\.js$/, ''));
  } else if (spec.startsWith('.')) {
    const base = path.resolve(path.dirname(path.join(REPO_ROOT, fromRel)), spec);
    candidates.push(base, base.replace(/\.js$/, ''));
  } else {
    return null;
  }
  const suffixes = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
  for (const base of candidates) {
    for (const suffix of suffixes) {
      const abs = `${base}${suffix}`;
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return rel(abs);
      } catch {
        // An unreadable candidate is not an edge; the next one may still resolve.
      }
    }
  }
  return null;
}

/**
 * The value-import closure of `entryRel`, as `file -> the file that reached it`.
 *
 * Value edges only: `import type` is erased by the compiler and creates no
 * runtime coupling, so a type-only reference to the old loop is not a way to run
 * it. The parent map is what lets a finding name the SHORTCUT a real violation
 * arrived through, rather than just the module it landed in.
 */
export function reachabilityFrom(entryRel, roots = packageRoots()) {
  const parent = new Map([[entryRel, null]]);
  const queue = [entryRel];
  while (queue.length > 0) {
    const current = queue.shift();
    const abs = path.join(REPO_ROOT, current);
    if (!fs.existsSync(abs)) continue;
    for (const { spec, typeOnly } of importsOf(abs)) {
      if (typeOnly) continue;
      const to = resolveRepoSpecifier(spec, current, roots);
      if (!to || parent.has(to)) continue;
      parent.set(to, current);
      queue.push(to);
    }
  }
  return parent;
}

/**
 * G7 — the worker entry must not DIRECTLY own a turn-loop implementation.
 *
 * ## Why this is not plain reachability
 *
 * The first version of this gate reported every turn-loop-shaped module in the
 * entry's value-import closure. That predicate is not satisfiable, and the
 * measurement is the reason: the worker entry is the process root, so any
 * module the running worker loads by static value import is in its closure BY
 * DEFINITION. Three probes measured it, each injected and reverted:
 *
 *   - loop moved into `packages/agent/**` and value-imported  -> 1 -> 2 findings
 *   - loop moved into `agent-runtime/**` (the owner G8 names) -> 1 -> 2 findings,
 *     because `agent-runtime/src/index.ts` is already in the closure via
 *     `packages/agent/src/process/run-engine-model.ts`
 *   - the entry's direct `DuyaAgent` import removed (G4 fixed) -> still 2,
 *     because `MessageSessionTool.ts:7` value-imports the entry
 *
 * Relocating the loop therefore made the gate WORSE, and the only ways to make
 * a reachability predicate go green were a dynamic `import()` (which
 * `importsOf` cannot see, and which would be gaming the gate rather than
 * changing the architecture) or moving the loop into another process.
 *
 * ## What is actually checkable here
 *
 * The regression this gate exists to catch is the one plan 600 S1a described:
 * the worker entry CONSTRUCTS the loop itself instead of driving the
 * `ExecutionChannel` the runtime owns. That is a statement about the entry and
 * its immediate collaborators, not about the whole graph. So the predicate is
 * now bounded by depth:
 *
 *   - depth 0 (the entry itself) and depth 1 (a module the entry imports
 *     directly) are checked. A loop there is a bypass.
 *   - beyond depth 1 the module is loaded BY the loop's own caller chain, which
 *     is normal and expected: the loop calls tools, tools call back into the
 *     entry, and every real turn goes through that graph.
 *
 * G8 already carries the ownership half (a loop outside `@duya/agent-runtime`
 * is reported per package), so bounded G7 + G8 together still account for both
 * ways the loop can be in the wrong place, and each can actually go green.
 */
export const WORKER_LOOP_MAX_DEPTH = 1;

export function findWorkerLoopReach(entryRel = WORKER_ENTRY, roots = packageRoots(), maxDepth = WORKER_LOOP_MAX_DEPTH) {
  const ifAbsent = path.join(REPO_ROOT, entryRel);
  if (!fs.existsSync(ifAbsent)) return [];
  const depth = importDepthFrom(entryRel, roots, maxDepth);
  const findings = [];
  for (const [file, at] of depth) {
    if (file === entryRel) continue;
    if (isTestPath(file)) continue;
    const abs = path.join(REPO_ROOT, file);
    if (!fs.existsSync(abs)) continue;
    if (!isTurnLoopModule(code(abs))) continue;
    findings.push({
      file,
      from: entryRel,
      via: at.via,
      why: `the worker entry reaches a turn-loop implementation within ${at.depth} import hop(s); the loop belongs to the runtime execution owner, reached through ExecutionChannel`,
    });
  }
  return findings;
}

/**
 * Files within `maxDepth` VALUE-import hops of `entryRel`, as
 * `file -> { via, depth }`.
 *
 * Breadth-first so the first hop recorded is the shortest, which is the hop a
 * finding has to name for the next slice to know which edge to cut.
 */
function importDepthFrom(entryRel, roots, maxDepth) {
  const seen = new Map([[entryRel, { via: entryRel, depth: 0 }]]);
  let frontier = [entryRel];
  for (let d = 1; d <= maxDepth; d += 1) {
    const next = [];
    for (const current of frontier) {
      const abs = path.join(REPO_ROOT, current);
      if (!fs.existsSync(abs)) continue;
      for (const { spec, typeOnly } of importsOf(abs)) {
        if (typeOnly) continue;
        const target = resolveRepoSpecifier(spec, current, roots);
        if (!target || target === entryRel) continue;
        if (seen.has(target)) continue;
        seen.set(target, { via: current, depth: d });
        next.push(target);
      }
    }
    frontier = next;
  }
  return seen;
}


/**
 * The package that is supposed to OWN the loop once plan 600 S2 lands.
 *
 * `@duya/agent-runtime` is the choice because it already owns the port the
 * worker is supposed to implement (`ExecutionChannel`) and the controller that
 * mints `runId`, so it is the only package that can decide a turn without
 * knowing about Project or Session (`00-contracts.md` §A, §D).
 */
export const EXECUTION_OWNER_PACKAGE = '@duya/agent-runtime';

/** Repo-relative source root of a package name, or null. */
function srcRootOf(pkg, roots = packageRoots()) {
  return roots.get(pkg) ?? null;
}

/**
 * G8 — the loop implementation must be owned by the execution owner package.
 *
 * Reported per OWNING PACKAGE rather than per file, so migrating the loop is
 * one deliberate step that clears every file at once, and so the count says
 * "two packages still hold a loop" rather than "two files happen to match a
 * regex".
 */
export function findLoopMisownership(ownerPkg = EXECUTION_OWNER_PACKAGE, roots = packageRoots()) {
  const findings = [];
  for (const [pkg, srcDir] of roots) {
    if (pkg === ownerPkg) continue;
    const holders = [];
    for (const abs of walk(srcDir)) {
      const fileRel = rel(abs);
      if (isTestPath(fileRel)) continue;
      if (isTurnLoopModule(code(abs))) holders.push(fileRel);
    }
    if (holders.length > 0) {
      findings.push({
        file: rel(srcDir),
        table: pkg,
        to: `${EXECUTION_OWNER_PACKAGE} owns the turn loop; this package still holds one`,
        owners: holders.sort(),
      });
    }
  }
  return findings;
}

// ── G6, continued: lifecycle coupling the DDL does not prove ───────────────

/** Where the host keeps its durable stores; also the default G6 scan root. */
export const HOST_DB_DIR = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'main');

/**
 * ## Why the DDL column test is not the question
 *
 * `session_id TEXT NOT NULL` says the COLUMN is mandatory. It does not say the
 * Run's lifecycle is independent of the Session's, and the plan's real claim
 * (`00-contracts.md` §C) is about lifecycle: a Session may be rebuilt, replaced
 * or archived without changing any durable entity. Three couplings break that
 * while the DDL stays exactly as it is, and all three are CODE facts:
 *
 *  1. `CreateRunInput.sessionId: string` — a Run cannot be STARTED without a
 *     Session, because the create input requires the key.
 *  2. `WHERE session_id = ?` over a durable table — the Run's identity is
 *     DERIVED from the Session, so it is only addressable through one.
 *  3. `DELETE FROM <durable table> ... session_id` — archiving a Session DROPS
 *     the Runs, so the durable entity dies with a projection.
 *
 * A fourth is in the DDL but is not a column test: `UNIQUE(session_id)` on
 * `session_goals` caps the table at one row per Session. Nulling the column
 * would not decouple it — a Run-rooted goal still could not exist without
 * consuming the session's slot.
 *
 * Every rule below matches on SQL / TypeScript structure, and every rule has a
 * negative case in `boundary-gates.test.ts` that builds the violation it
 * forbids rather than breaking the detector.
 */
/**
 * Each coupling declares what it is allowed to match, because "a statement
 * scoped by session_id" is only a DURABLE-IDENTITY coupling when the statement
 * names a durable identity table.
 *
 * `session_runtime_locks` is the worked example: it is deleted by session_id
 * all over `stores.ts`, and it is a transient lock — a row that expires and is
 * meant to be swept. Reporting it against G6 would send S1 to migrate a table
 * that has no durable identity at all. `scope: 'statement-table'` restricts the
 * rule to statements naming one of the file's durable tables; `scope: 'file'`
 * is for shapes that are not inside a SQL statement (a TypeScript field), where
 * file scope is the tightest bound available.
 */
export const LIFECYCLE_COUPLINGS = [
  {
    id: 'required-session-key',
    scope: 'file',
    // A non-optional `sessionId: string` / `session_id: string` field: the
    // store's own type contract demands the key, so the row cannot be created
    // without one. The trailing `;` is what makes `sessionId?: string` fail to
    // match, which is the whole difference between the two states, and `m` is
    // what makes `^` mean "start of a line" rather than "start of the file" —
    // without it the rule silently finds nothing past line one, which is the
    // vacuous shape: a gate that reports zero and is believed.
    re: /^[ \t]*(?:readonly[ \t]+)?session_?[iI]d[ \t]*:[ \t]*string[ \t]*;/gm,
    why: 'the durable store requires a session key, so the entity cannot exist without a Session',
  },
  {
    id: 'session-keyed-read',
    scope: 'statement-table',
    // A statement over a durable table whose predicate is the session column:
    // the entity is only addressable through the Session that owns it.
    re: /\b(?:SELECT|UPDATE)[^;]{0,400}?\bFROM\s+\w+[^;]{0,400}?\bWHERE[^;]{0,200}?\bsession_id\b\s*(?:=|\bIN\b|\bLIKE\b)/gis,
    why: 'the durable entity is read through its session, so its identity is derived from a Session',
  },
  {
    id: 'session-scoped-delete',
    scope: 'statement-table',
    // Deleting durable rows scoped by the session column: the classic cascade
    // the DDL cannot express.
    re: /\bDELETE\s+FROM\s+\w+[^;]{0,400}?\bsession_id\b/gis,
    why: 'deleting the durable entity is scoped to a session, so a Session cleanup can drop it',
  },
  {
    id: 'session-unique-constraint',
    scope: 'statement-table',
    // One row per session. Nulling the column does not decouple this.
    re: /\bUNIQUE\s*\(\s*session_id\s*\)/gi,
    why: 'one durable row per Session caps the table, so the entity cannot exist without consuming the Session slot',
  },
];

const TABLE_SQL = /\b(?:FROM|INTO|UPDATE|TABLE\s+IF\s+NOT\s+EXISTS|TABLE)\s+[`"']?(\w+)[`"']?/gi;

/**
 * The durable-identity tables a lifecycle rule applies to, resolved from the
 * DDL rather than assumed — a coupling only matters if the table is durable.
 */
function durableTablesIn(raw) {
  const found = new Set();
  for (const match of raw.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+[`"']?(\w+)[`"']?/gi)) {
    found.add(match[1]);
  }
  return found;
}

/**
 * The SQL or type statement a match sits in.
 *
 * Bounded by the nearest statement delimiter on each side, because a ±400
 * character window spans several statements and attributes a coupling to
 * whichever durable table happens to come first: `UNIQUE(session_id)` on
 * `session_goals` would be filed under `tasks` purely because `tasks` was
 * declared earlier in the file. A finding that names the wrong table sends the
 * next slice to the wrong migration, so the attribution is either exact or null
 * — never a guess.
 */
function enclosingStatement(src, index) {
  const before = src.lastIndexOf(';', index);
  const after = src.indexOf(';', index);
  return src.slice(before < 0 ? 0 : before + 1, after < 0 ? src.length : after);
}

/** The durable table this statement names, or null when it names none. */
function tableOfStatement(statement, owned) {
  const named = [...statement.matchAll(TABLE_SQL)].map((m) => m[1]).filter((n) => owned.includes(n));
  return named[0] ?? null;
}

/**
 * G6 — lifecycle coupling, measured over the modules that own durable tables.
 *
 * Walks the same `apps/desktop/src/main` tree as the DDL rule and keeps only
 * files that actually declare one of `DURABLE_IDENTITY_TABLES`, so a coupling
 * found in an unrelated store is not reported against this gate.
 *
 * `dbDir` is a parameter so the negative cases can point the scan at a fixture
 * store. It defaults to the live tree, and the tests that assert a violation is
 * found always pass their own directory — a fixture scanned against the live
 * tree would prove nothing about the fixture.
 */
export function findLifecycleCouplings(tables = DURABLE_IDENTITY_TABLES, dbDir = HOST_DB_DIR) {
  const findings = [];
  for (const abs of walk(dbDir)) {
    const fileRel = rel(abs);
    if (isTestPath(fileRel)) continue;
    const raw = readSource(abs);
    const declared = durableTablesIn(raw);
    const owned = tables.filter((t) => declared.has(t));
    if (owned.length === 0) continue;
    // SQL lives inside template literals; string literals too, so both the raw
    // text and the comment-stripped text are searched — a coupling inside a
    // `db.prepare(\`...\`)` block must not be lost to a `//` inside it.
    const haystacks = [raw, code(abs)];
    for (const rule of LIFECYCLE_COUPLINGS) {
      for (const haystack of haystacks) {
        // Every match, not the first: `stores.ts` scopes two different durable
        // tables by session (`DELETE FROM tasks` and `DELETE FROM
        // session_goals`), and stopping at the first would report one coupling
        // where there are two.
        for (const match of haystack.matchAll(rule.re)) {
          const table = tableOfStatement(enclosingStatement(haystack, match.index), owned);
          // A `statement-table` rule that lands on a statement naming no
          // durable identity table is not this gate's business: the file owns a
          // durable table somewhere, but THIS statement is about something
          // else. Skipping keeps the gate from pointing S1 at a lock table.
          if (rule.scope === 'statement-table' && table === null) continue;
          findings.push({
            // `table` is the durable table this exact statement names, and is
            // null only for `scope: 'file'` rules — a TypeScript field
            // declaration is not inside a SQL statement at all. `scopedTo`
            // records the file's durable tables so a null stays readable.
            table,
            scopedTo: owned.join('+'),
            file: fileRel,
            coupling: rule.id,
            column: rule.why,
            database: databaseOfFile(fileRel),
          });
        }
        break;
      }
    }
  }
  // One finding per (file, coupling, table): the same coupling on two durable
  // tables in one file is two subjects, while the same coupling matched twice on
  // ONE table is one. The fingerprint carries no line number, so collapsing by
  // table is what keeps the two apart without reintroducing the line drift that
  // once produced false regressions.
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.file}|${f.coupling}|${f.table ?? f.scopedTo}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── G9 — a `core` classification has to survive measurement ────────────────

/**
 * IO primitives, kept in step with `layer-purity.ts`'s `IO_PRIMITIVES`.
 *
 * Duplicated rather than imported because `layer-purity.ts` is TypeScript and
 * this gate must run under plain `node` (there is no `tsx` in this repo). The
 * duplication is deliberate and bounded: both lists encode the same published
 * definition, and the cross-check that matters is measured, not assumed — G9 and
 * G2 independently find the SAME six `@duya/ai` files, by different routes
 * (transitive reachability vs. a direct scan), which is the evidence that the
 * two have not drifted apart in a way that hides IO.
 *
 * `this.fetchFn(` is deliberately NOT matched: an injected transport is the
 * point of the exercise, and `system-one/client.ts` is the working example.
 */
export const IO_PRIMITIVES = [
  { name: 'fetch', re: /(?<![\w.$])fetch\s*\(/ },
  { name: 'globalThis.fetch', re: /globalThis\s*\.\s*fetch\s*\(/ },
  { name: 'node:http', re: /from\s+['"]node:https?['"]/ },
  { name: 'node:net', re: /from\s+['"]node:net['"]/ },
  { name: 'node:fs', re: /from\s+['"](?:node:)?fs(?:\/promises)?['"]/ },
  { name: 'node:fs/promises', re: /from\s+['"]node:fs\/promises['"]/ },
  { name: 'node:crypto', re: /from\s+['"]node:crypto['"]/ },
  { name: 'node:child_process', re: /from\s+['"]node:child_process['"]/ },
  { name: 'node:worker_threads', re: /from\s+['"]node:worker_threads['"]/ },
  { name: 'node:os', re: /from\s+['"]node:os['"]/ },
  { name: 'node:process', re: /from\s+['"]node:process['"]/ },
  { name: 'setTimeout/setInterval', re: /(?<![\w.$])(?:setTimeout|setInterval)\s*\(/ },
  { name: 'WebSocket', re: /(?<![\w.$])new\s+WebSocket\s*\(/ },
];

/** Which IO primitives (if any) this module's code actually calls. */
export function ioPrimitivesIn(src) {
  return IO_PRIMITIVES.filter((p) => p.re.test(src)).map((p) => p.name);
}

/**
 * G9 — a package classified `core` must not be able to REACH IO.
 *
 * `00-contracts.md` §A.3: a mixed package must be split into a pure core export
 * and an adapter export, and may not be made core-reachable by relabelling it.
 * A layer table cannot enforce that by itself
 * — the table only says which label a package wears — so this measures the
 * property the label is asserting: start at the package's public entry and walk
 * the value-import closure, and report any module in it that performs IO.
 *
 * This is what makes the `@duya/ai` classification falsifiable. G1's layer table
 * calls the package core; G9 asks whether that is true, and today it is not:
 * `@duya/ai`'s single barrel reaches six IO-performing modules. Until S5 splits
 * the package into a pure core export and an adapter export, those six are the
 * price of the convenient classification, recorded rather than hidden.
 */
export function findCoreIoReach(layer = 'core', roots = packageRoots()) {
  const findings = [];
  const pkgs = LAYERS.find((l) => l.name === layer)?.packages ?? [];
  for (const pkg of pkgs) {
    const srcDir = srcRootOf(pkg, roots);
    if (!srcDir) continue;
    const entry = rel(path.join(srcDir, 'index.ts'));
    const reachable = reachabilityFrom(entry, roots);
    for (const file of reachable.keys()) {
      if (isTestPath(file)) continue;
      const abs = path.join(REPO_ROOT, file);
      if (!fs.existsSync(abs)) continue;
      const primitives = ioPrimitivesIn(code(abs));
      if (primitives.length === 0) continue;
      findings.push({
        file,
        from: pkg,
        to: primitives.sort().join('+'),
        why: `${pkg} is classified ${layer} but its public entry reaches IO`,
      });
    }
  }
  return findings;
}

// ── G6 ──────────────────────────────────────────────────────────────────────

export const DURABLE_IDENTITY_TABLES = ['runs', 'tasks', 'session_goals'];

/** `db/core/**` is duya-core.db; the rest of db/ is duya-main.db. */
export function databaseOfFile(relFile) {
  return relFile.includes('/db/core/') ? 'core.db' : 'main.db';
}

/** DDL that exists but has no reader or writer. */
export const DEAD_TABLE_DEFINITIONS = [
  { file: 'apps/desktop/src/main/db/schema.ts', table: 'tasks', database: 'main.db' },
];

export function findSessionRootedTables(tables = DURABLE_IDENTITY_TABLES, dir = HOST_DB_DIR) {
  const findings = [];
  const dbDir = dir;
  const isDead = (file, table) =>
    DEAD_TABLE_DEFINITIONS.some((d) => d.file === file && d.table === table);
  for (const file of walk(dbDir)) {
    const raw = readSource(file);
    for (const table of tables) {
      const create = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\s*\\);`, 'g');
      let m;
      while ((m = create.exec(raw)) !== null) {
        const bodyStartLine = raw.slice(0, m.index).split(/\r?\n/).length;
        const fileRel = rel(file);
        const database = databaseOfFile(fileRel);
        m[1].split(/\r?\n/).forEach((row, i) => {
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

// ── report + baseline ───────────────────────────────────────────────────────

export function collectBoundaryReport() {
  return [
    { gate: 'G1', title: 'no reverse dependency edge between layers', findings: findReverseEdges() },
    { gate: 'G3', title: 'runtime does not reach into host internals', findings: findRuntimeHostLeaks() },
    {
      gate: 'G4',
      title: 'worker implements ExecutionChannel, not DuyaAgent',
      findings: findWorkerSeamBypasses(),
    },
    {
      gate: 'G6',
      title: 'durable identity is not rooted at session_id',
      // The DDL column rule and the lifecycle rules answer different questions
      // and are reported under one gate because they are one contract. A fix
      // that nulls `session_id` without touching the lifecycle leaves this gate
      // RED, which is the entire point: the column was never the claim.
      findings: [...findSessionRootedTables(), ...findLifecycleCouplings()],
    },
    {
      gate: 'G7',
      title: 'worker entry does not reach the turn-loop implementation',
      findings: findWorkerLoopReach(),
    },
    {
      gate: 'G8',
      title: 'the turn loop is owned by the runtime execution package',
      findings: findLoopMisownership(),
    },
    {
      gate: 'G9',
      title: 'a core-classified package cannot reach IO',
      findings: findCoreIoReach(),
    },
  ];
}

export const BASELINE_PATH = path.join(REPO_ROOT, 'scripts', 'architecture', 'boundary-gates-baseline.json');

/**
 * Identity for one finding, used as the baseline key.
 *
 * ## The line number is deliberately NOT part of this
 *
 * An earlier version keyed on `gate|file|line|identity`, reasoning that a
 * moved violation is a rewritten table and S1 should look at it. Measured
 * against 134 upstream commits that reasoning was wrong: every one of those
 * commits shifted line numbers in files nobody had touched, and the gate
 * reported 3 regressions where the real change was 0. Every NEW had a
 * matching FIXED at the same file — pure drift, reported as breakage.
 *
 * A line number is not an identity. What identifies a violation is WHAT it
 * is and WHERE the subject is: which gate, which file, and which of the
 * few discriminating attributes (the imported symbol, the table, the column).
 * That is stable across reformatting and upstream churn, and it still
 * distinguishes the two findings in the same file that a message-only
 * comparison would merge.
 *
 * If a violation genuinely moves to a different file or changes its subject,
 * the key changes and the gate fails — which is the case worth failing on.
 *
 * The discriminator is the FIRST defined attribute, in the order below, because
 * each gate has a different notion of "the same subject twice in one place":
 * G4 spells one subject two ways (`DuyaAgent` and `duyaAgent`), G6 finds the
 * same table coupled in two different ways, G8 names one owning package per
 * file, and G9 names one package per reachable module. Each of those is
 * deliberately a DIFFERENT field from the middle column — a discriminator that
 * repeats it would append the same text twice and pad the key for nothing.
 */
export function fingerprint(report, finding) {
  const f = finding ?? {};
  const discriminator = f.symbol ?? f.coupling ?? f.database ?? f.table ?? f.from ?? '';
  return [report.gate, String(f.file ?? f.table ?? '?'), String(f.to ?? f.column ?? f.why ?? ''), discriminator]
    .filter(Boolean)
    .join('|');
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return new Set();
  const data = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  return new Set(data.entries ?? []);
}

export function evaluate(reports = collectBoundaryReport(), override) {
  const baseline = override ?? readBaseline();
  const seen = new Set();
  const outcomes = reports.map((report) => {
    // Dedupe by key: two findings that resolve to the same key are one
    // subject, and counting them twice would report "known: 3" for a defect
    // that exists once.
    const keys = [...new Set(report.findings.map((f) => fingerprint(report, f)))];
    const known = [];
    const newFindings = [];
    for (const key of keys) {
      seen.add(key);
      (baseline.has(key) ? known : newFindings).push(key);
    }
    return { gate: report.gate, title: report.title, known: known.length, newFindings, stale: [] };
  });
  return outcomes.map((o) => ({
    ...o,
    stale: [...baseline].filter((k) => k.startsWith(`${o.gate}|`) && !seen.has(k)),
  }));
}

export function writeBaseline(reports = collectBoundaryReport()) {
  // A Set, not a sort: the same key can be produced more than once (G4 matches
  // two symbol spellings on one import line, G6 finds the same table declared
  // in two databases), and writing the duplicate would imply two independent
  // findings where there is one subject.
  const entries = [...new Set(reports.flatMap((r) => r.findings.map((f) => fingerprint(r, f))))].sort();
  fs.writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        $comment:
          'Plan 600 boundary-gate baseline. Entries are KNOWN findings, recorded so the gate fails only on NEW ones while G4/G6 stay open. Regenerate with `npm run architecture:boundaries -- --write` after a fix and review the diff: a shrinking set is a real fix, an unchanged one means nothing moved.',
        gate: 'plan-600-boundaries',
        entries,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  process.stdout.write(`wrote ${entries.length} fingerprints to ${rel(BASELINE_PATH)}\n`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    writeBaseline();
    process.exit(0);
  }
  const outcomes = evaluate();
  let newTotal = 0;
  for (const o of outcomes) {
    newTotal += o.newFindings.length;
    process.stdout.write(
      `${o.gate} ${o.newFindings.length === 0 ? 'BASELINED' : 'NEW'} — ${o.title}\n` +
        `    known: ${o.known}   new: ${o.newFindings.length}   stale: ${o.stale.length}\n`,
    );
    for (const k of o.newFindings) process.stdout.write(`    NEW    ${k}\n`);
    for (const k of o.stale) process.stdout.write(`    FIXED  ${k}\n`);
  }
  if (newTotal > 0) {
    process.stdout.write(`\n${newTotal} new finding(s) not in the baseline — these are regressions.\n`);
    process.exit(1);
  }
  process.stdout.write('\nno new findings. Known defects remain recorded in the baseline.\n');
  process.exit(0);
}
