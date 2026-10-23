#!/usr/bin/env node
/**
 * Agent E — first-screen JS payload accounting for the shared renderer.
 *
 * Answers: "how many bytes of JavaScript does the renderer have to download
 * and evaluate before the first screen can paint, and how many chunks is that
 * spread over?"
 *
 * Method (no bundler internals, only the emitted artifacts):
 *   1. `dist/index.html` names the entry chunk via its module script tag.
 *   2. Every emitted chunk is parsed for its STATIC import statements
 *      (`import ... from "./x.js"`). Dynamic imports (`import("./x.js")`)
 *      are the lazy boundaries and are deliberately NOT part of the closure:
 *      a dynamically imported chunk is fetched only when its component is
 *      actually rendered, so it is not a first-screen cost.
 *   3. The transitive closure of static imports from the entry chunk is the
 *      first-screen payload.
 *
 * With `--sourcemap` present the script also attributes each chunk to its
 * source modules, so "the startup chunk is big" can be attributed to files.
 *
 * Usage:
 *   node e2e/perf/agents/agent-e/first-screen-payload.mjs [--dist dist] [--json]
 *
 * No packages/ import: this file lives under e2e/ and must stay free of
 * product dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(name);
}
function option(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..', '..');
const distDir = path.resolve(repoRoot, option('--dist', 'dist'));
const assetsDir = path.join(distDir, 'assets');

if (!fs.existsSync(assetsDir)) {
  console.error(`[agent-e] no assets dir at ${assetsDir} — run a production build first`);
  process.exit(2);
}

const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
const entryMatch = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/) || html.match(/<script[^>]+src="([^"]+)"[^>]+type="module"/);
if (!entryMatch) {
  console.error('[agent-e] no module entry script found in dist/index.html');
  process.exit(2);
}
const entrySrc = entryMatch[1];
const entryFile = path.basename(entrySrc.split('?')[0]);

/**
 * Exact chunk graph, when the build was run with the chunk-dump plugin:
 * `dist/.perf-chunks.json` holds Rollup's own `imports` / `dynamicImports`
 * per chunk, plus the module ids behind it. Prefer it over the regex scan —
 * the regex has to guess at minified import syntax, Rollup does not guess.
 */
const chunkDumpPath = path.join(distDir, '.perf-chunks.json');
const chunkDump = fs.existsSync(chunkDumpPath)
  ? JSON.parse(fs.readFileSync(chunkDumpPath, 'utf8'))
  : null;

/** Static imports only — `import(` is the lazy boundary and is skipped. */
function staticImports(code) {
  const out = new Set();
  // `import ... from "./x.js"` / `export ... from "./x.js"`.
  // The clause is matched lazily and tolerates the minified form
  // `import{a}from"./x.js"`, where there is no whitespace around `from`.
  const fromRe = /(?:^|[\s;}])import\s*(?:[^'"();]*?from\s*)?["']([^"']+)["']/g;
  const exportFromRe = /(?:^|[\s;}])export\s*(?:[^'"();]*?from\s*)?["']([^"']+)["']/g;
  let m;
  while ((m = fromRe.exec(code))) {
    // `import(` never matches this pattern: `(` is excluded from the
    // clause class and the quote cannot follow it, so a dynamic import is
    // structurally out of reach here.
    out.add(m[1]);
  }
  while ((m = exportFromRe.exec(code))) out.add(m[1]);
  return [...out];
}

/** Dynamic imports — the lazy chunk boundaries. */
function dynamicImports(code) {
  const out = new Set();
  const re = /import\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(code))) out.add(m[1]);
  return [...out];
}

const chunkFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
/** Rollup reports `assets/<file>`; the analyzer works on the bare file name. */
const dumpedChunks = (chunkDump?.chunks ?? []).map((c) => ({
  ...c,
  base: path.basename(c.fileName),
}));
const chunks = new Map();
for (const f of chunkFiles) {
  const code = fs.readFileSync(path.join(assetsDir, f), 'utf8');
  const dumped = dumpedChunks.find((c) => c.base === f);
  chunks.set(f, {
    file: f,
    bytes: Buffer.byteLength(code, 'utf8'),
    staticImports: dumped ? dumped.imports : staticImports(code),
    dynamicImports: dumped ? dumped.dynamicImports : dynamicImports(code),
    moduleIds: dumped?.moduleIds ?? null,
  });
}

function resolveChunk(spec) {
  const base = path.basename(spec.split('?')[0]);
  return chunks.has(base) ? base : null;
}
// Transitive closure of static imports from the entry chunk.
const closure = new Set();
const stack = [entryFile];
while (stack.length) {
  const cur = stack.pop();
  if (!cur || closure.has(cur)) continue;
  closure.add(cur);
  const chunk = chunks.get(cur);
  if (!chunk) continue;
  for (const spec of chunk.staticImports) {
    const target = resolveChunk(spec);
    if (target) stack.push(target);
  }
}

const closureBytes = [...closure].reduce((sum, f) => sum + (chunks.get(f)?.bytes ?? 0), 0);
const totalJsBytes = [...chunks.values()].reduce((sum, c) => sum + c.bytes, 0);
const entryBytes = chunks.get(entryFile)?.bytes ?? 0;

// Chunks that are only reachable through a dynamic import (the lazy set).
const lazyChunks = new Set();
for (const chunk of chunks.values()) {
  for (const spec of chunk.dynamicImports) {
    const target = resolveChunk(spec);
    if (target) lazyChunks.add(target);
  }
}
const lazyOnly = [...lazyChunks].filter((f) => !closure.has(f));

// Sourcemap attribution (optional).
function sourcesFor(chunkFile) {
  const mapFile = path.join(assetsDir, chunkFile + '.map');
  if (!fs.existsSync(mapFile)) return null;
  try {
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    return (map.sources || []).map((s) => s.replace(/^(\.\.\/)+/, ''));
  } catch {
    return null;
  }
}

const perChunk = [...closure]
  .map((f) => {
    const chunk = chunks.get(f);
    return {
      chunk: f,
      bytes: chunk.bytes,
      kb: Math.round((chunk.bytes / 1024) * 10) / 10,
      moduleCount: chunk.moduleIds ? chunk.moduleIds.length : null,
      sources: sourcesFor(f),
    };
  })
  .sort((a, b) => b.bytes - a.bytes);

// Attribution: which first-party areas and which third-party packages the
// first-screen closure actually contains.
const firstParty = new Map();
const thirdParty = new Map();
for (const f of closure) {
  const chunk = chunks.get(f);
  for (const id of chunk.moduleIds ?? []) {
    const norm = id.replace(/\\/g, '/');
    const uiIdx = norm.indexOf('packages/ui/src/');
    if (uiIdx >= 0) {
      const area = norm.slice(uiIdx + 'packages/ui/src/'.length).split('/').slice(0, 2).join('/');
      firstParty.set(area, (firstParty.get(area) ?? 0) + 1);
      continue;
    }
    const m = norm.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (m) thirdParty.set(m[1], (thirdParty.get(m[1]) ?? 0) + 1);
  }
}

const report = {
  dist: path.relative(repoRoot, distDir),
  entry: entryFile,
  firstScreen: {
    chunkCount: closure.size,
    bytes: closureBytes,
    kb: Math.round((closureBytes / 1024) * 10) / 10,
  },
  entryChunkBytes: entryBytes,
  totalJs: {
    chunkCount: chunks.size,
    bytes: totalJsBytes,
    kb: Math.round((totalJsBytes / 1024) * 10) / 10,
  },
  lazyOnlyChunks: {
    chunkCount: lazyOnly.length,
    bytes: lazyOnly.reduce((s, f) => s + (chunks.get(f)?.bytes ?? 0), 0),
  },
  firstPartyAreas: [...firstParty.entries()].sort((a, b) => b[1] - a[1]),
  thirdPartyPackages: [...thirdParty.entries()].sort((a, b) => b[1] - a[1]),
  chunks: perChunk,
};

if (flag('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[agent-e] dist=${report.dist} entry=${report.entry}`);
  console.log(`[agent-e] FIRST-SCREEN JS: ${report.firstScreen.kb} KB in ${report.firstScreen.chunkCount} chunks`);
  console.log(`[agent-e] TOTAL JS       : ${report.totalJs.kb} KB in ${report.totalJs.chunkCount} chunks`);
  console.log(`[agent-e] LAZY-ONLY JS   : ${Math.round((report.lazyOnlyChunks.bytes / 1024) * 10) / 10} KB in ${report.lazyOnlyChunks.chunkCount} chunks`);
  console.log('[agent-e] first-screen chunks:');
  for (const c of perChunk) console.log(`  ${String(c.kb).padStart(8)} KB  ${c.chunk}`);
  if (report.thirdPartyPackages.length) {
    console.log('[agent-e] third-party packages in the first screen (module count):');
    for (const [pkg, n] of report.thirdPartyPackages.slice(0, 20)) console.log(`  ${String(n).padStart(5)}  ${pkg}`);
  }
  if (report.firstPartyAreas.length) {
    console.log('[agent-e] first-party areas in the first screen (module count):');
    for (const [area, n] of report.firstPartyAreas.slice(0, 20)) console.log(`  ${String(n).padStart(5)}  ${area}`);
  }
}
