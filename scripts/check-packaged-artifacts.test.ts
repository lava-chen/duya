/**
 * check-packaged-artifacts.test.ts — regression tests for the packaged-artifact gate.
 *
 * The gate's job is to parse build and resolver *source* and notice drift. The
 * parsing is where it can be quietly wrong in the permissive direction: a
 * comment swallowed as a module specifier, a `path.join` candidate lost, a
 * builtin mistaken for an unresolvable dependency. Each test below pins one
 * rule in the direction that fails loudly.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_EXTERNALS,
  BUNDLE_FILE_CONTRACTS,
  CHECKLIST_ARTIFACTS,
  PRIMARY_AGENT_ENTRY,
  REQUIRED_BUNDLE_FORMAT,
  classifyRequires,
  extractExternals,
  extractFormat,
  extractJoinedPathLiterals,
  resolveReleaseResourcesDir,
  runStaticChecks,
} from './check-packaged-artifacts.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

describe('extractExternals', () => {
  it('reads the real esbuild external list', () => {
    const externals = extractExternals(readRepoFile('scripts/build-agent-bundle.mjs'));
    // Compared as a set: the gate asks "is the allowlist still the declared
    // set", not "is the source order stable". Re-ordering the array is a
    // no-op for resolution and must not redden the gate.
    expect([...externals].sort()).toEqual([...ALLOWED_EXTERNALS].sort());
  });

  it('ignores prose inside line comments', () => {
    // Regression risk: the externals are documented in comments that name
    // other packages. A comment read as a specifier would either inflate the
    // allowlist or invent a phantom third-party require.
    const source = `await build({
      external: [
        'better-sqlite3',
        // esbuild's JS API resolves its platform binary, so keep it out
        'playwright',
      ],
    });`;
    expect(extractExternals(source)).toEqual(['better-sqlite3', 'playwright']);
  });

  it('ignores block comments', () => {
    const source = `external: [
      /* 'not-a-dep', */
      'esbuild',
    ]`;
    expect(extractExternals(source)).toEqual(['esbuild']);
  });

  it('does not let a comment containing a bracket close the array early', () => {
    // A naive indexOf(']') would truncate here and silently drop externals.
    const source = `external: [
      'a', // closes ] here
      'b',
    ]`;
    expect(extractExternals(source)).toEqual(['a', 'b']);
  });

  it('throws rather than returning an empty list when the key is gone', () => {
    // An empty allowlist would make every external look allowed, so a
    // missing key must be an error, not an empty array.
    expect(() => extractExternals('await build({ bundle: true });')).toThrow(/external:/);
  });
});

describe('extractFormat', () => {
  it('reads the real bundle format', () => {
    expect(extractFormat(readRepoFile('scripts/build-agent-bundle.mjs')))
      .toBe(REQUIRED_BUNDLE_FORMAT);
  });

  it('returns null when unset instead of guessing', () => {
    expect(extractFormat('await build({ bundle: true })')).toBeNull();
  });

  it('is not fooled by the word format in a comment', () => {
    const source = `// the format: matters here
      await build({ format: 'esm' });`;
    expect(extractFormat(source)).toBe('esm');
  });
});

describe('extractJoinedPathLiterals', () => {
  it('reads the packaged candidates of the real resolver in order', () => {
    const source = readRepoFile(
      'apps/desktop/src/main/agents/process-pool/process-manager.ts',
    );
    const candidates = extractJoinedPathLiterals(source, 'getAgentProcessPath');
    expect(candidates[0]).toBe(PRIMARY_AGENT_ENTRY);
  });

  it('keeps the debug fallbacks after the production path', () => {
    // If a fallback were promoted above the bundle, the release would stop
    // exercising the artifact it ships. The first candidate is the contract.
    const source = readRepoFile(
      'apps/desktop/src/main/agents/process-pool/process-manager.ts',
    );
    const candidates = extractJoinedPathLiterals(source, 'getAgentProcessPath');
    expect(candidates.indexOf(PRIMARY_AGENT_ENTRY)).toBeLessThan(
      candidates.indexOf('agent/process/agent-process-entry.js'),
    );
  });

  it('recovers the bash worker path as a single relative path', () => {
    const source = readRepoFile('packages/agent/src/tool/WorkerPool.ts');
    const candidates = extractJoinedPathLiterals(source, 'resolveBashWorkerPath');
    expect(candidates).toContain('BashTool/BashWorker.js');
  });

  it('drops a join that is only a base directory', () => {
    const source = `function f() {
      const a = path.join(base);
      return a;
    }`;
    expect(extractJoinedPathLiterals(source, 'f')).toEqual([]);
  });

  it('throws for an unknown function rather than returning nothing', () => {
    expect(() => extractJoinedPathLiterals('const x = 1;', 'missingFn')).toThrow(/missingFn/);
  });
});

describe('classifyRequires', () => {
  const externals = ALLOWED_EXTERNALS;

  it('treats Node builtins as always resolvable', () => {
    const result = classifyRequires('require("fs");require("node:path");require("crypto");', externals);
    expect(result.builtins).toEqual(['fs', 'node:path', 'crypto']);
    expect(result.thirdParty).toEqual([]);
  });

  it('accepts a declared external and its subpaths', () => {
    const result = classifyRequires(
      'require("better-sqlite3");require("better-sqlite3/build/Release/better_sqlite3.node");'
      + 'require("chromium-bidi/lib/cjs/cdp/CdpConnection");',
      externals,
    );
    expect(result.thirdParty).toEqual([]);
    expect(result.externals).toContain('better-sqlite3');
    expect(result.externals).toContain('better-sqlite3/build/Release/better_sqlite3.node');
  });

  it('flags a bare specifier that is neither builtin nor external', () => {
    // This is the packaged-smoke failure: a dependency that was never inlined
    // and never copied, so it resolves only through a node_modules the
    // release does not ship.
    const result = classifyRequires('require("node-fetch");', externals);
    expect(result.thirdParty).toEqual(['node-fetch']);
  });

  it('does not let a declared external prefix smuggle a sibling through', () => {
    // 'playwright-evil' is not 'playwright'.
    const result = classifyRequires('require("playwright-evil");', externals);
    expect(result.thirdParty).toEqual(['playwright-evil']);
  });

  it('flags a relative require that esbuild should have inlined', () => {
    const result = classifyRequires('require("./tool/WorkerPool.js");', externals);
    expect(result.relative).toEqual(['./tool/WorkerPool.js']);
  });

  it('counts a non-literal require as dynamic instead of guessing', () => {
    const result = classifyRequires('const r = require(name);', externals);
    expect(result.dynamic).toBe(1);
    expect(result.thirdParty).toEqual([]);
  });

  it('does not report a require that only appears inside a string literal', () => {
    // Regression, found against the real 5 MB bundle. ajv's runtime keyword
    // modules set `code` to a STRING that ajv later pastes into a code
    // generator: `equal.code = 'require("ajv/dist/runtime/equal").default'`.
    // Those specifiers are real text in the bundle and are NOT requires. A
    // regex scan reported them as unresolvable dependencies and accused a
    // healthy build of shipping five missing modules.
    const bundle = `
      var r = {};
      r.equal = { code: 'require("ajv/dist/runtime/equal").default' };
      r.uri = { code: 'require("ajv/dist/runtime/uri").default' };
      r.forms = { code: String.raw\`require("ajv-formats/dist/formats").fullFormats\` };
      var log = "// require(\\"not-a-dep\\")";
      /* require("also-not-a-dep") */
      require("better-sqlite3");
    `;
    const result = classifyRequires(bundle, externals);
    expect(result.thirdParty).toEqual([]);
    expect(result.relative).toEqual([]);
    expect(result.externals).toEqual(['better-sqlite3']);
  });

  it('still finds a real require that sits next to string decoys', () => {
    const bundle = `
      var decoy = 'require("ajv/dist/runtime/equal").default';
      var alsoDecoy = "// require('nope')";
      require("node-fetch");
    `;
    expect(classifyRequires(bundle, externals).thirdParty).toEqual(['node-fetch']);
  });

  it('handles an escaped quote inside a real specifier', () => {
    // The bundle text is require("a\"b"); — an escaped quote must not be read
    // as the end of the specifier.
    expect(classifyRequires('require("a\\"b");', externals).thirdParty).toEqual(['a"b']);
  });

  it('handles an escaped backslash inside a real specifier', () => {
    // The bundle text is require("a\\b"); — the backslash is data, not an
    // escape introducer, and must not swallow the next character.
    expect(classifyRequires('require("a\\\\b");', externals).thirdParty).toEqual(['a\\b']);
  });

  it('sees esbuild __require shims as the same resolution question', () => {
    const result = classifyRequires('__require("node-fetch");', externals);
    expect(result.thirdParty).toEqual(['node-fetch']);
  });

  it('does not double-count a require inside a longer identifier', () => {
    const result = classifyRequires('prerequire("x");myrequire("y");', externals);
    expect(result.dynamic).toBe(0);
    expect(result.thirdParty).toEqual([]);
  });

  it('de-duplicates repeated requires so the report stays readable', () => {
    const result = classifyRequires('require("node-fetch");require("node-fetch");', externals);
    expect(result.thirdParty).toEqual(['node-fetch']);
  });
});

describe('resolveReleaseResourcesDir', () => {
  it('maps each platform to its documented resources directory', () => {
    const base = path.join('C:', 'repo', 'release');
    expect(resolveReleaseResourcesDir({ platform: 'win32', releaseDir: base }))
      .toBe(path.join(base, 'win-unpacked', 'resources'));
    expect(resolveReleaseResourcesDir({ platform: 'darwin', arch: 'arm64', releaseDir: base }))
      .toBe(path.join(base, 'mac-arm64', 'DUYA.app', 'Contents', 'Resources'));
    expect(resolveReleaseResourcesDir({ platform: 'linux', releaseDir: base }))
      .toBe(path.join(base, 'linux-unpacked', 'resources'));
  });
});

describe('checklist artifacts', () => {
  it('covers exactly the three paths AGENTS.md names', () => {
    expect(CHECKLIST_ARTIFACTS.map((a) => a.rel)).toEqual([
      'agent-bundle/agent-process-entry.js',
      'agent-bundle/BashTool/BashWorker.js',
      'better-sqlite3/build/Release/better_sqlite3.node',
    ]);
  });

  it('names the agent bundle as the primary production entry', () => {
    // The checklist path and the resolver's first candidate must be the same
    // string, so a rename on either side fails the gate instead of quietly
    // checking a path nothing ships.
    expect(CHECKLIST_ARTIFACTS[0]!.rel).toBe(PRIMARY_AGENT_ENTRY);
    const managerSource = readRepoFile(
      'apps/desktop/src/main/agents/process-pool/process-manager.ts',
    );
    expect(managerSource).toContain("'agent-bundle', 'agent-process-entry.js'");
  });
});

describe('runStaticChecks against the real tree', () => {
  it('finds no finding outside the known-defect baseline', () => {
    // The gate must be green on master apart from the one recorded defect.
    // If this starts listing a second finding, that finding is real drift.
    const baseline = JSON.parse(readRepoFile('scripts/packaged-artifact-baseline.json'));
    const known = new Set<string>(baseline.defects.map((d: { check: string }) => d.check));
    const fresh = runStaticChecks().filter((f) => !known.has(f.check));
    expect(fresh).toEqual([]);
  });

  it('surfaces the open bash-worker defect rather than passing it', () => {
    const checks = runStaticChecks().map((f) => f.check);
    expect(checks).toContain('bundle-file-contract:bash-worker');
  });

  it('declares a contract for every file the agent resolves in the bundle', () => {
    for (const contract of BUNDLE_FILE_CONTRACTS) {
      expect(contract.relativePath).not.toBe('');
      expect(contract.resolvedBy).toMatch(/\.ts$/);
    }
  });
});
