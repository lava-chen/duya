#!/usr/bin/env node
/**
 * bot-boundary-gate.mjs — the Bot-boundary slice of the personal-agent
 * framework plan (docs/exec-plans/active/2026-10-25-personal-bot-framework.md,
 * slice S0; contract in docs/design-docs/personal-bot-framework.md §4).
 *
 * ## Why this gate exists before the package does
 *
 * The plan's S0 slice is "boundary and behavior baseline": the `@duya/bot`
 * package is NOT extracted yet (that is S2), but the direction rules that the
 * extraction depends on are decided NOW:
 *
 *   - `@duya/bot` may depend only on `@duya/agent-protocol` and the pure
 *     `@duya/agent-core` interfaces it actually reuses — no host, no runtime,
 *     no data, no memory, no Electron, no SQLite.
 *   - `host → bot` is the only upward edge; `agent-core`, `agent-runtime`,
 *     `agent-protocol`, `data` and `memory` must not import bot.
 *   - Clients (`packages/ui`, `packages/client-core`) talk to protocol and
 *     client projections only — never to the host composition layer.
 *
 * The design doc states the acceptance in one line: "the gate must cover all
 * source imports, subpaths and transitive closures of the new package, and the
 * reverse edges Bot→Host, core/runtime→Bot and UI→Host must turn red" — and
 * the ownership is enforced by the gate implementation, not by a YAML claim.
 * Proving those edges CAN go red, while the live tree is green, is exactly
 * what `bot-boundary-gate.test.ts` does with fixtures; this file only has to
 * make the rules real and the measurement honest.
 *
 * ## The three rules
 *
 * R1 (bot downward) — when `packages/bot/src/` exists on the tree, every
 *     non-test source file in it is a seed, and any VALUE import a seed
 *     makes that resolves outside `{ bot, @duya/agent-protocol,
 *     @duya/agent-core }` is a finding, named by file and specifier. Seeds
 *     cover all source files rather than a barrel entry, so a subpath that
 *     dodges `index.ts` is still scanned; and because every bot file is a
 *     seed, the first hop of any forbidden path is a bot file — the finding
 *     names the edge to sever directly. Traversal deliberately does NOT
 *     continue into the allowed packages: what `@duya/agent-core` itself
 *     imports is agent-core's own gates' business, and charging those edges
 *     to bot would misplace the ownership the boundary is drawn to
 *     establish. While the package does not exist the rule reports
 *     `pending` — the honest S0/S1 state, distinct from both clean and
 *     blind.
 *
 * R2 (no reverse into bot) — a direct value-import edge from the five
 *     downward packages into `packages/bot/` is a finding. "The runtime does
 *     not know bot exists" is an import statement, so a direct-edge scan is
 *     the precise semantics; a closure walk from those packages would drown
 *     the signal in the hundreds of legal edges they have. Vacuously green
 *     until the package exists.
 *
 * R3 (client axis) — a value-import edge from `packages/ui/` or
 *     `packages/client-core/` into `packages/host/` or the Desktop main,
 *     preload or renderer trees is a finding. This is the Bot-boundary slice
 *     of the client axis: 622 card 05 owns the general client reverse gate
 *     (including the `packages/cli` entries that legitimately start a local
 *     host), so this rule deliberately does NOT cover `packages/cli`. The
 *     edge census on the tree this gate was written on: 0.
 *
 * ## Blindness, and how each rule is kept from faking green
 *
 * A resolver break or a renamed root collapses every count to zero and turns
 * "no findings" into "enforced nothing". Each rule therefore carries a
 * measured floor: R3 counts the ui + client-core source files the graph
 * actually opened (floor 100 of 887 measured on the writing tree), R2 counts
 * the five downward packages' source files (floor 100 of 350), and R1 counts
 * the bot source files it walked (a package directory with no scannable
 * source is `blind`, never clean). The floors are set far below today's
 * counts on purpose — they exist to catch a walker that stopped walking, not
 * to pin a package's size.
 *
 * ## The census
 *
 * `--census` prints the CURRENT bot surface: the module groups the migration
 * table names (host prompts/tools/config, data pending-wakes, protocol wake,
 * desktop wake/channels/automation, ui bot chat) with their member counts and
 * non-test consumers, derived from the same import graph the gates use. It is
 * the reproducible form of the S0 consumer inventory — a probe, exit 0, not a
 * gate — and the test file asserts the groups stay discoverable so the
 * patterns cannot rot silently.
 *
 * ## What is NOT claimed
 *
 * Third-party packages that themselves import forbidden modules are invisible
 * (the walk stops at specifiers that do not resolve inside the repo), dynamic
 * `import(variable)` is unseen, and a type-only import is not a runtime edge —
 * counted as `typeOnlyRefs`, never a finding. Same limits as every closure
 * gate in this directory, inherited on purpose rather than re-derived.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, importsOf, rel, walk } from './import-graph.mjs';
import { isTestPath, resolveRepoSpecifier } from './boundary-gates.mjs';

/** The future package, and the only workspace packages it may depend on. */
export const BOT_PACKAGE_DIR = 'packages/bot/';
export const BOT_PACKAGE_SRC = 'packages/bot/src/';
export const BOT_ALLOWED_PACKAGES = ['@duya/agent-protocol', '@duya/agent-core'];

/** R2 — packages that must not learn bot exists. Host is the only upward edge. */
export const REVERSE_FROM_PACKAGES = [
  '@duya/agent-protocol',
  '@duya/agent-core',
  '@duya/agent-runtime',
  '@duya/data',
  '@duya/memory',
];

/** R3 — the client surfaces, and the composition/run layers they must not reach. */
export const CLIENT_AXIS_FROM_DIRS = ['packages/ui/', 'packages/client-core/'];
export const CLIENT_AXIS_FORBIDDEN_DIRS = [
  'packages/host/',
  'apps/desktop/src/main/',
  'apps/desktop/src/preload/',
  'apps/desktop/src/renderer/',
];

/**
 * Measured floors, not size pins (see the header). The two numbers in each
 * comment are the counts on the tree this gate was written on.
 */
export const CLIENT_AXIS_MIN_SCANNED = 100; // 887 measured
export const REVERSE_MIN_SCANNED = 100; // 350 measured

const PACKAGE_SRC_DIRS = new Map(
  BOT_ALLOWED_PACKAGES.map((name) => [name, `packages/${name.slice('@duya/'.length)}/src/`]),
);

/**
 * Which known owner a repo-relative file belongs to, for reporting.
 *
 * Unknown repo paths still need a name — a finding that says `other` is
 * actionable as long as `file` names the edge; the owner is the summary, the
 * file is the cause.
 */
export function botClosureOwnerOf(fileRel) {
  if (fileRel.startsWith(BOT_PACKAGE_DIR)) return '@duya/bot';
  for (const [name, dir] of PACKAGE_SRC_DIRS) {
    if (fileRel.startsWith(dir)) return name;
  }
  const m = fileRel.match(/^packages\/([^/]+)\//);
  if (m) return `@duya/${m[1]}`;
  if (fileRel.startsWith('apps/desktop/')) return 'apps/desktop';
  if (fileRel.startsWith('apps/')) return fileRel.split('/')[0] + '/' + fileRel.split('/')[1];
  if (fileRel.startsWith('evals/')) return 'evals';
  if (fileRel.startsWith('scripts/')) return 'scripts';
  return 'other';
}

/**
 * Read a file's imports with one retry.
 *
 * On this repository's Windows checkouts a single `fs.readFileSync` inside a
 * large walk fails with `UNKNOWN` every so often — an editor or antivirus
 * holds the file for a moment. A crash on that is a flaky gate; a silent skip
 * is a blind one. The middle path: retry once, then count the file in the
 * rule's `unreadable` so the report carries the hole instead of hiding it.
 * A mass failure drops the rule's `scanned` below its floor and the gate goes
 * BLIND — the floors exist for exactly that.
 */
function readImports(relFile) {
  const abs = path.join(ROOT, relFile);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { imports: importsOf(abs), unreadable: false };
    } catch {
      // Retry once; the fall-through below records the failure.
    }
  }
  return { imports: [], unreadable: true };
}

/**
 * The bot package's scannable source files, or `[]` when it does not exist.
 *
 * Seeds come from the FILESYSTEM, not from a manifest: the rule has to work
 * the day `packages/bot/src/` appears, and the day it is half-scaffolded. Test
 * files are excluded by the same `isTestPath` rule every closure gate here
 * applies — a test may construct anything.
 */
export function botSourceFiles(botSrcDir = BOT_PACKAGE_SRC) {
  const abs = path.join(ROOT, botSrcDir);
  if (!fs.existsSync(abs)) return [];
  // `walk` yields ABSOLUTE paths; `rel` is the one converter that produces the
  // repo-relative form every downstream comparison (prefix match, path.join
  // back to an absolute path) is written against. A hand-rolled
  // `split(path.sep).join('/')` yields an absolute path with forward slashes —
  // which matches no `packages/...` prefix AND, worse, makes
  // `path.join(ROOT, file)` a double path that every read rejects. The first
  // draft shipped exactly that bug and the census reported an empty surface
  // while the rules scanned nothing; this call site is why `rel` is mandatory.
  return walk(abs).map(rel).filter((f) => !isTestPath(f));
}

/**
 * R1 — the bot package's own imports, over ALL of its source files.
 *
 * Seeds are every non-test source file under `packages/bot/src/`, so "subpath
 * escapes through a module the barrel does not re-export" is not a thing: a
 * violation is any VALUE import a bot file makes that resolves outside
 * `{ bot, @duya/agent-protocol, @duya/agent-core }`. Because every bot file
 * is a seed, the first hop of any forbidden path is always a bot file — the
 * finding names the file and the specifier to sever, and no chain-walking
 * can add information. Traversal deliberately does NOT continue into the
 * allowed packages: what `@duya/agent-core` itself imports is agent-core's
 * own gates' business, and charging those edges to bot would misplace the
 * ownership the boundary is drawn to establish.
 *
 * Type-only references to forbidden packages are counted (`typeOnlyRefs`),
 * never findings — erased by tsc, not a runtime coupling.
 */
export function botClosureRule(botSrcDir = BOT_PACKAGE_SRC) {
  const present = fs.existsSync(path.join(ROOT, BOT_PACKAGE_DIR));
  const seeds = botSourceFiles(botSrcDir);
  if (seeds.length === 0) {
    return {
      present,
      status: present ? 'blind' : 'pending',
      seeds: 0,
      walked: 0,
      unreadable: 0,
      findings: [],
      typeOnlyRefs: [],
      summary: present
        ? `blind: ${BOT_PACKAGE_SRC} has no scannable non-test source`
        : `pending: ${BOT_PACKAGE_DIR} is not on this tree (S0/S1 expected state)`,
    };
  }

  const findings = [];
  const typeOnlyRefs = [];
  let unreadable = 0;
  for (const file of seeds) {
    const { imports, unreadable: failed } = readImports(file);
    if (failed) {
      unreadable += 1;
      continue;
    }
    for (const { spec, typeOnly } of imports) {
      const to = resolveRepoSpecifier(spec, file);
      if (to === null) continue;
      const owner = botClosureOwnerOf(to);
      const forbidden = owner !== '@duya/bot' && !BOT_ALLOWED_PACKAGES.includes(owner);
      if (typeOnly) {
        if (forbidden) typeOnlyRefs.push({ file, spec, owner });
        continue;
      }
      if (forbidden) findings.push({ owner, from: file, spec, to });
    }
  }
  findings.sort((a, b) => a.owner.localeCompare(b.owner) || a.from.localeCompare(b.from));

  return {
    present,
    status: 'measured',
    seeds: seeds.length,
    walked: seeds.length,
    unreadable,
    findings,
    typeOnlyRefs,
    summary: `${findings.length} forbidden edge(s) across ${seeds.length} bot source file(s)`,
  };
}

/**
 * The import edges this gate scans, rebuilt here rather than reusing
 * `buildGraphs()`: the census and the edge rules want the SAME edge shape but
 * not the SCC pass, and a private rebuild keeps the fixture tests able to run
 * the scan over the live tree plus a fixture without re-walking everything.
 * Type edges are returned alongside value edges so a rule can count
 * type-only references without re-parsing every file a second time.
 */
function importsFrom(fromDirs) {
  const valueEdges = [];
  const typeRefs = [];
  const scannedFiles = new Set();
  let unreadable = 0;
  for (const dir of fromDirs) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const fileAbs of walk(abs)) {
      const from = rel(fileAbs);
      if (isTestPath(from)) continue;
      const { imports, unreadable: failed } = readImports(from);
      // `scanned` is the blindness denominator, so it counts files whose
      // imports were actually READ. Counting the walk instead is how the
      // first draft faked a green while every read failed.
      if (failed) {
        unreadable += 1;
        continue;
      }
      scannedFiles.add(from);
      for (const { spec, typeOnly } of imports) {
        const to = resolveRepoSpecifier(spec, from);
        if (to === null) continue;
        if (typeOnly) typeRefs.push({ from, spec, to });
        else valueEdges.push({ from, spec, to });
      }
    }
  }
  return { valueEdges, typeRefs, scannedFiles: [...scannedFiles], unreadable };
}

function clientAxisForbiddenTarget(to) {
  for (const dir of CLIENT_AXIS_FORBIDDEN_DIRS) {
    if (to.startsWith(dir)) return dir;
  }
  return null;
}

/**
 * R2 — direct value edges from the five downward packages into the bot tree.
 * `scanned` is the blindness denominator: the source files actually opened.
 */
export function reverseIntoBotRule(botDir = BOT_PACKAGE_DIR) {
  const { valueEdges, scannedFiles, unreadable } = importsFrom(REVERSE_FROM_PACKAGES.map((n) => `packages/${n.slice('@duya/'.length)}/src/`));
  const findings = valueEdges
    .filter((e) => e.to.startsWith(botDir))
    .map((e) => ({ from: e.from, spec: e.spec, to: e.to }));
  return {
    scanned: scannedFiles.length,
    blind: scannedFiles.length < REVERSE_MIN_SCANNED,
    unreadable,
    findings,
    summary: `${findings.length} reverse edge(s) into ${botDir} over ${scannedFiles.length} scanned file(s)`,
  };
}

/**
 * R3 — direct value edges from the client surfaces into the host composition
 * layer or the Desktop main/preload/renderer trees. Type-only references are
 * counted (`typeOnlyRefs`), never findings.
 */
export function clientAxisRule() {
  const { valueEdges, typeRefs, scannedFiles, unreadable } = importsFrom(CLIENT_AXIS_FROM_DIRS);
  const findings = [];
  for (const e of valueEdges) {
    const target = clientAxisForbiddenTarget(e.to);
    if (target !== null) findings.push({ from: e.from, spec: e.spec, to: e.to, target });
  }
  const typeOnlyRefs = [];
  for (const ref of typeRefs) {
    const target = clientAxisForbiddenTarget(ref.to);
    if (target !== null) typeOnlyRefs.push({ file: ref.from, spec: ref.spec, target });
  }
  return {
    scanned: scannedFiles.length,
    blind: scannedFiles.length < CLIENT_AXIS_MIN_SCANNED,
    unreadable,
    findings,
    typeOnlyRefs,
    summary: `${findings.length} client-axis edge(s) over ${scannedFiles.length} scanned file(s)`,
  };
}

/**
 * The whole-gate verdict.
 *
 * R1 `pending` (package not extracted yet) does not fail the gate — that is
 * the S0/S1 state this slice is executed from — but it is REPORTED as pending,
 * so the gate cannot be mistaken for one that measures the bot package. A
 * present-but-blind R1, a blind R2/R3, or any finding fails.
 */
export function isBotBoundaryClean(report) {
  const r1 = report.botClosure;
  const r1ok = r1.status === 'pending' || (r1.status === 'measured' && r1.findings.length === 0);
  const r2ok = !report.reverseIntoBot.blind && report.reverseIntoBot.findings.length === 0;
  const r3ok = !report.clientAxis.blind && report.clientAxis.findings.length === 0;
  return r1ok && r2ok && r3ok;
}

export function collectBotBoundaryReport() {
  const botClosure = botClosureRule();
  const reverseIntoBot = reverseIntoBotRule();
  const clientAxis = clientAxisRule();
  return {
    botClosure,
    reverseIntoBot,
    clientAxis,
    clean: isBotBoundaryClean({ botClosure, reverseIntoBot, clientAxis }),
  };
}

/* ------------------------------------------------------------------ */
/* Census — the reproducible S0 consumer inventory. A probe, not a gate. */
/* ------------------------------------------------------------------ */

/**
 * The bot surface groups the migration table names. Patterns are anchored to
 * the CURRENT tree on purpose: the census documents where bot ownership lives
 * today, and a slice that moves a group updates its pattern here in the same
 * PR — a silent drift would be exactly the kind the census exists to surface.
 */
export const BOT_SURFACE_GROUPS = [
  { name: 'host/worker-prompts/bot', match: (f) => f.startsWith('packages/host/src/worker-prompts/bot/') },
  { name: 'host/worker-prompts/configs/bot', match: (f) => f === 'packages/host/src/worker-prompts/configs/bot.ts' },
  { name: 'host/worker-tools/bot-builtin', match: (f) => f === 'packages/host/src/worker-tools/bot-builtin.ts' },
  { name: 'host/config-agents/bot-*', match: (f) => /^packages\/host\/src\/config-agents\/bot-/.test(f) },
  { name: 'host/local-pending-wakes-api', match: (f) => f === 'packages/host/src/local-pending-wakes-api.ts' },
  { name: 'data/pending-wakes', match: (f) => f === 'packages/data/src/pending-wakes.ts' },
  { name: 'protocol/wake*', match: (f) => /^packages\/agent-protocol\/src\/(wake|pending-wakes)\.ts$/.test(f) },
  { name: 'desktop/config/bot-*', match: (f) => /^apps\/desktop\/src\/main\/config\/bot-/.test(f) },
  { name: 'desktop/wake/*', match: (f) => f.startsWith('apps/desktop/src/main/wake/') },
  { name: 'desktop/channels/*', match: (f) => f.startsWith('apps/desktop/src/main/channels/') },
  { name: 'desktop/automation/*', match: (f) => f.startsWith('apps/desktop/src/main/automation/') },
  { name: 'desktop/ipc/bot-*', match: (f) => /^apps\/desktop\/src\/main\/ipc\/bot-/.test(f) },
  { name: 'ui/chat/bot* (components)', match: (f) => /^packages\/ui\/src\/components\/chat\/(bot\/|Bot[A-Z])/.test(f) },
];

/**
 * The reverse graph, computed over the type edges: a consumer that only
 * type-imports a bot module is still a migration consumer, so the census is
 * deliberately WIDER than the runtime rules above.
 */
function buildReverseTypeGraph() {
  const reverse = new Map();
  let unreadable = 0;
  const allFiles = [];
  for (const root of ['apps', 'packages']) {
    const abs = path.join(ROOT, root);
    if (fs.existsSync(abs)) allFiles.push(...walk(abs));
  }
  for (const fileAbs of allFiles) {
    const from = rel(fileAbs);
    const { imports, unreadable: failed } = readImports(from);
    if (failed) unreadable += 1;
    for (const { spec } of imports) {
      const to = resolveRepoSpecifier(spec, from);
      if (to === null) continue;
      if (!reverse.has(to)) reverse.set(to, new Set());
      reverse.get(to).add(from);
    }
  }
  return { reverse, unreadable };
}

/**
 * The census rows: per group, the members and the non-test files that import
 * them. Consumers inside the same group are not counted — a group's own
 * barrel is not a consumer.
 */
export function botCensus() {
  const { reverse, unreadable } = buildReverseTypeGraph();
  const rows = [];
  for (const group of BOT_SURFACE_GROUPS) {
    const members = [];
    for (const dir of ['apps', 'packages']) {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      for (const fileAbs of walk(abs)) {
        const f = rel(fileAbs);
        if (group.match(f)) members.push(f);
      }
    }
    members.sort();
    const consumers = new Set();
    for (const member of members) {
      for (const consumer of reverse.get(member) ?? []) {
        if (isTestPath(consumer)) continue;
        if (members.includes(consumer)) continue;
        consumers.add(consumer);
      }
    }
    rows.push({
      group: group.name,
      members: members.length,
      consumers: [...consumers].sort(),
      consumerCount: consumers.size,
    });
  }
  return { rows, unreadable };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--census')) {
    const { rows, unreadable } = botCensus();
    for (const row of rows) {
      process.stdout.write(
        `${row.group}  members=${row.members} consumers=${row.consumerCount}\n`,
      );
      for (const c of row.consumers.slice(0, 12)) process.stdout.write(`    <- ${c}\n`);
      if (row.consumers.length > 12) {
        process.stdout.write(`    ... and ${row.consumers.length - 12} more\n`);
      }
    }
    if (unreadable > 0) {
      process.stdout.write(`census  WARNING ${unreadable} file(s) unreadable (transient lock?) — consumer edges may be undercounted\n`);
    }
    process.exit(0);
  }

  const report = collectBotBoundaryReport();
  const r1 = report.botClosure;
  process.stdout.write(`R1 (bot downward)      ${r1.status.toUpperCase().padEnd(9)} ${r1.summary}\n`);
  if (r1.unreadable > 0) {
    process.stdout.write(`    WARNING ${r1.unreadable} closure file(s) unreadable (transient lock?) — re-run before trusting a green\n`);
  }
  for (const f of r1.findings) {
    process.stdout.write(`    ${f.owner}: ${f.from} imports '${f.spec}' -> ${f.to}\n`);
  }
  for (const ref of r1.typeOnlyRefs) {
    process.stdout.write(`    (type-only, not counted) ${ref.file} imports '${ref.spec}'\n`);
  }

  const r2 = report.reverseIntoBot;
  process.stdout.write(
    `R2 (no reverse into bot) ${r2.blind ? 'BLIND' : 'OK'.padEnd(9)} ${r2.summary}\n`,
  );
  if (r2.unreadable > 0) {
    process.stdout.write(`    WARNING ${r2.unreadable} file(s) unreadable (transient lock?) — re-run before trusting a green\n`);
  }
  for (const f of r2.findings) process.stdout.write(`    ${f.from} -> ${f.to} ('${f.spec}')\n`);

  const r3 = report.clientAxis;
  process.stdout.write(
    `R3 (client axis)       ${r3.blind ? 'BLIND' : 'OK'.padEnd(9)} ${r3.summary}\n`,
  );
  if (r3.unreadable > 0) {
    process.stdout.write(`    WARNING ${r3.unreadable} file(s) unreadable (transient lock?) — re-run before trusting a green\n`);
  }
  for (const f of r3.findings) {
    process.stdout.write(`    ${f.from} -> ${f.to} ('${f.spec}')\n`);
  }
  for (const ref of r3.typeOnlyRefs) {
    process.stdout.write(`    (type-only, not counted) ${ref.file} imports '${ref.spec}'\n`);
  }

  process.stdout.write(
    `bot-boundary  ${report.clean ? 'PASS' : 'FAIL'}\n`,
  );
  process.exit(report.clean ? 0 : 1);
}
