/**
 * scripts/build-cli-bundle.mjs
 *
 * Plan 99: the desktop control plane (`@duya/cli`) is bundled
 * separately from the agent process. Output:
 *   packages/cli/bundle/cli.cjs
 *
 * The Electron main process and the dev auto-install both look for
 * this path:
 *   - Production: resources/cli-bundle/cli.cjs (set via
 *     electron-builder.yml extraResources)
 *   - Dev:        packages/cli/bundle/cli.cjs
 *
 * Run via `npm run build:cli-bundle` (added to root package.json).
 */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const outdir = path.join('packages', 'cli', 'bundle');
const outfile = path.join(outdir, 'cli.cjs');

if (fs.existsSync(outdir)) {
  fs.rmSync(outdir, { recursive: true, force: true });
}
fs.mkdirSync(outdir, { recursive: true });

// Polyfill for import.meta.url in CJS format (mirrors the agent
// bundle's pattern). Both `cli.cjs` and the agent's CJS bundles
// need this so `import.meta.url` resolves correctly inside
// esbuild's CJS output.
const importMetaUrlPolyfill = `
var import_meta_url = typeof document === 'undefined' ? require('url').pathToFileURL(__filename).href : (document.currentScript && document.currentScript.src || new URL('currentScript', document.baseURI).href);
var import_meta = { url: import_meta_url };
`;

await build({
  entryPoints: ['packages/cli/src/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  external: [
    'node:*',
    'date-format',
    'better-sqlite3',
    'playwright',
  ],
  banner: {
    js: importMetaUrlPolyfill,
  },
  define: {
    'import.meta.url': 'import_meta_url',
  },
});

const cliStats = fs.statSync(outfile);
console.log(`[build-cli-bundle] Built ${outfile} (${(cliStats.size / 1024 / 1024).toFixed(2)} MB)`);
