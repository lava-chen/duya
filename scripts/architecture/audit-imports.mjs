#!/usr/bin/env node
/**
 * Duya boundary audit — reproducible source for docs/architecture/01-current-state-audit.md
 *
 * Resolves every static import in src/ electron/ packages/ tests/ e2e/ and classifies
 * it against the REAL `exports` map of each workspace package. Emits JSON so the
 * numbers in the audit doc can be recomputed by anyone:
 *
 *   node scripts/architecture/audit-imports.mjs            # human summary
 *   node scripts/architecture/audit-imports.mjs --json     # machine readable
 *
 * Classification rules (see docs/architecture/05-architecture-governance.md):
 *   public       - resolves through the target package's `exports` map
 *   deep         - reaches inside a package past its public entrypoints
 *   escape       - relative path from OUTSIDE any package into packages/
 *   external     - third-party dependency
 *   unresolved   - specifier could not be resolved to a file
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOTS = ["apps", "packages", "tests", "e2e"];
const SRC_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules", "dist", "dist-electron", "bundle", "build", "release",
  ".git", "coverage", "storybook-static", ".e2e-userdata",
]);
// Import specifiers that are never real module edges. Kept separate from
// comment handling: these are strings that survive stripping and still are not
// imports.
const SKIP_SPEC = new Set([".length);", "else if (line.startsWith("]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SRC_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

/** Which boundary does a file belong to? */
function ownerOf(relPath) {
  if (relPath.startsWith("apps/desktop/src/renderer/")) return "src-renderer";
  if (relPath.startsWith("apps/desktop/src/preload/")) return "electron-preload";
  if (relPath.startsWith("apps/desktop/src/main/")) return "electron-main";
  const m = relPath.match(/^packages\/([^/]+)\//);
  if (m) return `pkg:${m[1]}`;
  if (relPath.startsWith("tests/")) return "tests";
  if (relPath.startsWith("e2e/")) return "e2e";
  return "other";
}

// ── workspace package registry, with REAL exports maps ────────────────
const workspacePkgs = new Map(); // name -> { dir, exports: Set<string> | null }
for (const dirName of fs.readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })) {
  if (!dirName.isDirectory()) continue;
  const dir = `packages/${dirName.name}`;
  const manifestPath = path.join(ROOT, dir, "package.json");
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.name) continue;

  let exportsMap = null;
  if (manifest.exports) {
    exportsMap = new Set();
    for (const key of Object.keys(manifest.exports)) exportsMap.add(key);
  } else if (manifest.main) {
    // No exports map: only the package root is public, via `main`.
    exportsMap = new Set(["."]);
  }
  workspacePkgs.set(manifest.name, { dir, exports: exportsMap, manifest });
}

const isTestFile = (p) =>
  /(^|\/)(__tests__|tests?)(\/|$)/.test(p) || /\.(test|spec)\.[jt]sx?$/.test(p);

/**
 * `packages/<x>/dist/a/b.js` -> `packages/<x>/src/a/b.ts`, when that file exists.
 *
 * The repo has 16 electron-main deep imports written against
 * `packages/agent/dist/...` (e.g. `electron/services/wake.ts` importing
 * `../../packages/agent/dist/context/os-context/index.js`). Those specifiers
 * resolve ONLY after a build, so without this normalisation the violation
 * counts depend on whether `dist/` happens to be present:
 *
 *   fresh clone, never built     -> 153 package-boundary escapes
 *   after `npm run typecheck:all`-> 161  (typecheck:web runs build:agent)
 *
 * Same commit, opposite verdicts. A gate whose result is a function of local
 * build state is not a gate.
 *
 * The coupling is real in both states — it lives in the source, and
 * `dist/context/os-context/index.js` is a compile of
 * `src/context/os-context/index.ts` — so the gate must measure the source, not
 * the build layout. Normalising also keeps the count stable for anyone who runs
 * `--write` before or after a build, which is the whole point of freezing a
 * baseline.
 *
 * Scoped deliberately: only OUR OWN workspace `packages/<name>/dist/`. A
 * third-party package's `dist/` is not a build of this repo's source, and
 * remapping it would invent a file that does not exist.
 */
function distToSourceTwin(p) {
  const m = /[\\/]packages[\\/]([^\\/]+)[\\/]dist[\\/](.+)$/.exec(p);
  if (!m) return null;
  return path.join(ROOT, "packages", m[1], "src", m[2]);
}

/** Resolve a relative / extensionless specifier to a real file. */
function resolveFile(base) {
  const candidates = [];
  const ext = path.extname(base);
  if (ext === ".js" || ext === ".mjs") {
    // NodeNext style: './x.js' actually means './x.ts' in this repo. The
    // literal path is ALSO tried, because unlike `./x.js` a `./x.mjs`
    // specifier is frequently the real file and not a TS stand-in — every
    // governance script in this directory is `.mjs` and imports `.mjs`.
    // Without the literal fallback those edges read as `unresolved`, which is
    // both a false alarm and a hole: an unresolvable edge is exempt from the
    // rules that would have flagged it.
    const stem = base.slice(0, -ext.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, base, `${stem}.js`);
  } else {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, base);
  }
  candidates.push(
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.mjs`,
  );
  // The literal candidate always wins; the source twin is only a fallback for
  // the build-output case described above.
  const withTwins = [];
  for (const c of candidates) {
    withTwins.push(c);
    const twin = distToSourceTwin(c);
    if (twin) withTwins.push(twin);
  }
  for (const c of withTwins) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* ignore */ }
  }
  return null;
}

/** Resolve a workspace package specifier, honouring the `exports` map. */
function resolveWorkspace(spec, pkgInfo) {
  const sub = spec.slice(pkgInfo.manifest.name.length); // "" or "/message"
  // Try the package root and its src/ dir: the repo consumes both forms
  // (bare `@duya/x` resolves to packages/x/src/index.ts at build time, while
  // `@duya/x/message` maps through `exports` to the built output).
  const bases = sub === "" || sub === "/"
    ? [pkgInfo.dir, `${pkgInfo.dir}/src`]
    : [pkgInfo.dir + sub, `${pkgInfo.dir}/src${sub}`];
  for (const b of bases) {
    const file = resolveFile(path.join(ROOT, b));
    if (file) return { file, sub };
  }
  return { file: null, sub };
}

const IMPORT_RE = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

const files = ROOTS.flatMap((r) => walk(path.join(ROOT, r)));
const edges = [];
const counts = new Map();

for (const file of files) {
  const relFrom = rel(file);
  const fromOwner = ownerOf(relFrom);
  const fromTest = isTestFile(relFrom);
  // Comments are prose, not code. Scanning raw text made a doc comment that
  // quotes `from '...'` into a module-dependency violation, and made a
  // commented-out import look like a live edge. See strip-comments.mjs.
  const { text } = stripComments(fs.readFileSync(file, "utf8"));
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text))) {
    const spec = m[1];
    if (!spec || SKIP_SPEC.has(spec)) continue;

    let toOwner = null;
    let toFile = null;
    let kind = null;
    let sub = null;

    const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : null;
    if (pkgName && workspacePkgs.has(pkgName)) {
      const r = resolveWorkspace(spec, workspacePkgs.get(pkgName));
      toFile = r.file;
      sub = r.sub;
      const exportsMap = workspacePkgs.get(pkgName).exports;
      // `resolveWorkspace` returns `sub` as the raw remainder of the specifier
      // — "" or "/testing" — but an `exports` map keys subpaths as "./testing".
      // Comparing the two without the dot marked every subpath export in the
      // repo as a deep import: `@duya/agent/message` and
      // `@duya/agent-protocol/testing` are both declared in their package's
      // `exports`, and both were being reported as reaching past the public
      // entrypoints. Only the bare root was ever checked correctly, because
      // that is the one case where the literal "." happens to line up.
      const isPublic = exportsMap
        ? exportsMap.has(sub === "" || sub === "/" ? "." : `.${sub}`)
        : false;
      kind = toFile ? (isPublic ? "public" : "deep") : "unresolved";
      toOwner = toFile ? ownerOf(rel(toFile)) : `UNRESOLVED:${spec}`;
    } else if (spec.startsWith(".")) {
      toFile = resolveFile(path.resolve(path.dirname(file), spec));
      kind = toFile ? "relative" : "unresolved";
      toOwner = toFile ? ownerOf(rel(toFile)) : `UNRESOLVED:${spec}`;
    } else if (spec.startsWith("apps/desktop/src/main/")) {
      toOwner = "electron-main"; kind = "aliased-path";
    } else if (spec.startsWith("apps/desktop/src/preload/")) {
      toOwner = "electron-preload"; kind = "aliased-path";
    } else if (spec.startsWith("apps/desktop/src/renderer/")) {
      toOwner = "src-renderer"; kind = "aliased-path";
    } else {
      toOwner = `external:${pkgName ?? spec.split("/")[0]}`;
      kind = "external";
    }

    if (!toOwner) continue;
    const crossBoundary = toOwner !== fromOwner && !toOwner.startsWith("external:");
    const record = {
      from: relFrom, to: toFile ? rel(toFile) : toOwner, spec,
      fromOwner, toOwner, kind, fromTest,
      crossBoundary: Boolean(crossBoundary),
    };
    edges.push(record);
    const key = `${fromOwner} -> ${toOwner}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

const internal = edges.filter((e) => !e.toOwner.startsWith("external:"));
const crossBoundary = internal.filter((e) => e.crossBoundary);
const deep = crossBoundary.filter((e) => e.kind === "deep");
// Relative path from outside every package (src/, electron/, tests/, e2e/) into packages/
const escapes = internal.filter(
  (e) => e.spec.startsWith(".")
    && e.toOwner.startsWith("pkg:")
    && !e.fromOwner.startsWith("pkg:"),
);
// Split escapes by host, because the two hosts have very different profiles.
const escapesByHost = {
  renderer: escapes.filter((e) => e.fromOwner === "src-renderer"),
  main: escapes.filter((e) => e.fromOwner === "electron-main"),
  tests: escapes.filter((e) => e.fromOwner === "tests" || e.fromOwner === "e2e"),
};

const byPair = (list) => {
  const m = new Map();
  for (const e of list) {
    const k = `${e.fromOwner} -> ${e.toOwner}`;
    if (!m.has(k)) m.set(k, { n: 0, targets: new Set() });
    const v = m.get(k);
    v.n += 1;
    v.targets.add(e.to);
  }
  return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
};

const result = {
  meta: {
    filesScanned: files.length,
    fileEdges: edges.length,
    internalEdges: internal.length,
    crossBoundaryEdges: crossBoundary.length,
    deepImports: deep.length,
    packageBoundaryEscapes: escapes.length,
    escapesByHost: {
      renderer: escapesByHost.renderer.length,
      main: escapesByHost.main.length,
      tests: escapesByHost.tests.length,
    },
  },
  crossBoundaryByPair: byPair(crossBoundary).map(([k, v]) => ({
    edge: k, count: v.n, distinctTargets: v.targets.size,
    targets: [...v.targets].slice(0, 25),
  })),
  // Per-edge detail, not just the per-pair aggregate above. Added for
  // architecture-check.mjs, which fingerprints each violation individually so
  // a ratchet can tell "same debt" from "different debt at the same count".
  // Purely additive: the human summary and every count above are unchanged.
  crossBoundaryEdges: crossBoundary,
  deepImportsByPair: byPair(deep).map(([k, v]) => ({
    edge: k, count: v.n, distinctTargets: v.targets.size,
    targets: [...v.targets].slice(0, 25),
  })),
  deepImportEdges: deep,
  packageBoundaryEscapeEdges: escapes,
  unresolved: internal.filter((e) => e.kind === "unresolved")
    .map((e) => ({ from: e.from, spec: e.spec })),
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const m = result.meta;
  console.log("=== Duya import boundary audit ===");
  console.log(`files scanned        ${m.filesScanned}`);
  console.log(`file edges           ${m.fileEdges}`);
  console.log(`internal edges       ${m.internalEdges}`);
  console.log(`cross-boundary edges ${m.crossBoundaryEdges}`);
  console.log(`deep imports         ${m.deepImports}   (cross-boundary, bypasses target's exports map)`);
  console.log(`package escapes      ${m.packageBoundaryEscapes}   (relative path from a host into packages/)`);
  console.log(`  ├─ from renderer/  ${m.escapesByHost.renderer}`);
  console.log(`  ├─ from main/      ${m.escapesByHost.main}`);
  console.log(`  └─ from tests/e2e/ ${m.escapesByHost.tests}`);
  console.log(`unresolved           ${result.unresolved.length}`);
  console.log("\n--- cross-boundary by pair ---");
  for (const r of result.crossBoundaryByPair) console.log(String(r.count).padStart(6), r.edge);
  console.log("\n--- deep imports by pair ---");
  for (const r of result.deepImportsByPair) console.log(String(r.count).padStart(6), r.edge, ` (${r.distinctTargets} targets)`);
  console.log("\n--- package boundary escapes grouped by target package ---");
  const escGroups = new Map();
  for (const e of result.packageBoundaryEscapeEdges) {
    const g = `${e.fromOwner} -> ${e.toOwner}`;
    if (!escGroups.has(g)) escGroups.set(g, { n: 0, specs: new Set() });
    const v = escGroups.get(g);
    v.n += 1;
    v.specs.add(e.spec);
  }
  for (const [g, v] of [...escGroups.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(String(v.n).padStart(6), g);
    for (const s of [...v.specs].slice(0, 4)) console.log("         e.g.", s);
  }
  if (result.unresolved.length) {
    console.log("\n--- unresolved (first 25) ---");
    for (const u of result.unresolved.slice(0, 25)) console.log("  ", u.from, "->", u.spec);
  }
}
