#!/usr/bin/env node
/**
 * architecture-check.mjs — ratcheting boundary gate (plan 584 PP-0, task 0.2).
 *
 * Design source: docs/architecture/05-architecture-governance.md §4.
 *
 * ## Why this consumes the audit scripts instead of re-implementing them
 *
 * The acceptance criterion for PP-0 is that `architecture:self-test` counts
 * match `audit-imports.mjs` exactly. The cheapest way to make that structurally
 * true — rather than something a human has to verify twice — is to be the same
 * computation. This checker spawns the two audit scripts and reads their JSON.
 * It therefore cannot drift from the numbers quoted in the audit doc, and the
 * documented "resolver must see every known violation" invariant is enforced by
 * construction rather than by discipline.
 *
 * That also inherits the resolver's one hard requirement (05 §4.1): workspace
 * package names MUST resolve through the target's real `exports` map, which is
 * the step ZCode's checker skipped and therefore never checked a single
 * cross-package import.
 *
 * ## What blocks
 *
 * `managedOnly: true` + every legacy module `managed: false` means:
 *
 *   1. any violation inside a `managed: true` module  -> fail (zero tolerance)
 *   2. any violation whose fingerprint is not in the baseline -> fail
 *
 * A strict gate over the ~838 violations below would be permanently red, and a
 * permanently red gate gets ignored. So this is a ratchet: the debt is frozen
 * and only growth is blocked. Each migration step flips one module to
 * `managed: true` and drops that module's fingerprints from the baseline.
 *
 * ## Usage
 *
 *   node scripts/architecture/architecture-check.mjs            # check (CI)
 *   node scripts/architecture/architecture-check.mjs --self-test  # count assertions
 *   node scripts/architecture/architecture-check.mjs --write      # re-record baseline
 *   node scripts/architecture/architecture-check.mjs --changed [ref]
 *   node scripts/architecture/architecture-check.mjs --json
 *
 * Exit codes: 0 = pass, 1 = new violations, 2 = engine or self-test failure.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "../..");
const POLICY_PATH = path.join(ROOT, "architecture-policy.yaml");

const argv = new Set(process.argv.slice(2));
const WRITE = argv.has("--write");
const SELF_TEST = argv.has("--self-test");
const AS_JSON = argv.has("--json");
const CHANGED_REF = (() => {
  const i = process.argv.indexOf("--changed");
  return i === -1 ? null : (process.argv[i + 1] ?? "HEAD");
})();

const die = (msg, code = 2) => {
  process.stderr.write(`architecture-check: ${msg}\n`);
  process.exit(code);
};

// ── policy ────────────────────────────────────────────────────────────────

if (!fs.existsSync(POLICY_PATH)) die(`missing policy file: ${POLICY_PATH}`);
let policy;
try {
  policy = YAML.parse(fs.readFileSync(POLICY_PATH, "utf8"));
} catch (err) {
  die(`could not parse ${path.relative(ROOT, POLICY_PATH)}: ${err.message}`);
}
if (!policy || policy.version !== 1) die("unsupported policy version (expected 1)");

const RULES = policy.global?.rules ?? {};
const ruleEnabled = (name) => RULES[name] === true;
const MANAGED_ONLY = policy.global?.managedOnly !== false;
const BASELINE_PATH = path.join(ROOT, policy.global?.baselineFile ?? ".architecture-baseline.json");
const selfTestExpected = policy.selfTest ?? {};

// ── glob / prefix matching ────────────────────────────────────────────────

/**
 * Minimal glob -> RegExp. Supports `*` (one segment) and `**` (any depth),
 * which is all the policy file uses. Written by hand because the policy must
 * stay readable as a policy, not as a build script.
 */
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `/**` should also match the bare root
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

const asPosix = (p) => p.split(path.sep).join("/");

/** Module roots are directory prefixes, not globs. */
function underRoot(file, root) {
  const f = asPosix(file);
  const r = asPosix(root).replace(/\/$/, "");
  return f === r || f.startsWith(`${r}/`);
}

// ── module ownership ──────────────────────────────────────────────────────

const modules = (policy.modules ?? []).map((m) => ({
  id: m.id,
  managed: m.managed === true,
  roots: (m.roots ?? []).map(asPosix),
  // Carried through so `requires` can be evaluated. It was not read here
  // before, which is why a declared dependency and a violation looked
  // identical to the verdict — see `moduleDependencyPermitted`.
  requires: (m.requires ?? []).map(String),
  publicEntrypoints: (m.publicEntrypoints ?? []).map(asPosix),
}));

function moduleOf(file) {
  for (const m of modules) {
    if (m.roots.some((r) => underRoot(file, r))) return m;
  }
  return null;
}

/** Owner label (from the audit script) back to a repository path prefix. */
function ownerToRoot(owner) {
  if (owner.startsWith("pkg:")) return `packages/${owner.slice(4)}`;
  if (owner === "electron-main") return "electron";
  if (owner === "src-renderer") return "src";
  return null;
}

const forbiddenRules = (policy.forbiddenDependencies ?? []).map((r) => ({
  from: (Array.isArray(r.from) ? r.from : [r.from]).map(globToRegExp),
  to: (r.to ?? []).map(globToRegExp),
  reason: String(r.reason ?? "").replace(/\s+/g, " ").trim(),
}));

function findForbidden(fromFile, toPath) {
  for (const rule of forbiddenRules) {
    if (!rule.from.some((re) => re.test(fromFile))) continue;
    if (rule.to.some((re) => re.test(toPath))) return rule.reason;
  }
  return null;
}

/**
 * Is this cross-module edge one the policy explicitly permits?
 *
 * True when the SOURCE module declares the target in its `requires` list.
 * `ownerToRoot` maps the audit's owner label (`pkg:agent-protocol`) back to
 * the repository path prefix, which is how a required module is matched
 * against a declared root.
 */
function moduleDependencyPermitted(fromFile, toOwner) {
  const from = moduleOf(fromFile);
  if (from === null) return false;
  const toRoot = ownerToRoot(toOwner);
  if (toRoot === null) return false;
  return (from.requires ?? []).some((id) => {
    const target = modules.find((m) => m.id === id);
    return target?.roots.some((r) => pathRootCovers(r, toRoot) || pathRootCovers(toRoot, r)) ?? false;
  });
}

/**
 * Path-prefix containment, on SEGMENT boundaries.
 *
 * Plain `startsWith` is wrong here in a way that silently inverts a rule:
 * `packages/agent`.startsWith(`packages/agent-protocol`) is false, but
 * `packages/agent-protocol`.startsWith(`packages/agent`) is TRUE, so a naive
 * bidirectional check treats the legacy `agent` package as CONTAINING both
 * new `agent-*` packages. Every electron-main -> packages/agent edge was then
 * permitted by a `requires: [agent-protocol]` declaration it had nothing to do
 * with — 154 edges waved through a rule meant to catch exactly those.
 *
 * A root only covers a path if the path is the root or continues past a
 * separator. `packages/agent` covers `packages/agent/src/x`; it does not cover
 * `packages/agent-protocol`.
 */
function pathRootCovers(root, p) {
  if (root === p) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return p.startsWith(prefix);
}

// ── audit data ────────────────────────────────────────────────────────────

function runAudit(script) {
  const file = path.join(SCRIPT_DIR, script);
  if (!fs.existsSync(file)) die(`missing audit script: ${script}`);
  let raw;
  try {
    raw = execFileSync(process.execPath, [file, "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    // A non-zero exit here is not automatically fatal: the audit scripts exit
    // non-zero only if they themselves blew up. Surface their output instead.
    if (err.stdout) raw = err.stdout;
    else die(`could not run ${script}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    die(`${script} did not emit valid JSON`);
  }
}

const imports = runAudit("audit-imports.mjs");
const modulesAudit = runAudit("audit-modules.mjs");

// ── violations ────────────────────────────────────────────────────────────

/** 05 §4.3 fingerprint. Identity = rule + where + what. */
const fingerprint = (rule, file, detail) =>
  createHash("sha256").update(`${rule}\0${file}\0${detail}`).digest("hex").slice(0, 16);

/**
 * Line endings are not part of a violation's identity.
 *
 * `.gitattributes` sets `* text=auto`, so the stored blob and a Windows
 * checkout genuinely differ from a Linux/macOS checkout. When raw source text
 * reached a fingerprint, the same violation hashed differently per platform:
 * a baseline recorded on Windows reported its own entry as "no longer
 * triggered" on Linux while the CRLF-free variant read as a brand new
 * violation. That is what made the `architecture` CI job unstable.
 *
 * The import regexes already refuse to capture across a line break, so no
 * specifier can carry CR or LF today. This is the SECOND, independent
 * guarantee, and the reason one change is not enough: the regexes are five
 * hand-copied literals, and a future rule — or a future copy of that regex —
 * could feed raw source text here again. Normalising at the single place a
 * fingerprint is minted makes the invariant hold regardless of what feeds it.
 *
 * It cannot weaken the gate. It only makes byte-identical code hash to one
 * fingerprint instead of two, which is the correct semantics: a CRLF checkout
 * and an LF checkout hold the same code and must agree on which debt is
 * tolerated.
 */
const normalizeEol = (s) => (s.includes("\r") ? s.replace(/\r\n/g, "\n") : s);

const violations = [];

/**
 * Occurrence counter per (rule, file, detail).
 *
 * A file may import the same specifier more than once — `import { a } from
 * './x'` plus `import type { b } from './x'`, or a re-export. Without a
 * discriminator those edges produce byte-identical fingerprints, so the
 * baseline collapses them and a NEW duplicate of an already-baselined import
 * lands on an existing fingerprint and passes. That is a bypassable gate, so
 * each occurrence gets its own index.
 */
const occurrence = new Map();

const add = (rule, file, detail) => {
  if (!ruleEnabled(rule)) return;
  // Normalised once, here, so the dedup key, the reported detail and the
  // fingerprint are all derived from the same platform-independent text.
  const normFile = normalizeEol(file);
  const normDetail = normalizeEol(detail);
  const key = `${rule}\0${normFile}\0${normDetail}`;
  const nth = occurrence.get(key) ?? 0;
  occurrence.set(key, nth + 1);
  violations.push({
    rule,
    file: normFile,
    detail: nth === 0 ? normDetail : `${normDetail} [occurrence ${nth + 1}]`,
    fingerprint: fingerprint(rule, normFile, nth === 0 ? normDetail : `${normDetail}#${nth}`),
  });
};

if (ruleEnabled("module-dependency")) {
  for (const e of imports.crossBoundaryEdges ?? []) {
    const reason = findForbidden(e.from, e.to.startsWith("UNRESOLVED:") ? (ownerToRoot(e.toOwner) ?? e.to) : e.to);
    if (reason) add("forbidden-dependency", e.from, `${e.spec} -> ${e.to} :: ${reason}`);
    // A module's own `requires` list is the DECLARATION of which cross-boundary
    // edges are permitted. An edge into a required module is the policy working,
    // not a breach of it.
    //
    // It used to be recorded unconditionally, and because a `managed: true`
    // module blocks on every violation it holds, that made the two managed
    // packages with declared dependencies (`agent-core` requires
    // `agent-protocol`; `agent-runtime` requires both) permanently red. A
    // `requires` list nobody can satisfy is not a boundary. `agent-protocol`
    // never exposed this: it is the only managed module that exists, and it has
    // `requires: []`.
    //
    // Permitted edges are still COUNTED, in a separate rule, so the graph stays
    // visible and a future `requires` edit shows up as a count change rather
    // than as silence.
    const permitted = moduleDependencyPermitted(e.from, e.toOwner);
    add(
      permitted ? "module-dependency-permitted" : "module-dependency",
      e.from,
      `${e.fromOwner} -> ${e.toOwner}: ${e.spec}`,
    );
  }
}

if (ruleEnabled("package-boundary-escape")) {
  for (const e of imports.packageBoundaryEscapeEdges ?? []) {
    add("package-boundary-escape", e.from, `${e.fromOwner} -> ${e.toOwner}: ${e.spec}`);
  }
}

if (ruleEnabled("deep-import")) {
  for (const e of imports.deepImportEdges ?? []) {
    add("deep-import", e.from, `${e.to} via ${e.spec}`);
  }
}

if (ruleEnabled("cycle")) {
  for (const group of modulesAudit.cycles ?? []) {
    // Anchor on the smallest member so the group has a stable identity, and
    // record the size so a group that grows or shrinks reads as a change.
    const anchor = [...group.files].sort()[0] ?? "(unknown)";
    add("cycle", anchor, `SCC size=${group.size}`);
  }
}

if (ruleEnabled("missing-module-artifact")) {
  const pkgDir = path.join(ROOT, "packages");
  for (const entry of fs.readdirSync(pkgDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(pkgDir, entry.name, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!manifest.name) continue;
    if (!manifest.exports) {
      add("missing-module-artifact", `packages/${entry.name}/package.json`, `${manifest.name} has no exports map`);
    }
  }
}

// ── baseline ──────────────────────────────────────────────────────────────

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return { entries: new Set(), meta: null };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  } catch (err) {
    die(`could not parse baseline: ${err.message}`);
  }
  return { entries: new Set(data.violations ?? []), meta: data.meta ?? null };
}

const baseline = readBaseline();
const counts = new Map();
for (const v of violations) counts.set(v.rule, (counts.get(v.rule) ?? 0) + 1);

// ── --self-test ───────────────────────────────────────────────────────────

if (SELF_TEST) {
  const problems = [];
  for (const [rule, expected] of Object.entries(selfTestExpected)) {
    const actual = counts.get(rule) ?? 0;
    if (actual !== expected) {
      problems.push(`  ${rule.padEnd(26)} expected ${expected}, counted ${actual}`);
    }
  }
  if (problems.length) {
    process.stderr.write(
      `\narchitecture-check: --self-test FAILED. The resolver must be able to see\n` +
        `every known violation; a mismatch means a hole, not a cleaner codebase.\n\n` +
        `${problems.join("\n")}\n\n` +
        `Recompute the expected values with:\n` +
        `  node scripts/architecture/audit-imports.mjs\n` +
        `  node scripts/architecture/audit-modules.mjs\n` +
        `and update the selfTest block in architecture-policy.yaml.\n\n`,
    );
    process.exit(2);
  }
  process.stdout.write(
    `architecture-check: --self-test OK — every known violation is visible.\n` +
      Object.entries(selfTestExpected)
        .map(([rule, n]) => `  ${rule.padEnd(26)} ${n}`)
        .join("\n") +
      "\n",
  );
  process.exit(0);
}

// ── --write ───────────────────────────────────────────────────────────────

if (WRITE) {
  const sorted = [...violations].sort((a, b) =>
    a.rule === b.rule ? a.fingerprint.localeCompare(b.fingerprint) : a.rule.localeCompare(b.rule),
  );
  const payload = {
    version: 1,
    generatedBy: "scripts/architecture/architecture-check.mjs --write",
    note:
      "Frozen legacy boundary debt. Only violations listed here are tolerated; " +
      "anything new blocks. Delete entries as their migration lands — never add " +
      "an entry to silence a new violation.",
    meta: { counts: Object.fromEntries([...counts].sort()) },
    violations: sorted.map((v) => v.fingerprint),
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(
    `architecture-check: wrote ${sorted.length} fingerprint(s) to ` +
      `${path.relative(ROOT, BASELINE_PATH)}\n`,
  );
  for (const [rule, n] of [...counts].sort()) {
    process.stdout.write(`  ${rule.padEnd(26)} ${n}\n`);
  }
  process.exit(0);
}

// ── --changed ─────────────────────────────────────────────────────────────

let scope = null;
if (CHANGED_REF) {
  let changed = [];
  try {
    const out = execFileSync("git", ["diff", "--name-only", `${CHANGED_REF}...HEAD`], {
      cwd: ROOT,
      encoding: "utf8",
    });
    changed = out.split(/\r?\n/).filter(Boolean).map(asPosix);
    const dirty = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: ROOT, encoding: "utf8" });
    changed = [...new Set([...changed, ...dirty.split(/\r?\n/).filter(Boolean).map(asPosix)])];
  } catch (err) {
    die(`--changed could not diff against ${CHANGED_REF}: ${err.message}`);
  }
  // Blast radius = the changed files plus everything that cross-boundary
  // imports them. This is deliberately cross-boundary only: the audit output
  // exposes the cross-boundary edge set, not the full internal graph, so a
  // full transitive closure would be a claim this data cannot support.
  const changedSet = new Set(changed);
  const downstream = new Set();
  for (const e of imports.crossBoundaryEdges ?? []) {
    if (changedSet.has(asPosix(e.to))) downstream.add(asPosix(e.from));
  }
  scope = new Set([...changedSet, ...downstream]);
}

// ── verdict ───────────────────────────────────────────────────────────────

// Rules that MEASURE rather than forbid. They are reported, counted and
// fingerprinted so the graph stays visible and a `requires` edit shows up as a
// count change — but they never block, even inside a `managed: true` module.
// A managed module's zero tolerance is about rules it can actually break.
const MEASUREMENT_RULES = new Set(["module-dependency-permitted"]);

const blocking = [];
const tolerated = [];
for (const v of violations) {
  if (MEASUREMENT_RULES.has(v.rule)) {
    tolerated.push(v);
    continue;
  }
  const mod = moduleOf(v.file);
  const isManaged = mod?.managed === true;
  if (isManaged) {
    blocking.push({ ...v, reason: `module ${mod.id} is managed: true` });
  } else if (MANAGED_ONLY && !baseline.entries.has(v.fingerprint)) {
    blocking.push({ ...v, reason: "not in baseline" });
  } else {
    tolerated.push(v);
  }
}

const resolved = [...baseline.entries].filter((fp) => !violations.some((v) => v.fingerprint === fp));

const report = {
  counts: Object.fromEntries([...counts].sort()),
  total: violations.length,
  blocking: blocking.length,
  tolerated: tolerated.length,
  baselineSize: baseline.entries.size,
  resolvedFromBaseline: resolved.length,
  scope: scope ? scope.size : null,
};

if (AS_JSON) {
  process.stdout.write(
    `${JSON.stringify(
      { ...report, violations: blocking.map((v) => ({ rule: v.rule, file: v.file, detail: v.detail, reason: v.reason })) },
      null,
      2,
    )}\n`,
  );
  process.exit(blocking.length ? 1 : 0);
}

process.stdout.write("=== architecture boundary check ===\n");
for (const [rule, n] of [...counts].sort()) {
  process.stdout.write(`${rule.padEnd(28)} ${String(n).padStart(5)}\n`);
}
process.stdout.write(`${"total".padEnd(28)} ${String(violations.length).padStart(5)}\n`);
process.stdout.write(`${"tolerated (baselined)".padEnd(28)} ${String(tolerated.length).padStart(5)}\n`);
process.stdout.write(`${"baseline size".padEnd(28)} ${String(baseline.entries.size).padStart(5)}\n`);

if (resolved.length) {
  process.stdout.write(
    `\n${resolved.length} baseline fingerprint(s) no longer triggered. ` +
      `Re-record with --write to shrink the debt.\n`,
  );
}

if (!blocking.length) {
  process.stdout.write(`\nOK — no new boundary violations.\n`);
  process.exit(0);
}

process.stderr.write(`\n${blocking.length} NEW boundary violation(s):\n\n`);
for (const v of blocking.slice(0, 40)) {
  process.stderr.write(`  [${v.rule}] ${v.file}\n      ${v.detail}\n      -> ${v.reason}\n`);
}
if (blocking.length > 40) {
  process.stderr.write(`\n  ... and ${blocking.length - 40} more.\n`);
}
process.stderr.write(
  `\nFix them. If a violation is pre-existing debt that a migration legitimately\n` +
    `exposed, re-record the baseline with:\n  node scripts/architecture/architecture-check.mjs --write\n\n`,
);
process.exit(1);
