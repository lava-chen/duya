import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

const outdir = path.join('packages', 'agent', 'bundle');
const outfile = path.join(outdir, 'agent-process-entry.js');

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

const stats = fs.statSync(outfile);
console.log(`[build-agent-bundle] Built ${outfile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`[build-agent-bundle] Created package.json with type: commonjs`);
