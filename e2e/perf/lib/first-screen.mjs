/**
 * e2e/perf/lib/first-screen.mjs — what the renderer has to download and
 * evaluate before the first screen can paint.
 *
 * WHY THIS IS A LIBRARY
 *
 * Two callers need the same answer and must not disagree:
 *   - `e2e/perf/agents/agent-e/first-screen-payload.mjs` reports it.
 *   - `scripts/perf/first-screen-budget.mjs` gates CI on it.
 * A measurement that has two implementations is a measurement with two
 * numbers, so the computation lives here once.
 *
 * METHOD (emitted artifacts only, no bundler internals):
 *   1. `dist/index.html` names the entry chunk via its module script tag.
 *   2. Every emitted chunk is parsed for its STATIC import statements
 *      (`import ... from "./x.js"`). Dynamic imports (`import("./x.js")`) are
 *      the lazy boundaries and are deliberately NOT part of the closure: a
 *      dynamically imported chunk is fetched only when its component is
 *      actually rendered, so it is not a first-screen cost.
 *   3. The transitive closure of static imports from the entry chunk is the
 *      first-screen payload.
 *
 * With a Rollup chunk-graph dump (see `readChunkDump` below) the exact
 * `imports` / `dynamicImports` / `moduleIds` of every chunk are used instead
 * of the regex scan; without one the graph is derived from the emitted
 * chunks, and the two agree on the first-screen closure.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Static imports only — `import(` is the lazy boundary and is skipped. */
export function staticImports(code) {
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
export function dynamicImports(code) {
  const out = new Set();
  const re = /import\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(code))) out.add(m[1]);
  return [...out];
}

/** The entry chunk file name, as named by the built `index.html`. */
export function readEntryChunk(distDir) {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const entryMatch =
    html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)
    || html.match(/<script[^>]+src="([^"]+)"[^>]+type="module"/);
  if (!entryMatch) return null;
  return path.basename(entryMatch[1].split('?')[0]);
}

/**
 * Read a Rollup chunk-graph dump, when one is available.
 *
 * The dump is NOT produced by the repository build: it is written by a
 * throwaway Rollup plugin into a file outside `dist/`, so the measurement
 * never adds a byte to the shipped bundle. Rollup's own `imports` /
 * `dynamicImports` per chunk are the ground truth, so a dump is preferred
 * over the regex scan.
 */
export function readChunkDump(chunkDumpPath) {
  if (!chunkDumpPath || !fs.existsSync(chunkDumpPath)) return null;
  return JSON.parse(fs.readFileSync(chunkDumpPath, 'utf8'));
}

/**
 * Compute the first-screen payload of a built renderer.
 *
 * Throws when the build output is missing or has no module entry: a payload
 * of "zero bytes" is not a measurement, and a gate over a zero measurement
 * proves nothing.
 */
export function computeFirstScreenPayload({ distDir, chunkDump = null, repoRoot = null }) {
  const assetsDir = path.join(distDir, 'assets');
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`no assets dir at ${assetsDir} — run a production build first`);
  }
  const entryFile = readEntryChunk(distDir);
  if (!entryFile) {
    throw new Error('no module entry script found in dist/index.html');
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

  const resolveChunk = (spec) => {
    const base = path.basename(spec.split('?')[0]);
    return chunks.has(base) ? base : null;
  };

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
  const sourcesFor = (chunkFile) => {
    const mapFile = path.join(assetsDir, chunkFile + '.map');
    if (!fs.existsSync(mapFile)) return null;
    try {
      const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      return (map.sources || []).map((s) => s.replace(/^(\.\.\/)+/, ''));
    } catch {
      return null;
    }
  };

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

  const root = repoRoot ?? path.resolve(distDir, '..');
  return {
    dist: path.relative(root, distDir),
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
}
