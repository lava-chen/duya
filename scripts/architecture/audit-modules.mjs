#!/usr/bin/env node
/**
 * Duya module-graph + classification audit — reproducible source for
 * docs/architecture/01-current-state-audit.md §7 and §2 (V7).
 *
 * Complements audit-imports.mjs, which measures cross-boundary edges. This one
 * measures the INTRA-package graph, because those claims are not derivable from
 * the boundary report:
 *
 *   - module-level cycles inside packages/**   (doc claims: 0)
 *   - packages/agent/src top-level modules     (doc claims: 35)
 *   - per-module external dependency fingerprint (doc §7 A/B/C/D/E table)
 *   - per-module LOC                           (doc §7)
 *
 *   node scripts/architecture/audit-modules.mjs
 *   node scripts/architecture/audit-modules.mjs --json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AGENT_SRC = path.join(ROOT, "packages/agent/src");
const SRC_EXTS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];
const SKIP_DIRS = new Set(["node_modules", "dist", "bundle", "build", "release", ".git"]);
// Test files are excluded from the cycle graph: fixture-only imports do not
// create a runtime dependency cycle, and including them produced false SCCs.
const SKIP_DIRS_IN_MODULES = new Set([
  ...SKIP_DIRS, "__tests__", "tests", "__mocks__", "__snapshots__",
]);

function walk(dir, out = [], skip = SKIP_DIRS) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, skip);
    else if (SRC_EXTS.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

function resolveFile(base) {
  const cands = [];
  const ext = path.extname(base);
  if (ext === ".js" || ext === ".mjs") {
    // The literal path is tried too: a `.mjs` specifier is usually the real
    // file rather than a TypeScript stand-in, and treating every `.mjs` edge
    // as unresolved would hide exactly the governance-script imports this
    // audit exists to see. Kept in sync with `audit-imports.mjs:resolveFile`.
    const stem = base.slice(0, -ext.length);
    cands.push(`${stem}.ts`, `${stem}.tsx`, base, `${stem}.js`);
  } else {
    cands.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, base);
  }
  cands.push(`${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.mjs`);
  for (const c of cands) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* ignore */ }
  }
  return null;
}

const IMPORT_RE = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

// ── 1. intra-package module graph over packages/ ──────────────────────
const pkgFiles = walk(path.join(ROOT, "packages"));
const graph = new Map();
for (const f of pkgFiles) {
  // Comments are prose, not code — see strip-comments.mjs. A cycle counted
  // from a commented-out import is a cycle that does not exist.
  const { text } = stripComments(fs.readFileSync(f, "utf8"));
  const deps = [];
  let m; IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text))) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue;
    const t = resolveFile(path.resolve(path.dirname(f), spec));
    if (t && t.startsWith(path.join(ROOT, "packages"))) deps.push(t);
  }
  if (deps.length) graph.set(f, deps);
}

// Tarjan strongly-connected components -> cyclic groups
const index = new Map(), low = new Map(), onStack = new Set(), stack = [], sccs = [];
let counter = 0;
function strongconnect(v) {
  index.set(v, counter); low.set(v, counter); counter += 1;
  stack.push(v); onStack.add(v);
  for (const w of graph.get(v) ?? []) {
    if (!index.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
  }
  if (low.get(v) === index.get(v)) {
    const comp = []; let w;
    do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
    if (comp.length > 1) sccs.push(comp);
  }
}
for (const f of pkgFiles) if (!index.has(f)) strongconnect(f);
sccs.sort((a, b) => b.length - a.length);

// ── 2. packages/agent/src module inventory + dependency fingerprint ───
// Signal buckets used to classify each module A/B/C/D/E in the audit doc.
const SIGNALS = new Map(Object.entries({
  "E-FS": ["node:fs", "fs", "node:fs/promises", "fs/promises", "chokidar", "picomatch"],
  "E-PROC": ["node:child_process", "child_process", "execa", "node:worker_threads", "node:worker"],
  "E-SYS": ["node:os", "os", "path", "node:path", "node:crypto", "crypto", "node:url", "url"],
  "E-NET": ["node:net", "node:http", "axios", "node:https"],
  "E-SQLITE": ["better-sqlite3"],
  "E-LLM": ["@anthropic-ai/sdk", "openai"],
  "E-MCP": ["@modelcontextprotocol/sdk"],
  "E-BROWSER": ["playwright"],
  "E-TUI": ["blessed", "inquirer/prompts"],
  "E-SCHEMA": ["zod", "ajv"],
  "E-CONF": ["yaml"],
  "E-TPL": ["handlebars"],
  "E-DOC": ["pdf-parse", "fast-xml-parser"],
  "E-IMG": ["jimp"],
  "E-ARCH": ["jszip"],
  "E-UTIL": ["diff"],
}));

const modules = [];
for (const entry of fs.readdirSync(AGENT_SRC, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(AGENT_SRC, entry.name);
  const files = walk(dir, [], SKIP_DIRS_IN_MODULES);
  const signals = {};
  const peers = {};
  let loc = 0, escapes = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    loc += text.split("\n").length;
    let m; IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(text))) {
      const spec = m[1];
      const base = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      for (const [sig, names] of SIGNALS) {
        if (names.includes(base)) { signals[sig] = (signals[sig] ?? 0) + 1; break; }
      }
      if (spec.startsWith(".")) {
        const t = resolveFile(path.resolve(path.dirname(f), spec));
        if (t) {
          const r = rel(t);
          const pm = r.match(/^packages\/agent\/src\/([^/]+)\//);
          if (pm) peers[pm[1]] = (peers[pm[1]] ?? 0) + 1;
          if (r.startsWith("src/") || r.startsWith("electron/")) escapes += 1;
        }
      }
    }
  }
  modules.push({ module: entry.name, files: files.length, loc, signals, peers, escapes });
}
modules.sort((a, b) => b.loc - a.loc);

const agentSrcFiles = walk(AGENT_SRC, [], SKIP_DIRS_IN_MODULES);
const agentSrcLoc = modules.reduce((a, m) => a + m.loc, 0);

const result = {
  meta: {
    packagesFiles: pkgFiles.length,
    cyclicGroups: sccs.length,
    agentSrcModules: modules.length,
    agentSrcFiles: agentSrcFiles.length,
    agentSrcLoc,
  },
  cycles: sccs.map((c) => ({
    size: c.length,
    files: c.map(rel).slice(0, 20),
  })),
  agentModules: modules.map((m) => ({
    module: m.module,
    files: m.files,
    loc: m.loc,
    signals: m.signals,
    topPeers: Object.entries(m.peers).sort((a, b) => b[1] - a[1]).slice(0, 5),
    hostEscapes: m.escapes,
  })),
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const m = result.meta;
  console.log("=== Duya module graph + classification audit ===");
  console.log(`packages/ files           ${m.packagesFiles}`);
  console.log(`cyclic groups (SCC > 1)   ${m.cyclicGroups}`);
  console.log(`agent/src top-level mods  ${m.agentSrcModules}`);
  console.log(`agent/src files (no tests)${String(m.agentSrcFiles).padStart(4)}`);
  console.log(`agent/src LOC (no tests)  ${m.agentSrcLoc}`);
  if (sccs.length) {
    console.log("\n--- cycles (top 3) ---");
    for (const c of result.cycles.slice(0, 3)) {
      console.log(`SCC size ${c.size}:`);
      for (const f of c.files) console.log("   ", f);
      if (c.size > 20) console.log(`    ... (${c.size - 20} more)`);
    }
  }
  console.log("\n--- agent/src modules (LOC desc) ---");
  console.log("module".padEnd(18) + "files".padStart(6) + "loc".padStart(9) + "  signals");
  for (const a of result.agentModules) {
    const s = Object.entries(a.signals).sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k}:${v}`).join(" ");
    console.log(a.module.padEnd(18) + String(a.files).padStart(6) + String(a.loc).padStart(9) + "  " + (s || "-"));
  }
}
