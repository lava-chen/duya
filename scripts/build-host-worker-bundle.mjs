import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { workspacePublicSources } from './workspace-public-sources.mjs';

const outdir = path.join('packages', 'host', 'bundle');
const outfile = path.join(outdir, 'worker-entry.js');
// The BashTool worker is a separate emitted file, not a module of `outfile`.
// Declared once here so the build step and the log below cannot drift onto
// different paths — the same reason the gate reads this path from one place.
const workerOutfile = path.join(outdir, 'BashTool', 'BashWorker.js');

if (fs.existsSync(outdir)) {
  const expected = path.resolve('packages', 'host', 'bundle');
  if (fs.realpathSync(outdir) !== expected || fs.lstatSync(outdir).isSymbolicLink()) {
    throw new Error('Refusing to clean a redirected worker bundle directory');
  }
  fs.rmSync(outdir, { recursive: true, force: true });
}
fs.mkdirSync(outdir, { recursive: true });

// Polyfill for import.meta.url in CJS format
const importMetaUrlPolyfill = `
// Polyfill for import.meta.url
var import_meta_url = typeof document === 'undefined' ? require('url').pathToFileURL(__filename).href : (document.currentScript && document.currentScript.src || new URL('currentScript', document.baseURI).href);
var import_meta = { url: import_meta_url };
`;

const mainBundle = await build({
  entryPoints: ['packages/cli/src/agent-worker-entry.ts'],
  outfile,
  bundle: true,
  plugins: [workspacePublicSources()],
  metafile: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: true,
  external: [
    'better-sqlite3',
    'fsevents',
    'playwright',
    // dwf/runtime.ts does a dynamic import('esbuild') at runtime to transpile
    // workflow scripts. esbuild's JS API resolves its platform binary via a
    // relative path, so bundling it breaks — keep it external (loadEsbuild
    // already degrades gracefully to DwfCompileError when require fails).
    'esbuild',
    'chromium-bidi/lib/cjs/bidiMapper/BidiMapper',
    'chromium-bidi/lib/cjs/cdp/CdpConnection',
  ],
  banner: {
    js: importMetaUrlPolyfill,
  },
  define: {
    'import.meta.url': 'import_meta_url',
  },
});

const legacyInputs = Object.keys(mainBundle.metafile.inputs).filter((input) =>
  /(?:^|\/)packages\/agent\/(?:src|dist)\//.test(input.replaceAll('\\', '/')),
);
if (legacyInputs.length > 0) {
  throw new Error(`Worker bundle still includes retired Agent source: ${legacyInputs.join(', ')}`);
}
fs.writeFileSync(path.join(outdir, 'worker-metafile.json'), JSON.stringify(mainBundle.metafile, null, 2));

// ---------------------------------------------------------------------------
// BashTool worker — a SECOND esbuild entry, not a second ordering mechanism.
//
// WorkerPool.createWorker() spawns this file as its own OS process
// (`spawn(runtime, [workerScriptPath], { stdio: [..., 'ipc'] })`), so it cannot
// be inlined into the entry and has to exist as a real file on disk. It is built
// here because this script is the one owner of everything emitted into
// packages/host/bundle/. The build ORDER stays in scripts/build-packages.mjs:
// the shell child is a Host executable artifact, not a separate workspace package.
//
// FORMAT: CJS, matching the entry. WorkerPool spawns this file by path with no
// extension change, so the format is decided by the nearest package.json `type`
// walking up from the file — packages/host/bundle/package.json, which the
// entry's build writes as `commonjs` above. No second marker is needed in
// BashTool/; adding one would be redundant.
//
// WHY `external: []` AND NOT THE ENTRY'S ALLOWLIST
//
// A spawned worker is a separate program, not a module inside the bundle.
// Nothing hands it the entry's resolution environment: it is loaded by path,
// with no NODE_PATH, no execArgv, and no node_modules of its own. In a packaged
// app it lives at resources/harness-bundle/BashTool/BashWorker.js, where the only
// node_modules is the one after-pack.js copies to satisfy the ENTRY's
// externals — reusing that allowlist here would let esbuild emit a
// `require(...)` that nothing resolves at runtime, which is exactly the failure
// this build exists to prevent.
//
// The workspacePublicSources plugin keeps this entry dist-independent, same as
// the main one above: without it, `@duya/capabilities/...` and `@duya/data/...`
// resolve through node_modules into emitted `dist/*.js`, which is why
// `bundle:agent` historically had to run after a full `build:packages`. With
// it, both entries build from TypeScript source and no package build is a
// precondition.
//
// BashWorker's transitive closure is Node builtins only (child_process, util,
// fs, fs/promises, path, os, node:buffer via utils/duyaRoot.ts, BashTool/
// constants.ts and utils/shell/providers.ts), so an empty externals list inlines
// everything and produces a genuinely self-contained file. Keep it empty;
// check-packaged-artifacts.mjs fails the build if that ever stops being true.
await build({
  entryPoints: ['packages/host/src/managed-shell/BashWorker.ts'],
  outfile: workerOutfile,
  bundle: true,
  plugins: [workspacePublicSources()],
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: true,
  external: [],
});

// Create a package.json to force CommonJS mode for the bundle
const packageJson = {
  name: '@duya/host-worker-bundle',
  version: '0.1.0',
  private: true,
  type: 'commonjs',
  description: 'Host worker bundle - CommonJS format for Node.js subprocess'
};

fs.writeFileSync(
  path.join(outdir, 'package.json'),
  JSON.stringify(packageJson, null, 2)
);

// Copy the prompt .hbs asset tree next to the bundle. HbsPromptSystem
// resolves `./assets` relative to the bundle file, and electron-builder
// ships the whole `packages/host/bundle/` directory as
// `resources/harness-bundle/`, so this copy serves both dev and packaged runs.
const promptsAssetsSrc = path.join('packages', 'host', 'src', 'worker-prompts', 'assets');
const promptsAssetsOut = path.join(outdir, 'assets');
fs.cpSync(promptsAssetsSrc, promptsAssetsOut, { recursive: true });
console.log(`[build-host-worker-bundle] Copied prompt assets to ${promptsAssetsOut}`);

// Host owns bundled skills; the worker carries them beside its executable.
const skillsAssetsSrc = path.join('packages', 'host', 'skills');
fs.cpSync(skillsAssetsSrc, path.join(outdir, 'skills'), { recursive: true });

const stats = fs.statSync(outfile);
console.log(`[build-host-worker-bundle] Built ${outfile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
const workerStats = fs.statSync(workerOutfile);
console.log(`[build-host-worker-bundle] Built ${workerOutfile} (${(workerStats.size / 1024).toFixed(2)} KB)`);
console.log(`[build-host-worker-bundle] Created package.json with type: commonjs`);
