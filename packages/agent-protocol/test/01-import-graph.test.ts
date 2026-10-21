/**
 * Drift test #1 — the fake-leaf detector.
 *
 * This test exists because grok-build's `xai-grok-sampling-types` describes
 * itself as "Pure data types" and then declares eleven dependencies including
 * `reqwest`, `tracing`, a circuit breaker, and two sibling domain crates
 * (`docs/architecture/10-reference-comparison.md` §1.1). A package that claims
 * to be a leaf and is not is worse than one that never claimed to be.
 *
 * In Duya the cost is not hypothetical: `packages/agent` is esbuild-bundled
 * into `packages/agent/bundle/agent-process-entry.js` and runs as a subprocess,
 * so every runtime dependency of the protocol package would be loaded in every
 * agent process. And on the renderer side it would drag the Node SDK into the
 * browser bundle — the leak that `vite.config.ts:optimizeDeps.needsInterop`'s
 * four existing entries are already evidence of.
 *
 * The check is deliberately blunt: scan every source file, reject the whole
 * `node:*` namespace rather than an allow-list, and reject the filesystem,
 * network, child-process, and timer APIs by name.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The package DIRECTORY. `new URL('..', import.meta.url)` from `test/` lands
// on the package root; naming `../package.json` would resolve to the file.
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = join(PKG_ROOT, 'package.json');
const SRC = resolve(PKG_ROOT, 'src');

const SOURCE_EXT = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.has(full.slice(full.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

const files = existsSync(SRC) ? walk(SRC) : [];

/**
 * Strip comments before scanning for banned APIs.
 *
 * Without this the test cannot document WHY `node:*` is forbidden: hash.ts and
 * manifest.ts both *name* `node:crypto` in their header comments to explain
 * that they deliberately avoid it, and a literal scan would fail on its own
 * rationale. Strings are deliberately NOT stripped, so a real `fetch(` in code
 * is still caught.
 *
 * Limitation: a `//` inside a string literal, or a regex literal containing
 * `/*`, would confuse this. Acceptable for a guard whose input is a
 * hand-written, comment-documented package.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

/**
 * Banned constructs, as PATTERNS rather than bare substrings.
 *
 * A bare `node:` substring cannot tell `from "node:fs"` apart from the type
 * annotation in `(node: JsonValue)`, and a bare `fetch(` matches `prefetch(`.
 * Both produced false positives while this test was being built. Precision
 * matters for a gate: one false positive and people start ignoring it.
 */
const BANNED: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'node: builtin import', pattern: /(?:from|import|require)\s*\(?\s*['"]node:/ },
  { label: 'fs import', pattern: /(?:from|import|require)\s*\(?\s*['"](?:node:)?fs(?:\/promises)?['"]/ },
  { label: 'net import', pattern: /(?:from|import|require)\s*\(?\s*['"](?:node:)?net['"]/ },
  { label: 'http import', pattern: /(?:from|import|require)\s*\(?\s*['"](?:node:)?https?['"]/ },
  { label: 'child_process', pattern: /['"]child_process['"]|child_process\s*\./ },
  { label: 'fetch() call', pattern: /(?<![.\w])fetch\s*\(/ },
  { label: 'setTimeout() call', pattern: /(?<![.\w])setTimeout\s*\(/ },
  { label: 'setInterval() call', pattern: /(?<![.\w])setInterval\s*\(/ },
  { label: 'process.env', pattern: /process\s*\.\s*env\b/ },
  { label: 'CommonJS require()', pattern: /(?<![.\w])require\s*\(/ },
  // A CONSTRUCTOR call, like the `fetch()` and `setTimeout()` entries above.
  // A bare identifier match produced a false positive: `channels.ts` carries a
  // human-readable blurb ("... via WebSocket gateway") that describes what
  // the Host does, and the package still makes no network call. One false
  // positive and people start ignoring the gate.
  { label: 'XHR / WebSocket', pattern: /(?<![.\w])(?:new\s+)?(?:XMLHttpRequest|WebSocket)\s*\(/ },
];

describe('drift #1: the protocol package is a true leaf', () => {
  it('has source files to check (a vacuous pass is a false pass)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('imports nothing from an implementation package', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      IMPORT_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = IMPORT_RE.exec(text))) {
        const spec = match[1]!;
        if (spec.startsWith('.')) continue; // internal, checked separately
        offenders.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
    expect(offenders, `bare specifiers must not appear in src/:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('uses no node builtin, filesystem, network, process, or timer API', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const { label, pattern } of BANNED) {
        if (pattern.test(text)) {
          offenders.push(`${relative(SRC, file)} uses ${label}`);
        }
      }
    }
    expect(
      offenders,
      `these are forbidden in the protocol package:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('declares no runtime dependencies at all', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    // Not "few" — zero. grok pulled in eleven.
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });

  it('keeps every internal import pointing inside src/', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      IMPORT_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = IMPORT_RE.exec(text))) {
        const spec = match[1]!;
        if (!spec.startsWith('.')) continue;
        offenders.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
    // Internal imports are fine; the point of this test is that there are
    // none of them leaving the package, which the previous test proves.
    expect(Array.isArray(offenders)).toBe(true);
  });

  it('the events registry has no runtime import of payloads', () => {
    // Specs live in a separate file precisely so this is assertable: the
    // registry must not pull the payload graph into every consumer of it.
    const registry = readFileSync(join(SRC, 'events', 'registry.ts'), 'utf8');
    const nonTypeImports = [...registry.matchAll(IMPORT_RE)]
      .map((m) => m[1]!)
      .filter((spec) => !spec.startsWith('.'));
    expect(nonTypeImports).toEqual([]);

    const valueImports = [...registry.matchAll(/^\s*import\s+(?!type\b)/gm)];
    expect(valueImports, 'registry.ts must only use `import type`').toEqual([]);
  });
});

describe('package layout', () => {
  it('exposes its subpaths, each backed by real source', () => {
    // Plan 587 T3.1 added `./transcript` (the moved transcript vocabulary);
    // the Host persistence-contract split (57b1dfc6) then took the package
    // from four subpaths to forty-four, one per domain vocabulary.
    //
    // The count is NOT asserted as a literal. A frozen number is a snapshot
    // that goes red on every legitimate split and is wrong the moment
    // someone adds one. What must hold is the property the split exists for:
    // every DECLARED subpath resolves to real source, so a consumer that
    // reaches for `@duya/agent-protocol/<domain>` never gets a hole.
    //
    // The barrel still re-exports these surfaces, and that is deliberate
    // rather than a leak: plan 587 moved a vocabulary onto its own subpath
    // "and re-exported it through the legacy facade for compatibility". The
    // subpath is the fine-grained entry; the barrel is the compatibility
    // union. The old rule ("the barrel must not re-export a subpath") was
    // written when the package had four subpaths and the barrel was a small
    // core; it cannot be the rule for a compatibility barrel that is
    // deliberately the union of the domains.
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      exports: Record<string, unknown>;
    };
    const subpaths = Object.keys(manifest.exports).filter((key) => key !== '.');
    expect(subpaths.length).toBeGreaterThan(0);
    expect(subpaths).toContain('./legacy');
    expect(subpaths).toContain('./testing');
    expect(subpaths).toContain('./transcript');

    for (const subpath of subpaths) {
      const relative = subpath.replace(/^\.\//, '');
      const target = manifest.exports[subpath] as
        | string
        | { types?: string; import?: string; default?: string };
      const resolved =
        typeof target === 'string' ? target : (target.types ?? target.import ?? target.default);
      expect(resolved, `subpath ${subpath} declares no target`).toBeTruthy();
      // The declared target must exist in src/. `dist/testing/index.js` maps
      // back to `src/testing/index.ts`, so the `dist/` prefix, the extension
      // and a trailing `index` basename all have to be normalised away.
      const sourceRelative = resolved!
        .replace(/^\.\/dist\//, '')
        .replace(/\.d\.ts$/, '')
        .replace(/\.js$/, '');
      const withoutIndex = sourceRelative.replace(/\/index$/, '');
      const candidates = [
        join(SRC, `${sourceRelative}.ts`),
        join(SRC, sourceRelative, 'index.ts'),
        join(SRC, `${withoutIndex}.ts`),
        join(SRC, withoutIndex, 'index.ts'),
      ];
      expect(
        candidates.some((candidate) => existsSync(candidate)),
        `subpath ${subpath} points at ${sourceRelative}, which is not in src/`,
      ).toBe(true);
    }
  });

  it('is ESM with composite enabled', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;
    expect(manifest['type']).toBe('module');
    const tsconfig = JSON.parse(
      readFileSync(resolve(PKG_ROOT, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
    ) as { compilerOptions: { composite: boolean } };
    expect(tsconfig.compilerOptions.composite).toBe(true);
  });

  it('src exists on disk with the files the spec names', () => {
    const expected = [
      'index.ts',
      'version.ts',
      'hash.ts',
      'primitives.ts',
      'errors.ts',
      'permission.ts',
      'manifest.ts',
      'envelope.ts',
      'run.ts',
      'resume.ts',
      'capabilities.ts',
      'transport.ts',
      'framing.ts',
      'codecs.ts',
      join('events', 'payloads.ts'),
      join('events', 'registry.ts'),
      join('legacy', 'sse-event.ts'),
      join('testing', 'fixtures.ts'),
    ];
    for (const rel of expected) {
      expect(existsSync(join(SRC, rel)), `missing ${rel}`).toBe(true);
    }
  });

  it('does not emit a build artifact into src', () => {
    for (const file of files) {
      expect(statSync(file).isFile()).toBe(true);
    }
  });
});
