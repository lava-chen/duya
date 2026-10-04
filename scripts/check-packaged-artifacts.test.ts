/**
 * check-packaged-artifacts.test.ts — regression tests for the packaged-artifact gate.
 *
 * The gate's job is to parse build and resolver *source* and notice drift. The
 * parsing is where it can be quietly wrong in the permissive direction: a
 * comment swallowed as a module specifier, a `path.join` candidate lost, a
 * builtin mistaken for an unresolvable dependency. Each test below pins one
 * rule in the direction that fails loudly.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_EXTERNALS,
  BASH_WORKER_ALLOWED_EXTERNALS,
  BASH_WORKER_CONTRACT_PATH,
  BUNDLE_FILE_CONTRACTS,
  CHECKLIST_ARTIFACTS,
  PRIMARY_AGENT_ENTRY,
  REQUIRED_BUNDLE_FORMAT,
  checkBashWorkerSelfContained,
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
  it('finds nothing at all, with no known-defect baseline left to lean on', () => {
    // The gate must be green on master. The bash-worker defect this was
    // written around is fixed and the entry is deleted, so an empty defect
    // list is the honest expectation: if this lists a finding, it is real drift
    // rather than a downgraded one.
    const baseline = JSON.parse(readRepoFile('scripts/packaged-artifact-baseline.json'));
    expect(baseline.defects).toEqual([]);
    expect(runStaticChecks()).toEqual([]);
  });

  it('no longer reports the bash-worker bundle file contract', () => {
    // Previously recorded as BASHWORKER-NOT-BUNDLED: WorkerPool resolved
    // BashTool/BashWorker.js but no build step emitted it. A build step emits
    // it now, so the static contract is satisfied and must stay satisfied.
    const checks = runStaticChecks().map((f) => f.check);
    expect(checks).not.toContain('bundle-file-contract:bash-worker');
  });

  it('declares a contract for every file the agent resolves in the bundle', () => {
    for (const contract of BUNDLE_FILE_CONTRACTS) {
      expect(contract.relativePath).not.toBe('');
      expect(contract.resolvedBy).toMatch(/\.ts$/);
    }
  });
});

describe('bash worker build contract', () => {
  it('resolves the worker path from the contract table, not a re-spelled copy', () => {
    const contract = BUNDLE_FILE_CONTRACTS.find((c) => c.id === 'bash-worker');
    expect(contract).toBeDefined();
    expect(BASH_WORKER_CONTRACT_PATH).toEqual(contract!.relativePath.split('/'));
  });

  it('names a real build script as the producer', () => {
    // The defect was precisely that no producer existed. A contract pointing at
    // a script that is not in the tree would silently re-open it.
    const contract = BUNDLE_FILE_CONTRACTS.find((c) => c.id === 'bash-worker');
    expect(contract!.producer).toBe('scripts/build-agent-bundle.mjs');
    expect(existsSync(path.join(REPO_ROOT, 'scripts', 'build-agent-bundle.mjs'))).toBe(true);
  });

  it('is actually emitted by that script rather than only mentioned in a comment', () => {
    // Static mode proves a producer NAMES the path. This proves the script
    // really builds it, so a commented-out reference cannot pass as a fix.
    const source = readRepoFile('scripts/build-agent-bundle.mjs');
    const entryPoint = 'packages/agent/src/tool/BashTool/BashWorker.ts';
    expect(source).toContain(entryPoint);
    // ...and esbuild is given the real source path, not a literal file copy.
    expect(source).toMatch(/entryPoints:\s*\[\s*'packages\/agent\/src\/tool\/BashTool\/BashWorker\.ts'\s*\]/);
  });

  it('is verified by after-pack.js so a missing copy fails the release', () => {
    // The recorded removal criterion named after-pack.js explicitly: without
    // it, a build that emits the worker but an extraResources rule that stops
    // copying it would still ship broken.
    const afterPack = readRepoFile('scripts/after-pack.js');
    expect(afterPack).toContain("'BashTool', 'BashWorker.js'");
  });

  it('is covered by the extraResources rule that ships the bundle directory', () => {
    // Structural, not a real package: the recursive filter means a new
    // subdirectory of packages/agent/bundle/ is copied with no yml change.
    const builderConfig = readRepoFile('electron-builder.yml');
    expect(builderConfig).toMatch(/from:\s*packages\/agent\/bundle\//);
    expect(builderConfig).toMatch(/to:\s*agent-bundle\//);
  });

  it('allows the worker NO externals, unlike the entry it sits beside', () => {
    // The worker is spawned as its own process, so a require the entry may
    // keep is one the worker cannot resolve. Sharing the allowlist would
    // reintroduce exactly the runtime-resolution failure being prevented.
    expect(BASH_WORKER_ALLOWED_EXTERNALS).toEqual([]);
    expect(ALLOWED_EXTERNALS.length).toBeGreaterThan(0);
  });
});

describe('checkBashWorkerSelfContained', () => {
  it('accepts a worker that requires only Node builtins', () => {
    const worker = 'require("child_process");require("fs/promises");require("node:buffer");';
    expect(checkBashWorkerSelfContained(worker, '/tmp/BashWorker.js')).toEqual([]);
  });

  it('rejects a third-party require that only a dev node_modules would satisfy', () => {
    // The mutation this check exists to catch: the file exists, the gate sees
    // it, and the installed app still dies on the first Bash call.
    const findings = checkBashWorkerSelfContained('require("node-fetch");', '/tmp/BashWorker.js');
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('bash-worker-self-contained');
    expect(findings[0].message).toContain('node-fetch');
  });

  it('rejects an unbundled relative require', () => {
    const findings = checkBashWorkerSelfContained('require("../../utils/duyaRoot.js");', '/tmp/BashWorker.js');
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('relative');
  });

  it('rejects a computed require rather than assuming it is safe', () => {
    const findings = checkBashWorkerSelfContained('require(spec);', '/tmp/BashWorker.js');
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('non-literal');
  });

  it('does not inherit the entry allowlist', () => {
    // better-sqlite3 is legal in the entry and fatal in the worker.
    const findings = checkBashWorkerSelfContained('require("better-sqlite3");', '/tmp/BashWorker.js');
    expect(findings).toHaveLength(1);
  });
});