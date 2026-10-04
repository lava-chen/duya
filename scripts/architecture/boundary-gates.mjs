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
 */
export const SUBPATH_LAYERS = new Map([['@duya/cli/contract', 'runtime']]);

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

export function findSessionRootedTables(tables = DURABLE_IDENTITY_TABLES) {
  const findings = [];
  const dbDir = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'main');
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
    { gate: 'G4', title: 'worker implements ExecutionChannel, not DuyaAgent', findings: findWorkerSeamBypasses() },
    { gate: 'G6', title: 'durable identity is not rooted at session_id', findings: findSessionRootedTables() },
  ];
}

export const BASELINE_PATH = path.join(REPO_ROOT, 'scripts', 'architecture', 'boundary-gates-baseline.json');

/** gate | file | line | identity — location matters, so a moved violation is new. */
export function fingerprint(report, finding) {
  const f = finding ?? {};
  return [
    report.gate,
    String(f.file ?? f.table ?? '?'),
    String(f.line ?? '-'),
    String(f.to ?? f.column ?? f.symbol ?? f.why ?? ''),
  ].join('|');
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
    const known = [];
    const newFindings = [];
    for (const finding of report.findings) {
      const key = fingerprint(report, finding);
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
  const entries = reports.flatMap((r) => r.findings.map((f) => fingerprint(r, f))).sort();
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
