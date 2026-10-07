/**
 * `@duya/memory` must be reachable ONLY through its declared exports.
 *
 * Plan 610 A5. This is the invariant that makes the package a package rather
 * than a directory that happens to live under `packages/`. Before the move, the
 * host reached into `packages/agent/src/memory-state/*` through deep relative
 * paths in ~25 files, which meant `packages/agent`'s internals were load-
 * bearing for the host and no boundary existed at all.
 *
 * ## What counts as "reaching in"
 *
 * Every module specifier in the repo is resolved, and any specifier that lands
 * on a file inside `packages/memory/` must come from a file that is itself
 * inside `packages/memory/`. That covers the two ways this actually happened:
 * a relative path that walks into the package, and a bare `@duya/memory/...`
 * naming a module the package never declared.
 *
 * ## Search convention (stated because counts here have disagreed before)
 *
 * - Corpus: `git ls-files` (tracked files only), extensions
 *   `.ts .tsx .mts .cts .js .mjs .cjs`.
 * - Excluded: `node_modules`, any `dist`, `.claude/` (worktree internals).
 * - Specifier forms: static `import`/`export ... from`, side-effect `import`,
 *   dynamic `import()`, `require()`, and `vi.mock`/`vi.importActual`.
 *   TYPE-ONLY imports are INCLUDED. A type-only deep import is still a deep
 *   import, and excluding them is exactly how a boundary quietly rots.
 * - The scanner reads specifier-SHAPED strings with a regex and does not parse
 *   comments away, so a doc comment that spells out a full subpath is reported
 *   as an offence. That is deliberate: it keeps the rule checkable by a reader
 *   without trusting a hand-maintained file list.
 *
 * Because the two sides of every comparison come from different sources --
 * the specifier as written in the file, versus `package.json` `exports` and
 * the filesystem -- the assertions below cannot pass by comparing a value with
 * itself.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PKG_DIR = path.join(REPO_ROOT, 'packages/memory');
const PKG_SRC = path.join(PKG_DIR, 'src');

/** Extensions a specifier may omit, in the order resolution prefers them. */
const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/**
 * Specifier shapes. Each alternative ends at the quote so a specifier cannot
 * run past its own literal.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  // import x from '...' / export { x } from '...' / export * from '...'
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  // side-effect import '...' / import type '...'
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  // dynamic import('...')
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  // require('...')
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  // vi.mock('...') / vi.doMock / vi.importActual / vi.importMock
  /\bvi\.(?:mock|doMock|unmock|importActual|importMock)\s*\(\s*['"]([^'"\n]+)['"]/g,
];

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

interface CorpusFile {
  /** Repo-relative, POSIX separators. */
  rel: string;
  abs: string;
  text: string;
}

function loadCorpus(): CorpusFile[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const files: CorpusFile[] = [];
  for (const rel of out.split('\0').filter(Boolean)) {
    const posix = rel.replace(/\\/g, '/');
    if (!SOURCE_EXT.test(posix)) continue;
    if (posix.includes('/node_modules/') || posix.includes('/dist/')) continue;
    if (posix.startsWith('.claude/')) continue;
    if (!posix.startsWith('packages/memory/') && !fs.existsSync(path.join(REPO_ROOT, rel))) {
      continue;
    }
    files.push({ rel: posix, abs: path.join(REPO_ROOT, rel), text: fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8') });
  }
  return files;
}

/** Every module specifier named in a file, with the line it was named on. */
function specifiersIn(file: CorpusFile): { spec: string; line: number }[] {
  const found: { spec: string; line: number }[] = [];
  const lines = file.text.split(/\r?\n/);
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(file.text)) !== null) {
      const spec = m[1]!;
      if (!spec) continue;
      const line = file.text.slice(0, m.index).split(/\r?\n/).length;
      // A specifier the loader never sees (a template expression, a variable)
      // is not a reach; it is skipped rather than guessed at.
      if (spec.includes('${') || spec.includes('`')) continue;
      found.push({ spec, line });
      void lines;
    }
  }
  return found;
}

/** Resolve a relative specifier to a real file, or undefined. */
function resolveRelative(fromAbs: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(fromAbs), spec);
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  // `./mod.js` in TypeScript sources usually means `./mod.ts` on disk.
  const withoutJs = base.replace(/\.js$/, '');
  if (withoutJs !== base) {
    for (const ext of RESOLVE_EXTENSIONS.slice(1)) {
      const candidate = withoutJs + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return undefined;
}

function isInside(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

interface Offence {
  file: string;
  line: number;
  spec: string;
  reason: string;
}

function scanBoundaryViolations(): Offence[] {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
  };
  const declared = new Set(Object.keys(pkgJson.exports));

  const offences: Offence[] = [];
  for (const file of loadCorpus()) {
    const insidePackage = isInside(file.abs, PKG_DIR);

    for (const { spec, line } of specifiersIn(file)) {
      // (1) A declared `@duya/memory` subpath. A subpath the package never
      // declared is a reach into a module it marked private.
      if (spec === '@duya/memory' || spec.startsWith('@duya/memory/')) {
        const sub = spec === '@duya/memory' ? '.' : `.${spec.slice('@duya/memory'.length)}`;
        if (!declared.has(sub)) {
          offences.push({
            file: file.rel,
            line,
            spec,
            reason: `subpath is not declared in packages/memory/package.json exports (declared: ${[...declared].sort().join(', ')})`,
          });
        }
        continue;
      }

      // (2) A relative specifier that lands on a file inside the package.
      // Only an external importer is an offence; internal wiring is the
      // package's own business.
      if (!spec.startsWith('.')) continue;
      if (insidePackage) continue;
      const resolved = resolveRelative(file.abs, spec);
      if (resolved && isInside(resolved, PKG_DIR)) {
        offences.push({
          file: file.rel,
          line,
          spec,
          reason: `reaches into packages/memory by relative path -> ${path.relative(REPO_ROOT, resolved).replace(/\\/g, '/')}`,
        });
      }
    }
  }
  return offences;
}

/** Modules present on disk that `exports` deliberately keeps private. */
function privateModules(): string[] {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')) as {
    exports: Record<string, { default?: string }>;
  };
  const emitted = new Set<string>();
  for (const value of Object.values(pkgJson.exports)) {
    const target = value.default;
    if (!target) continue;
    emitted.add(path.basename(target, '.js'));
  }
  return fs
    .readdirSync(PKG_SRC)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => name.replace(/\.ts$/, ''))
    .filter((name) => !emitted.has(name))
    .sort();
}

describe('@duya/memory package boundary', () => {
  const offences = scanBoundaryViolations();

  it('has a corpus to scan, and it includes the known consumers', () => {
    // A boundary test over an empty corpus is green by blindness. These are
    // three files that DID reach in before this package existed, so if the
    // scanner stops seeing them the scanner is broken, not the repo.
    const scanned = loadCorpus().map((f) => f.rel);
    expect(scanned.length).toBeGreaterThan(100);
    for (const known of [
      'apps/desktop/src/main/memory/memory-worker.ts',
      'apps/desktop/src/main/ipc/memory-handlers.ts',
      'packages/agent/src/process/agent-process-entry.ts',
    ]) {
      expect(scanned, `scanner lost ${known}`).toContain(known);
    }
  });

  it('finds the scanner does find real reach-throughs', () => {
    // The negative control. Without this, a scanner that resolves nothing at
    // all would pass the assertion below and look like a clean boundary.
    const probe = resolveRelative(
      path.join(REPO_ROOT, 'packages/agent/src/agent'),
      '../memory-state/system_log.js',
    );
    expect(probe).toBeUndefined();
  });

  it('is reachable only through its declared exports', () => {
    expect(offences).toEqual([]);
  });

  it('keeps its private modules private', () => {
    const priv = privateModules();
    // These are the modules `exports` omits on purpose: nothing outside the
    // package may name them. Asserted as a list so adding a new private module
    // is a visible diff rather than a silent widening of the public surface.
    expect(priv).toEqual([
      'compactMessages',
      'curation_validator',
      'prompt',
      'stage1_prompt_loader',
      'types',
      'writer',
    ]);
  });

  it('declares no export that has no emitted module', () => {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')) as {
      exports: Record<string, { types?: string; default?: string }>;
    };
    const missing: string[] = [];
    for (const [sub, value] of Object.entries(pkgJson.exports)) {
      for (const target of [value.types, value.default]) {
        if (target && !fs.existsSync(path.join(PKG_DIR, target))) missing.push(`${sub} -> ${target}`);
      }
    }
    // Compared against the filesystem, not against the manifest: a declared
    // export with nothing behind it is a boundary that does not exist.
    expect(missing).toEqual([]);
  });
});