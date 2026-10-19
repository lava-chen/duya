#!/usr/bin/env node
/**
 * import-graph.mjs — the M5.1 slice inventory's graph resolver.
 *
 * ## Why this is not a new scanner
 *
 * Plan 587 M5.1 asks for a type graph, a runtime value graph, a host-import
 * view and the SCC members, and it asks for them WITHOUT a parallel scanner.
 * The trustworthy resolver already exists:
 *
 *   - `strip-comments.mjs` — code vs prose, offsets preserved
 *   - `audit-imports.mjs`  — the CR/LF-safe specifier class, the dist->src twin
 *   - `audit-modules.mjs`  — the Tarjan SCC pass
 *
 * So this module does not re-parse imports with a new grammar. It reuses the
 * same specifier class and the same comment stripper, and adds exactly one
 * thing they do not have: the TYPE / VALUE distinction.
 *
 * ## The one genuinely new fact: a type edge is not a runtime edge
 *
 * Both audits count an import as an edge regardless of whether it binds a type
 * or a value. That is right for a boundary gate — a type import still couples
 * two modules — and wrong for a cut list, which has to name the edges that
 * actually force a package to exist at runtime.
 *
 * `import type { X } from 'y'` and `export type { X } from 'y'` are erased by
 * the compiler. Cutting them removes a real coupling and changes no emitted
 * JavaScript. `import { x } from 'y'`, a bare `import 'y'`, `import('y')` and
 * `require('y')` all survive into the bundle.
 *
 * The classifier errs in ONE direction only: when it cannot tell, it says
 * `value`. A false `value` costs one cut-list entry to investigate; a false
 * `type` would let a migration delete a live runtime dependency and break the
 * build at a distance. So the value graph is a SUPERSET of the truth, and the
 * cut list derived from it is a superset of the real work.
 *
 * ## What is NOT claimed
 *
 * A static, single-file view. It cannot see a dynamic `import(someVariable)`,
 * or an edge that only appears after a build step. It reads the SOURCE, on this
 * checkout, with no `dist/` present — the same discipline `audit-imports.mjs`
 * already documents.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
// KNOWN BLIND SPOT, recorded rather than fixed: the match is on the directory
// NAME at any depth, not on its path. Nothing here is scoped to the repo root,
// so a SOURCE directory that happens to be called `build`, `release` or
// `coverage` anywhere under apps/, packages/ or evals/ would be dropped from the
// walk silently — and every census, fingerprint and count derived from it would
// agree with itself while missing the files. `release/` is the live example: it
// is already a package build-output name AND a plausible source name. Fixing it
// means anchoring each entry to its well-known build locations, which is a
// change to the walk itself rather than to the inventory, so it is left alone
// here and stated where someone changing SKIP_DIRS will read it.
const SKIP_DIRS = new Set([
  "node_modules", "dist", "dist-electron", "bundle", "build", "release",
  ".git", "coverage", "storybook-static", ".e2e-userdata",
]);

/**
 * The specifier class, shared rather than retyped.
 *
 * G0.3 records that the platform-dependent false violation came from
 * hand-copied `[^"']` literals that matched CR/LF. This is the third consumer
 * in the repo, so the class lives here as one export and
 * `import-graph.test.ts` asserts the other two files' copies are byte-equal to
 * it — divergence is a test failure rather than a silent platform bug.
 */
export const SPECIFIER_CLASS = '[^"\'\\r\\n]+';
export const IMPORT_RE = new RegExp(
  `(?:from\\s+|import\\s*\\(|require\\s*\\()\\s*["'](${SPECIFIER_CLASS})["']`,
  "g",
);

const TYPE_ONLY_PREFIX = /(?:^|[\s;}])(?:import|export)\s+type\s/;

/**
 * How far back to look before giving up on finding the statement head.
 *
 * This is NOT a window size any more — see `isTypeOnlyStatement`. It is only a
 * floor: a statement longer than this still gets its head found, because the
 * search retries at a larger reach instead of silently declaring "no head".
 */
const STATEMENT_LOOKBACK = 400;

/**
 * Find the start of the smallest `import`/`export` statement that ends at
 * `matchIndex`, or -1 when the text before it contains no such head.
 *
 * The old implementation sliced a fixed 400-character window and cut it at the
 * last `;` or `\n}`, which silently misclassified every multi-line type-only
 * import longer than the window:
 *
 *     import type {            <- head, 400+ chars before the specifier
 *       A, B, C, ... 25 items
 *     } from '@duya/agent-protocol';
 *
 * The last `\n}` in that window is the import's OWN closing brace, so the
 * slice began at `"\n} "`, the head was gone, and the statement was reported as
 * a VALUE import. Measured on this tree: `packages/client-core/src/surface/
 * surface-model.ts:41` is a 22-line `import type` that was classified value,
 * which inflated that package's value closure from 1 file to 66. The bug
 * direction is "closure too large", so it never produced a false green — but it
 * does make a type-only reference look like runtime coupling, which is exactly
 * the distinction every closure gate here is built on.
 *
 * The fix walks backwards from the match to the nearest `import`/`export`
 * keyword that is not itself preceded by another statement terminator, and
 * grows the reach until it either finds a head or runs out of text.
 */
export function statementHead(text, matchIndex) {
  let reach = STATEMENT_LOOKBACK;
  for (;;) {
    const from = Math.max(0, matchIndex - reach);
    const window = text.slice(from, matchIndex);
    // The head must start at a statement boundary, and nothing between the head
    // and the specifier may contain `from`/`require` — otherwise we are looking
    // at an earlier statement that happens to end with a keyword.
    const re = /(?:^|[\s;}])(?:import|export)\b/g;
    let best = -1;
    let m;
    while ((m = re.exec(window))) {
      const after = window.slice(m.index + m[0].length);
      if (/\bfrom\b/.test(after) || /\brequire\b/.test(after)) continue;
      // Keep the leading delimiter: `TYPE_ONLY_PREFIX` anchors on `(?:^|[\s;}])`
      // before the keyword, so a slice that starts AT `import` only matches via
      // the `^` alternative and loses the keyword itself on re-slicing.
      best = from + m.index;
    }
    if (best !== -1) return best;
    if (from === 0) return -1;
    reach *= 4;
  }
}

/**
 * Is the import statement ending at `matchIndex` type-only?
 *
 * `IMPORT_RE` captures only the specifier, so the `import type` keyword sits
 * earlier in the same statement. The head is located by `statementHead`, not by
 * "the last `;` or `\n}` in a fixed window" — that shortcut cut long multi-line
 * type-only imports in half (see `statementHead` for the measurement).
 *
 * `import('y')` and `require('y')` have no keyword before their specifier
 * inside their own parentheses, so they classify as `value` — which is correct:
 * both emit a real load.
 */
export function isTypeOnlyStatement(text, matchIndex) {
  const head = statementHead(text, matchIndex);
  if (head === -1) return false;
  return TYPE_ONLY_PREFIX.test(text.slice(head, matchIndex));
}

export function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SRC_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

export const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
export { stripComments, ROOT };

/** The file set the three views are built over. */
export const ROOTS = ["apps", "packages", "evals"];

/**
 * Every import in one file, each classified type-only or value.
 *
 * Falls back to the RAW text when `stripComments` reports `unterminated`, for
 * the reason `strip-comments.mjs` documents: a half-stripped file is worse than
 * an unstripped one, and an unstripped file only risks a false positive.
 */
export function importsOf(absolutePath) {
  const raw = fs.readFileSync(absolutePath, "utf8");
  const stripped = stripComments(raw);
  const text = stripped.unterminated ? raw : stripped.text;
  const out = [];
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(text))) {
    out.push({ spec: m[1], typeOnly: isTypeOnlyStatement(text, m.index) });
  }
  return out;
}

/**
 * Tarjan SCC over `node -> Set<node>`.
 *
 * Copied from `audit-modules.mjs:strongconnect` rather than re-derived: two SCC
 * implementations that disagree by one node turn "the 42-member cycle" into an
 * unverifiable number.
 */
export function tarjan(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;

  function strongconnect(v) {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp);
    }
  }

  for (const v of graph.keys()) if (!index.has(v)) strongconnect(v);
  sccs.sort((a, b) => b.length - a.length);
  return sccs;
}

/** Which boundary does a file belong to? Mirrors `audit-imports.mjs:ownerOf`. */
export function ownerOf(relPath) {
  if (relPath.startsWith("apps/desktop/src/renderer/")) return "src-renderer";
  if (relPath.startsWith("apps/desktop/src/preload/")) return "electron-preload";
  if (relPath.startsWith("apps/desktop/src/main/")) return "electron-main";
  if (relPath.startsWith("apps/desktop/src/contracts/")) return "desktop-contracts";
  const m = relPath.match(/^packages\/([^/]+)\//);
  if (m) return `pkg:${m[1]}`;
  if (relPath.startsWith("evals/")) return "evals";
  // Repository tooling. Without this the whole tree fell through to "other",
  // and `architecture-check.mjs` cannot map "other" to a root, so a product
  // test importing a gate detector (e.g. `isTurnLoopModule` from
  // `scripts/architecture/boundary-gates.mjs`) became a blocking
  // `module-dependency` violation that no policy `requires` entry could ever
  // permit. Same failure mode as the `desktop-contracts` owner added above.
  if (relPath.startsWith("scripts/")) return "scripts";
  return "other";
}

export const HOST_BOUNDARIES = new Set([
  "electron-main",
  "electron-preload",
  "src-renderer",
  "desktop-contracts",
]);

export const isHostBoundary = (owner) => HOST_BOUNDARIES.has(owner);

/**
 * Resolve a specifier to the file it names, for graph purposes.
 *
 * The candidate list mirrors `audit-imports.mjs:resolveFile` (`.ts` before
 * `.js`, `index.*` last) and keeps its `dist/` -> `src/` twin, so an edge
 * written against a build output lands on the source that produced it and the
 * graph does not depend on whether `dist/` happens to be present.
 *
 * Returns null when nothing resolves. An unresolved specifier is reported by
 * `audit-imports.mjs` already; here it simply is not an edge.
 */
export function resolveTarget(spec, fromRelPath) {
  const base = spec.startsWith("@duya/")
    ? path.join(ROOT, "packages", spec.slice("@duya/".length).split("/")[0])
    : path.resolve(ROOT, path.posix.dirname(fromRelPath), spec);
  const ext = path.extname(base);
  const stem = ext === ".js" || ext === ".mjs" ? base.slice(0, -ext.length) : base;
  const candidates = [];
  const push = (p) => {
    candidates.push(p);
    const twin = distToSourceTwin(p);
    if (twin) candidates.push(twin);
  };
  if (ext === ".js" || ext === ".mjs") {
    push(`${stem}.ts`);
    push(`${stem}.tsx`);
    push(base);
    push(`${stem}.js`);
  } else {
    push(`${base}.ts`);
    push(`${base}.tsx`);
    push(`${base}.js`);
    push(`${base}.mjs`);
    push(base);
  }
  push(`${base}/index.ts`);
  push(`${base}/index.tsx`);
  push(`${base}/index.js`);
  push(`${base}/index.mjs`);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return rel(c);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Our own `packages/<x>/dist/...` maps back to the `src/` file that made it. */
function distToSourceTwin(p) {
  const m = /[\\/]packages[\\/]([^\\/]+)[\\/]dist[\\/](.+)$/.exec(p);
  if (!m) return null;
  return path.join(ROOT, "packages", m[1], "src", m[2]);
}

/**
 * The three views M5.1 asks for, over one file set.
 *
 *  - `typeGraph`   every internal edge, type-only or not
 *  - `valueGraph`  only edges that survive into emitted JavaScript
 *  - `hostImports` edges touching a host boundary, tagged by direction
 *
 * Nodes are repo-relative FILES, not specifiers, so an SCC is a set of real
 * files and a cut-list entry names a real line to change.
 */
export function buildGraphs() {
  const files = ROOTS.flatMap((r) => walk(path.join(ROOT, r)));
  const typeGraph = new Map();
  const valueGraph = new Map();
  const valueEdges = [];

  for (const absolute of files) {
    const from = rel(absolute);
    const fromOwner = ownerOf(from);
    for (const { spec, typeOnly } of importsOf(absolute)) {
      // Only edges INTO this repo. A third-party specifier is a dependency, not
      // an internal coupling, and including it would put `zod` in the SCC pass.
      if (!spec.startsWith(".") && !spec.startsWith("@duya/")) continue;
      const to = resolveTarget(spec, from);
      if (to === null) continue;
      if (!typeGraph.has(from)) typeGraph.set(from, new Set());
      typeGraph.get(from).add(to);
      if (typeOnly) continue;
      if (!valueGraph.has(from)) valueGraph.set(from, new Set());
      valueGraph.get(from).add(to);
      valueEdges.push({
        from,
        spec,
        to,
        fromOwner,
        toOwner: ownerOf(to),
        direction: isHostBoundary(fromOwner)
          ? (isHostBoundary(ownerOf(to)) ? "host-internal" : "host-to-workspace")
          : (isHostBoundary(ownerOf(to)) ? "workspace-to-host" : "workspace-internal"),
      });
    }
  }

  return {
    files: files.map(rel),
    typeGraph,
    valueGraph,
    valueEdges,
    sccs: { type: tarjan(typeGraph), value: tarjan(valueGraph) },
  };
}

// Main-module guard. `import.meta.url` is a `file://` URL while `process.argv[1]`
// is a bare path, and on Windows the drive letter needs an extra slash in the
// URL form — so the two are compared as PATHS, which is the only form that is
// equal on every platform. A string comparison silently never matched on
// Windows and the script exited 0 having printed nothing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const g = buildGraphs();
  const sizeSum = (m) => [...m.values()].reduce((n, s) => n + s.size, 0);
  const byDirection = {};
  for (const e of g.valueEdges) byDirection[e.direction] = (byDirection[e.direction] ?? 0) + 1;
  process.stdout.write(
    `${JSON.stringify(
      {
        meta: {
          files: g.files.length,
          typeEdges: sizeSum(g.typeGraph),
          valueEdges: g.valueEdges.length,
          sccType: g.sccs.type.length,
          sccValue: g.sccs.value.length,
        },
        sccSizes: {
          type: g.sccs.type.map((c) => c.length),
          value: g.sccs.value.map((c) => c.length),
        },
        byDirection,
      },
      null,
      2,
    )}\n`,
  );
}
