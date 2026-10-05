#!/usr/bin/env node
/**
 * headless-load-gate.mjs — plan 610 gate A1: can the CLI control plane's
 * handler layer be loaded by a process that has NO Electron runtime?
 *
 * ## Two layers, because a name scan has already failed this repo once
 *
 * `01-headless-control-plane.md` §3.1 requires BOTH:
 *
 *   - **A1a (static)** — no module in the scoped set carries a hard
 *     `import ... from 'electron'`. A hard import throws at EVALUATION time,
 *     which is exactly what a headless process cannot survive.
 *   - **A1b (behavioral)** — a child process in which `require('electron')`
 *     THROWS must actually load the graph. Only this one proves the claim;
 *     A1a is its fast precondition. The plan is explicit that a green A1a with
 *     no A1b does not count as A1 being done.
 *
 * 600's G4 is the precedent: it scanned for the NAME `DuyaAgent` and went
 * green while the loop was still reached through an adapter. A1a is therefore
 * never the only witness, and A1a itself is corroborated by a second,
 * independent source — esbuild's metafile, which classifies each import edge
 * as `import-statement` (evaluated with the module) or `require-call`
 * (deferred to a call site) with no opinion from the scanner below.
 *
 * ## Scope, stated on every number, because the real closure is far bigger
 *
 * Measured on this tree (205a4cd4, plan 610 slice B1):
 *
 *   - 6 files in `apps/desktop/src/main/cli/handlers/` carry a hard electron
 *     import — exactly the six named by `00-contracts.md` §0 row 1
 *     (backup/extra/extra2/security/status/update). This is the subject A1 is
 *     scoped to, and the whole of what that slice may decide.
 *   - 45 files OUTSIDE the layer do as well (`core/window-manager.ts` ->
 *     BrowserWindow/dialog, `ipc/*` -> ipcMain, `gateway/message-bus.ts`,
 *     oauth flows, computer-use overlays, ...). The value-import closure of
 *     the full server entry (`cli/cli-api-server.ts`, 585 files) holds 57.
 *
 * So the layer-scoped verdicts below are the decidable ones, and the
 * full-graph claim is REPORTED, never folded into a green verdict: `A1b-full`
 * stays red until A3/A4/A5 land, and `--strict` makes that red non-zero.
 * Quoting the scoped verdict as if it settled the full graph is the exact
 * dishonesty this gate exists to prevent, so the open file list is printed in
 * full on every run.
 *
 * Run:  node scripts/architecture/headless-load-gate.mjs [--strict] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { stripComments } from './strip-comments.mjs';
import { IMPORT_RE, isTypeOnlyStatement } from './import-graph.mjs';
import { REPO_ROOT, reachabilityFrom, rel, resolveRepoSpecifier } from './boundary-gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The layer A1 is scoped to. A DIRECTORY, not a list of names: a new handler
 * that hard-imports Electron turns this gate red with no edit to this file,
 * which is what a hand-kept list of six could never do.
 */
export const HANDLER_LAYER_DIR = 'apps/desktop/src/main/cli/handlers';

/** The headless control plane's entry; used for the open-work census only. */
export const SERVER_ENTRY = 'apps/desktop/src/main/cli/cli-api-server.ts';

export const ELECTRON_SPECIFIER = 'electron';

/**
 * The contract's DECLARED subject — `00-contracts.md` §0 row 1, measured
 * 2026-10-05. Held as data, apart from the measurement, so a test can compare
 * a declaration against a measurement. §3.2 rejects `a === a`: two quantities
 * from two sources are the only comparison worth making.
 */
export const DECLARED_ELECTRON_HANDLERS = Object.freeze([
  'apps/desktop/src/main/cli/handlers/backup.ts',
  'apps/desktop/src/main/cli/handlers/extra.ts',
  'apps/desktop/src/main/cli/handlers/extra2.ts',
  'apps/desktop/src/main/cli/handlers/security.ts',
  'apps/desktop/src/main/cli/handlers/status.ts',
  'apps/desktop/src/main/cli/handlers/update.ts',
]);

/**
 * Inside `node_modules/`, for two reasons: gitignored, so a probe run cannot
 * dirty `git status`; and the CommonJS resolver walks up from it to the
 * workspace `node_modules`, so the modules esbuild leaves external (native
 * bindings) resolve exactly as they do in a packaged app.
 */
const PROBE_DIR = path.join(REPO_ROOT, 'node_modules', '.cache', 'duya-headless-probe');
const PROBE_ENTRIES = path.join(PROBE_DIR, 'entries');
const PROBE_MANIFEST = path.join(PROBE_DIR, 'manifest.json');
const PROBE_CHILD = path.join(HERE, 'headless-load-probe.cjs');

/**
 * Copied from `scripts/build-electron.mjs` rather than invented: the production
 * main bundle is the reference for what a real Node process cannot inline.
 * `electron` MUST stay external — that is what turns a hard import into a
 * runtime `require("electron")` the child is able to refuse.
 */
const EXTERNAL = [
  ELECTRON_SPECIFIER,
  'better-sqlite3',
  'fsevents',
  'node-pty',
  '@nut-tree-fork/nut-js',
  '@nut-tree-fork/libnut',
  '@nut-tree-fork/libnut-win32',
  '@nut-tree-fork/libnut-linux',
  '@nut-tree-fork/libnut-darwin',
  'chromium-bidi/lib/cjs/bidiMapper/BidiMapper',
  'chromium-bidi/lib/cjs/cdp/CdpConnection',
];

const lineAt = (text, index) => {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
};

/**
 * Is every named binding in this import clause explicitly type-only?
 *
 * `isTypeOnlyStatement` recognises the `import type { X }` PREFIX. TypeScript
 * has a second erased form — `import { type X, type Y } from 'z'` — where each
 * specifier carries its own modifier. When every specifier is `type`, the
 * statement is erased exactly like the prefix form and can never throw at
 * runtime, so reporting it as a hard import would be a false positive: the
 * first version of this gate did, and its own negative fixture caught it.
 */
function allBindingsTypeOnly(statement) {
  const clause = statement.replace(/^(?:import|export)\s+/, '').trim();
  if (!clause.startsWith('{') || !clause.endsWith('}')) return false;
  const bindings = clause
    .slice(1, -1)
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  if (bindings.length === 0) return false;
  return bindings.every((b) => /^type\s+/.test(b));
}

/**
 * Every `electron` specifier in one source file, classified by FORM.
 *
 * The form is read from the text the match starts at, so it is read off the
 * statement rather than pattern-guessed: `from 'electron'` is a declaration,
 * evaluated when the module is evaluated; `import('electron')` is deferred to
 * a call site; `require('electron')` is a call the handler may or may not
 * guard.
 *
 * `import type` (prefix or per-specifier) is erased by the compiler and can
 * never throw at runtime, so it is reported as `typeOnly` and is not a
 * violation — and it is COUNTED in the output rather than dropped, so the
 * exclusion is visible rather than silent.
 *
 * The specifier class is `import-graph.mjs`'s `IMPORT_RE`, not a fourth
 * hand-typed copy: `import-graph.test.ts` asserts the copies are byte-equal,
 * and a divergent copy here would be a platform bug nobody would see.
 */
export function electronEdges(source) {
  const stripped = stripComments(source);
  const text = stripped.unterminated ? source : stripped.text;
  const out = [];
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    if (m[1] !== ELECTRON_SPECIFIER) continue;
    const head = text.slice(m.index, m.index + 12);
    const form = head.startsWith('from')
      ? 'static'
      : head.startsWith('import')
        ? 'dynamic-import'
        : 'require-call';
    let typeOnly = false;
    if (form === 'static') {
      const window = text.slice(Math.max(0, m.index - 400), m.index);
      const boundary = Math.max(window.lastIndexOf(';'), window.lastIndexOf('\n}'));
      const statement = boundary === -1 ? window : window.slice(boundary);
      typeOnly = isTypeOnlyStatement(text, m.index) || allBindingsTypeOnly(statement);
    }
    out.push({ line: lineAt(text, m.index), form, typeOnly });
  }
  return out;
}

/** Does this source file carry an evaluation-time electron import? */
export function hasHardElectronImport(source) {
  return electronEdges(source).some((e) => e.form === 'static' && !e.typeOnly);
}

/** The layer's production modules (tests are not the subject). */
export function handlerLayerModules() {
  const dir = path.join(REPO_ROOT, HANDLER_LAYER_DIR);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    .sort()
    .map((f) => `${HANDLER_LAYER_DIR}/${f}`);
}

const readSource = (file) => {
  const abs = path.join(REPO_ROOT, file);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
};

/** Candidate files for a specifier with no extension, `.ts` before `.js`. */
function resolveWithExtensions(base) {
  const stem = /\.(?:js|mjs|cjs)$/.test(base) ? base.replace(/\.(?:js|mjs|cjs)$/, '') : base;
  const candidates = [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${stem}.js`,
    `${stem}/index.ts`,
    `${stem}/index.tsx`,
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * `@duya/*` -> this checkout's `packages/<pkg>/src`, through the repository's
 * own resolver rather than a second hand-written map. Without it every
 * workspace import resolves to a `dist/` that a fresh worktree does not have
 * and the probe would fail on a missing artifact instead of on Electron — the
 * `ok = 0, bad = 0` shape this gate is not allowed to have.
 *
 * The second rule is the `dist/` -> `src/` twin `import-graph.mjs:263-268`
 * already documents: four modules in this closure spell a deep relative import
 * as `packages/agent/dist/...`, so the build-output name is mapped back onto
 * the source that produces it. It is a resolution rule, not a gate rule, so it
 * lives here rather than in `import-graph.mjs`, which another slice owns.
 */
function workspaceSrcPlugin() {
  return {
    name: 'duya-workspace-src',
    setup(b) {
      b.onResolve({ filter: /^@duya\// }, (args) => {
        const from = args.importer ? rel(args.importer) : SERVER_ENTRY;
        const to = resolveRepoSpecifier(args.path, from);
        return to ? { path: path.join(REPO_ROOT, to) } : null;
      });
      b.onResolve({ filter: /packages[/\\][^/\\]+[/\\]dist[/\\]/ }, (args) => {
        const abs = path.isAbsolute(args.path) ? args.path : path.resolve(path.dirname(args.importer), args.path);
        const twin = abs.replace(/(packages[/\\][^/\\]+)[/\\]dist[/\\]/, '$1/src/');
        return { path: resolveWithExtensions(twin) ?? resolveWithExtensions(abs) };
      });
    },
  };
}

/**
 * One independent CJS entry per handler module, keeping esbuild's metafile.
 *
 * ## Why one entry per module, and not one bundle for the whole layer
 *
 * The first version built a single bundle of all 23 handlers and probed them
 * in sequence. It reported `extra` as LOADED while `extra` in isolation fails
 * with the Electron marker — measured, not reasoned: esbuild's CJS output
 * keeps ONE lazily-initialised `__esm` cache per module for the whole output
 * file, so whichever probe happened to reach a module first decided its
 * recorded outcome for every later probe. A per-module verdict that depends on
 * probe ORDER cannot be used to attribute a failure to a module, and
 * attribution is the only thing this gate needs it for.
 *
 * With one entry point per handler and `splitting: false`, each output file
 * carries its own copy of the graph, so the inits are independent: one
 * module's failure can no longer be inherited by another. The metafile's
 * per-output `inputs` list is then the exact file set that module pulled in,
 * which is what a failure is attributed against.
 */
export async function buildProbeBundle() {
  const modules = handlerLayerModules();
  fs.rmSync(PROBE_ENTRIES, { recursive: true, force: true });
  fs.mkdirSync(PROBE_ENTRIES, { recursive: true });
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: modules.map((m) => path.join(REPO_ROOT, m)),
    outbase: HANDLER_LAYER_DIR,
    outdir: PROBE_ENTRIES,
    entryNames: '[name]',
    bundle: true,
    write: true,
    metafile: true,
    splitting: false,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: EXTERNAL,
    plugins: [workspaceSrcPlugin()],
    logLevel: 'silent',
  });
  const entries = modules.map((m) => path.basename(m, '.ts'));
  fs.writeFileSync(PROBE_MANIFEST, JSON.stringify({ outdir: PROBE_ENTRIES, entries }, null, 2), 'utf8');
  return { modules, entries, manifest: PROBE_MANIFEST, outdir: PROBE_ENTRIES, metafile: result.metafile };
}

/**
 * esbuild's view, keyed by repo-relative file: every import edge with the
 * kind the bundler assigned it. `import-statement` is emitted into the output
 * and evaluated with its module; `require-call` stays a deferred call. That
 * classification comes from the bundler and the real graph, with no opinion
 * from the scanner above it.
 */
export function graphFromMetafile(metafile) {
  const graph = new Map();
  for (const [input, info] of Object.entries(metafile.inputs)) {
    graph.set(
      rel(path.resolve(REPO_ROOT, input)),
      (info.imports ?? []).map((imp) => ({
        spec: imp.path,
        kind: imp.kind,
        external: Boolean(imp.external),
        to: imp.external ? null : rel(path.resolve(REPO_ROOT, imp.path)),
      })),
    );
  }
  return graph;
}

/** Every edge to `electron` the bundler classified as evaluation-time. */
export function bundlerHardElectronEdges(graph) {
  const out = [];
  for (const [file, edges] of graph) {
    for (const edge of edges) {
      if (edge.spec === ELECTRON_SPECIFIER && edge.kind === 'import-statement') {
        out.push({ file, spec: edge.spec, kind: edge.kind });
      }
    }
  }
  return out;
}

/** The per-entry file set: the exact modules one handler's load pulled in. */
export function entryInputs(metafile, outdir) {
  const map = new Map();
  for (const [output, info] of Object.entries(metafile.outputs)) {
    if (!output.startsWith(outdir)) continue;
    const name = path.basename(output).replace(/\.[cm]?js$/, '');
    map.set(name, Object.keys(info.inputs ?? {}).map((input) => rel(path.resolve(REPO_ROOT, input))).sort());
  }
  return map;
}

/** Run the graph load in a child process where `require('electron')` throws. */
export function runHeadlessProbe(manifest, { timeoutMs = 600000 } = {}) {
  const run = spawnSync(process.execPath, [PROBE_CHILD, manifest], { encoding: 'utf8', timeout: timeoutMs });
  if (run.error) return { status: null, stdout: null, stderr: String(run.error), raw: '' };
  let stdout = null;
  try {
    stdout = JSON.parse(run.stdout);
  } catch {
    /* reported as a parse failure below */
  }
  return { status: run.status, stdout, stderr: run.stderr ?? '', raw: run.stdout ?? '' };
}

/**
 * One measurement of the whole gate.
 *
 * `a1a` / `a1b` are the SCOPED claims this slice owns. `open` is the
 * full-graph claim, carried with its measured file list so A3/A4/A5 can pick
 * it up instead of inheriting a green verdict that never covered it.
 */
export async function collectHeadlessReport({ strict = false } = {}) {
  const modules = handlerLayerModules();
  const { manifest, outdir, metafile } = await buildProbeBundle();
  const graph = graphFromMetafile(metafile);
  const perEntry = entryInputs(metafile, rel(path.resolve(REPO_ROOT, outdir)));

  // A1a — the source view, corroborated by the bundler's view.
  const sourceHard = [];
  for (const file of modules) {
    const source = readSource(file);
    if (source === null) continue;
    const edge = electronEdges(source).find((e) => e.form === 'static' && !e.typeOnly);
    if (edge) sourceHard.push({ file, line: edge.line });
  }
  const sourceTypeOnly = modules.filter((f) => {
    const source = readSource(f);
    return source !== null && electronEdges(source).some((e) => e.form === 'static' && e.typeOnly);
  });
  const bundlerHardAll = bundlerHardElectronEdges(graph);
  const bundlerHard = bundlerHardAll.filter((e) => e.file.startsWith(`${HANDLER_LAYER_DIR}/`));
  // Containment, not equality: every hard import the scanner sees must also be
  // one for the bundler. A scanner that over-reports is caught here; one that
  // under-reports is caught by A1b, which loads the graph.
  const bundlerHardFiles = new Set(bundlerHard.map((e) => e.file));
  const bundlerHardAllFiles = new Set(bundlerHardAll.map((e) => e.file));
  const unexplained = sourceHard.filter((e) => !bundlerHardFiles.has(e.file)).map((e) => e.file);

  // A1b — the behavioural load.
  const probe = runHeadlessProbe(manifest);
  const results = probe.stdout?.results ?? [];
  const failures = results.filter((r) => !r.ok);
  const attributed = failures
    .filter((r) => (perEntry.get(r.module) ?? []).some((f) => inLayerHard(bundlerHardFiles, f)))
    .map((r) => ({
      module: r.module,
      message: r.message,
      origin: (perEntry.get(r.module) ?? []).filter((f) => bundlerHardFiles.has(f)),
    }));
  const loaded = results.filter((r) => r.ok);
  const outOfLayerDetail = failures
    .filter((r) => !attributed.some((a) => a.module === r.module))
    .map((r) => ({
      module: r.module,
      message: r.message,
      // Where the remaining failure comes from, so "open" is a work list and
      // not a shrug. Capped: a handler that reaches 30 of them is one entry.
      origins: [...new Set((perEntry.get(r.module) ?? []).filter((f) => bundlerHardAllFiles.has(f)))].sort().slice(0, 3),
    }));

  // Open work: everything else in the graph, measured the same way.
  const serverClosure = reachabilityFrom(SERVER_ENTRY);
  const openHard = [...serverClosure.keys()]
    .filter((f) => !f.startsWith(`${HANDLER_LAYER_DIR}/`))
    .filter((f) => {
      const source = readSource(f);
      return source !== null && hasHardElectronImport(source);
    })
    .sort();

  return {
    entry: SERVER_ENTRY,
    scope: `${modules.length} modules in ${HANDLER_LAYER_DIR}`,
    serverClosureFiles: serverClosure.size,
    a1a: {
      scope: modules.length,
      hard: sourceHard,
      unexplained,
      typeOnly: sourceTypeOnly,
      bundlerHard: bundlerHard.length,
    },
    a1b: {
      patchArmed: probe.stdout?.patchArmed === true,
      refused: probe.stdout?.refused ?? 0,
      probeError: probe.stdout === null ? (probe.stderr || probe.raw).slice(0, 600) : null,
      scope: modules.length,
      loaded: loaded.map((r) => r.module).sort(),
      failed: failures.length,
      failedOutOfLayer: failures.length - attributed.length,
      attributed,
      outOfLayerDetail,
    },
    open: {
      scope: `value-import closure of ${SERVER_ENTRY} (${serverClosure.size} files)`,
      hardElectronImporters: openHard.length,
      files: openHard,
    },
    strict,
  };
}

const inLayerHard = (bundlerHardFiles, file) =>
  file.startsWith(`${HANDLER_LAYER_DIR}/`) && bundlerHardFiles.has(file);

export function verdictOf(report) {
  return (
    report.a1a.hard.length === 0 &&
    report.a1a.unexplained.length === 0 &&
    report.a1b.attributed.length === 0 &&
    report.a1b.patchArmed &&
    report.a1b.probeError === null
  );
}

export function formatReport(report) {
  const lines = [];
  lines.push('=== plan 610 A1 — headless load gate ===');
  lines.push(`scope            ${report.scope}`);
  lines.push('');
  lines.push(`A1a  hard electron import in the cli handler layer  (${report.a1a.scope} modules)`);
  lines.push(`     ${report.a1a.hard.length}/${report.a1a.scope} modules — ${report.a1a.hard.length === 0 ? 'GREEN' : 'RED'}`);
  for (const h of report.a1a.hard) lines.push(`     RED    ${h.file}:${h.line}`);
  lines.push(`     bundler cross-check: ${report.a1a.bundlerHard} evaluation-time electron edges, ${report.a1a.unexplained.length} unexplained`);
  if (report.a1a.typeOnly.length > 0) {
    lines.push(`     type-only electron imports (erased, not violations): ${report.a1a.typeOnly.length}`);
  }
  lines.push('');
  lines.push(`A1b  child process, require('electron') throws  (${report.a1b.scope} modules)`);
  lines.push(`     patch armed: ${report.a1b.patchArmed}   electron resolutions refused: ${report.a1b.refused}`);
  if (report.a1b.probeError) lines.push(`     PROBE ERROR: ${report.a1b.probeError}`);
  lines.push(`     loaded: ${report.a1b.loaded.length}/${report.a1b.scope}  ${report.a1b.loaded.join(', ')}`);
  lines.push(`     failed, origin outside the layer: ${report.a1b.failedOutOfLayer}`);
  for (const d of report.a1b.outOfLayerDetail) {
    lines.push(`     open   ${d.module}: ${d.origins.join(', ') || '(no hard import in its graph)'}`);
  }
  lines.push(`     failed, origin INSIDE the layer:    ${report.a1b.attributed.length}  ${report.a1b.attributed.length === 0 ? 'GREEN' : 'RED'}`);
  for (const a of report.a1b.attributed) {
    lines.push(`     RED    ${a.module}: ${a.message}`);
    for (const origin of a.origin) lines.push(`           hard import at ${origin}`);
  }
  lines.push('');
  lines.push(`A1b-full  ${report.open.scope}`);
  lines.push(`     ${report.open.hardElectronImporters} files outside the handler layer still hard-import electron — OPEN (A3/A4/A5)`);
  for (const f of report.open.files) lines.push(`     open   ${f}`);
  return lines.join('\n');
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const strict = process.argv.includes('--strict');
  const json = process.argv.includes('--json');
  const report = await collectHeadlessReport({ strict });
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatReport(report)}\n`);
  const ok = verdictOf(report) && (!strict || report.open.hardElectronImporters === 0);
  if (!json) {
    process.stdout.write(
      `\nA1 (cli handler layer): ${ok ? 'GREEN' : 'RED'}` +
        (strict ? ` | A1b-full: ${report.open.hardElectronImporters === 0 ? 'GREEN' : 'RED'}` : '') +
        '\n',
    );
  }
  process.exit(ok ? 0 : 1);
}
