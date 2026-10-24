#!/usr/bin/env node
/**
 * Agent E — static import-closure analysis for the shared renderer.
 *
 * Purpose: decide WHICH views can leave the first-screen closure, and how
 * much each one weighs, BEFORE spending a build cycle.
 *
 * It walks the `packages/ui/src` module graph from a set of entry files and
 * reports, per entry, the transitive set of first-party modules and the
 * third-party packages that entry drags in.
 *
 * Caveats, stated so the numbers are not over-read:
 *   - Byte size is NOT reported here (only the real build can say that);
 *     this answers "how many modules" and "which external packages".
 *   - `import type` / type-only specifiers are skipped, matching what the
 *     bundler erases.
 *   - Bare specifiers are leaves: the script reports the package name and
 *     stops, because the bundler resolves them through node_modules.
 *
 * Usage:
 *   node e2e/perf/agents/agent-e/module-closure.mjs [entry ...]
 *   (no args -> the default view set used by the perf plan)
 *
 * No packages/ import: this file lives under e2e/ and must stay free of
 * product dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const uiSrc = path.join(repoRoot, 'packages', 'ui', 'src');

const DEFAULT_ENTRIES = [
  'components/layout/app-shell.tsx',
  'components/home/WelcomeView.tsx',
  'components/chat/ChatView.tsx',
  'components/chat/BotDirectChatView.tsx',
  'components/chat/GroupRoomChatView.tsx',
  'components/chat/NewChatView.tsx',
  'components/skills/SkillsView.tsx',
  'components/automation/AutomationView.tsx',
  'components/workflow/WorkflowPage.tsx',
  'components/projects/ProjectsView.tsx',
  'components/extensions/ExtensionsPage.tsx',
  'components/plugin-apps/MiniAppsView.tsx',
  'components/settings/SettingsView.tsx',
  'components/SearchCommandPalette.tsx',
  'components/chat/MessageInput.tsx',
  'components/chat/MarkdownRenderer.tsx',
  'components/icons.tsx',
];

const entries = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const args = process.argv.slice(2);

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function resolveFile(base) {
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  for (const ext of EXTENSIONS) {
    const candidate = path.join(base, 'index' + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Resolve a bare specifier the way the renderer's vite aliases do. */
function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith('@duya/ui/styles.css')) return { kind: 'asset', id: spec };
  if (spec.startsWith('@duya/ui/')) return resolveFile(path.join(uiSrc, spec.slice('@duya/ui/'.length)));
  if (spec === '@duya/ui') return path.join(uiSrc, 'index.ts');
  if (spec.startsWith('@/')) return resolveFile(path.join(uiSrc, spec.slice(2)));
  if (spec.startsWith('.')) return resolveFile(path.resolve(path.dirname(fromFile), spec));
  if (spec.startsWith('node:')) return null;
  return { kind: 'external', id: packageName(spec) };
}

function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Static imports only. `import type` is erased by TypeScript and never
 * reaches the bundle, so it must not count as a dependency.
 *
 * The statement must START a line: the word "import" also occurs inside
 * comments, strings and prose, and a non-anchored match happily swallows
 * half the file.
 */
function staticImports(code) {
  const out = [];
  const fromRe = /^[ \t]*import\s+([\s\S]*?)\bfrom\s*["']([^"']+)["']/gm;
  const bareRe = /^[ \t]*import\s*["']([^"']+)["']/gm;
  const exportFromRe = /^[ \t]*export\s+([\s\S]*?)\bfrom\s*["']([^"']+)["']/gm;
  let m;
  while ((m = fromRe.exec(code))) {
    const clause = (m[1] ?? '').trim();
    const spec = m[2];
    if (/^type\b/.test(clause)) continue;
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named && !clause.includes("'") && named[1].split(',').every((p) => /^\s*type\b/.test(p))) {
      // `import { type A, type B } from 'x'` — every binding is a type.
      continue;
    }
    out.push(spec);
  }
  while ((m = bareRe.exec(code))) out.push(m[1]);
  while ((m = exportFromRe.exec(code))) {
    const clause = (m[1] ?? '').trim();
    if (/^type\b/.test(clause)) continue;
    out.push(m[2]);
  }
  return out;
}

function closureFor(entryFile, excluded = new Set()) {
  const seen = new Set();
  const externals = new Set();
  const stack = [entryFile];
  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    // An excluded view is a LEAF: modelling `React.lazy(() => import(...))`
    // means the bundler stops the static graph at that boundary.
    if (excluded.has(file)) continue;
    let code;
    try {
      code = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const spec of staticImports(code)) {
      const resolved = resolveSpecifier(spec, file);
      if (!resolved) continue;
      if (typeof resolved === 'string') {
        stack.push(resolved);
      } else if (resolved.kind === 'external') {
        externals.add(resolved.id);
      }
    }
  }
  return { modules: seen, externals };
}

/**
 * `--exclude=a,b` models the lazy-loading change: those view modules stop
 * the static graph, exactly like a `React.lazy(() => import(...))` boundary.
 */
const excludeArg = args.find((a) => a.startsWith('--exclude='));
const excludedRel = excludeArg ? excludeArg.slice('--exclude='.length).split(',').filter(Boolean) : [];
const excludedAbs = new Set(
  excludedRel.map((rel) => path.resolve(uiSrc, rel.trim())),
);

if (excludedRel.length) {
  const appEntry = path.join(uiSrc, 'App.tsx');
  const before = closureFor(appEntry);
  const after = closureFor(appEntry, excludedAbs);
  const removed = [...before.modules].filter((f) => !after.modules.has(f));
  const removedExternals = [...before.externals].filter((e) => !after.externals.has(e));
  console.log(`[agent-e] App.tsx static closure: ${before.modules.size} modules -> ${after.modules.size} modules`);
  console.log(`[agent-e] removed ${removed.length} first-party modules`);
  console.log(`[agent-e] external packages only in the eager graph: ${removedExternals.join(', ') || '(none)'}`);
  console.log('[agent-e] removed modules by area:');
  const byArea = new Map();
  for (const f of removed) {
    const rel = path.relative(uiSrc, f).split(path.sep).join('/');
    const area = rel.split('/').slice(0, 3).join('/');
    byArea.set(area, (byArea.get(area) ?? 0) + 1);
  }
  for (const [area, n] of [...byArea.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${String(n).padStart(4)}  ${area}`);
  }
  process.exit(0);
}

const results = {};
for (const entry of (entries.length ? entries : DEFAULT_ENTRIES)) {
  const abs = path.resolve(uiSrc, entry);
  if (!fs.existsSync(abs)) {
    results[entry] = { error: 'entry not found' };
    continue;
  }
  const { modules, externals } = closureFor(abs);
  results[entry] = {
    moduleCount: modules.size,
    externalPackages: [...externals].sort(),
  };
}

// How much does each entry ADD on top of the first-screen baseline
// (app-shell + welcome view)? That delta is the candidate saving.
const baselineEntries = ['components/layout/app-shell.tsx', 'components/home/WelcomeView.tsx'];
const baseline = new Set();
for (const b of baselineEntries) {
  const abs = path.resolve(uiSrc, b);
  if (fs.existsSync(abs)) for (const f of closureFor(abs).modules) baseline.add(f);
}

console.log(`[agent-e] baseline (app-shell + welcome) = ${baseline.size} first-party modules\n`);
const rows = [];
for (const [entry, info] of Object.entries(results)) {
  if (info.error) {
    console.log(`${entry}: ${info.error}`);
    continue;
  }
  const abs = path.resolve(uiSrc, entry);
  const extra = [...closureFor(abs).modules].filter((f) => !baseline.has(f)).length;
  rows.push({ entry, total: info.moduleCount, extra, externals: info.externalPackages });
}
rows.sort((a, b) => b.extra - a.extra);
for (const r of rows) {
  console.log(`${String(r.extra).padStart(4)} extra / ${String(r.total).padStart(4)} total  ${r.entry}`);
  console.log(`       externals: ${r.externals.join(', ') || '(none)'}`);
}
