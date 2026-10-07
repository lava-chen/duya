import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

const outdir = path.join('packages', 'agent', 'bundle');
const outfile = path.join(outdir, 'agent-process-entry.js');
// The duya CHAT CLI (`duya -t` / `--print` / the REPL), from the same package
// and against the same runtime, as a second entry in THIS directory.
//
// It lives here rather than in a directory of its own for two reasons, both
// measured. First, `outdir` is wiped on line 13, so a chat CLI bundle in a
// sibling directory would be deleted by every later `npm run bundle:agent`.
// Second — and the reason this is a build constraint rather than a style
// choice — every architecture gate under `scripts/architecture/` skips
// directories whose NAME is exactly `bundle` (`boundary-gates.mjs:37`,
// `audit-modules.mjs:27`, `audit-imports.mjs:28-31`). A `bundle-cli/`
// directory is not skipped, so its ~12 MB of generated JavaScript was scanned
// as first-party source and reported as a new `module-dependency` violation.
// `scripts/architecture/**` is not ours to edit, and re-recording the baseline
// to absorb generated output would be a fake green. Emitting into the
// existing `bundle/` directory keeps generated output out of the gate's
// source scan by construction.
//
// Why this entry needs bundling at all, and why the same two facts defeat a
// "make the dist node-loadable" fix, is documented in AGENTS.md under
// "Agent CLI (standalone)".
const chatCliOutfile = path.join(outdir, 'cli-entry.js');
// The BashTool worker is a separate emitted file, not a module of `outfile`.
// Declared once here so the build step and the log below cannot drift onto
// different paths — the same reason the gate reads this path from one place.
const workerOutfile = path.join(outdir, 'BashTool', 'BashWorker.js');

if (fs.existsSync(outdir)) {
  fs.rmSync(outdir, { recursive: true, force: true });
}
fs.mkdirSync(outdir, { recursive: true });

// Polyfill for import.meta.url in CJS format
const importMetaUrlPolyfill = `
// Polyfill for import.meta.url
var import_meta_url = typeof document === 'undefined' ? require('url').pathToFileURL(__filename).href : (document.currentScript && document.currentScript.src || new URL('currentScript', document.baseURI).href);
var import_meta = { url: import_meta_url };
`;

await build({
  entryPoints: ['packages/agent/src/process/agent-process-entry.ts'],
  outfile,
  bundle: true,
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

// The duya CHAT CLI — a THIRD esbuild entry, and the reason `bundle:agent` is
// also how you get a runnable `duya -t` / `--print` / REPL.
//
// Same externals and same polyfill as the worker entry above, deliberately:
// they are the same package and the same runtime, and a chat CLI that resolved
// `better-sqlite3` differently from the worker would be a second answer to one
// question. NOT minified, unlike the other two — this artifact is what a human
// runs and reports a stack trace from, and the agent worker is never read by a
// person.
await build({
  entryPoints: ['packages/agent/src/cli/index.ts'],
  outfile: chatCliOutfile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  external: [
    'better-sqlite3',
    'fsevents',
    'playwright',
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

// ---------------------------------------------------------------------------
// BashTool worker — a SECOND esbuild entry, not a second ordering mechanism.
//
// WorkerPool.createWorker() spawns this file as its own OS process
// (`spawn(runtime, [workerScriptPath], { stdio: [..., 'ipc'] })`), so it cannot
// be inlined into the entry and has to exist as a real file on disk. It is built
// here because this script is the one owner of everything emitted into
// packages/agent/bundle/. The build ORDER stays in scripts/build-packages.mjs:
// the worker is an entry point of @duya/agent, not a workspace package, so adding
// it to that array would mean inventing a package that does not exist.
//
// FORMAT: CJS, matching the entry. WorkerPool spawns this file by path with no
// extension change, so the format is decided by the nearest package.json `type`
// walking up from the file — packages/agent/bundle/package.json, which the
// entry's build writes as `commonjs` above. No second marker is needed in
// BashTool/; adding one would be redundant.
//
// WHY `external: []` AND NOT THE ENTRY'S ALLOWLIST
//
// A spawned worker is a separate program, not a module inside the bundle.
// Nothing hands it the entry's resolution environment: it is loaded by path,
// with no NODE_PATH, no execArgv, and no node_modules of its own. In a packaged
// app it lives at resources/agent-bundle/BashTool/BashWorker.js, where the only
// node_modules is the one after-pack.js copies to satisfy the ENTRY's
// externals — reusing that allowlist here would let esbuild emit a
// `require(...)` that nothing resolves at runtime, which is exactly the failure
// this build exists to prevent.
//
// BashWorker's transitive closure is Node builtins only (child_process, util,
// fs, fs/promises, path, os, node:buffer via utils/duyaRoot.ts, BashTool/
// constants.ts and utils/shell/providers.ts), so an empty externals list inlines
// everything and produces a genuinely self-contained file. Keep it empty;
// check-packaged-artifacts.mjs fails the build if that ever stops being true.
await build({
  entryPoints: ['packages/agent/src/tool/BashTool/BashWorker.ts'],
  outfile: workerOutfile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: true,
  external: [],
});

// Create a package.json to force CommonJS mode for the bundle
const packageJson = {
  name: '@duya/agent-bundle',
  version: '0.1.0',
  private: true,
  type: 'commonjs',
  description: 'Agent process bundle - CommonJS format for Node.js subprocess'
};

fs.writeFileSync(
  path.join(outdir, 'package.json'),
  JSON.stringify(packageJson, null, 2)
);

// Copy the prompt .hbs asset tree next to the bundle. HbsPromptSystem
// resolves `./assets` relative to the bundle file, and electron-builder
// ships the whole `packages/agent/bundle/` directory as
// `resources/agent-bundle/`, so this copy serves both dev and packaged runs.
const promptsAssetsSrc = path.join('packages', 'agent', 'src', 'prompts', 'assets');
const promptsAssetsOut = path.join(outdir, 'assets');
fs.cpSync(promptsAssetsSrc, promptsAssetsOut, { recursive: true });
console.log(`[build-agent-bundle] Copied prompt assets to ${promptsAssetsOut}`);

// Build standalone CLI bundle (duya shell wrapper target).
// Plan 99: the CLI bundle is now built separately by
// `scripts/build-cli-bundle.mjs` into `packages/cli/bundle/cli.cjs`.
// The dev fallback path (`electron/services/cliInstallAuto.ts:98`)
// and the electron-builder extraResources copy both look for
// `packages/cli/bundle/cli.cjs` (production: `resources/cli-bundle/cli.cjs`).
// See `scripts/build-cli-bundle.mjs`.
// That is the DESKTOP CONTROL PLANE. The chat CLI built above
// (`bundle/cli-entry.js`) is a different program with different commands —
// `-t`, `--print`, the REPL — and it is not what that path looks for.

const stats = fs.statSync(outfile);
console.log(`[build-agent-bundle] Built ${outfile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
const workerStats = fs.statSync(workerOutfile);
console.log(`[build-agent-bundle] Built ${workerOutfile} (${(workerStats.size / 1024).toFixed(2)} KB)`);
const chatCliStats = fs.statSync(chatCliOutfile);
console.log(`[build-agent-bundle] Built ${chatCliOutfile} (${(chatCliStats.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`[build-agent-bundle] Run the chat CLI: node ${chatCliOutfile} --help`);
console.log(`[build-agent-bundle] Created package.json with type: commonjs`);
