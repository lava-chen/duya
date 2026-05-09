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
    'playwright',
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

// Build BashWorker.js as CommonJS bundle (separate from main bundle)
// WorkerPool looks for workers relative to its location
const bashToolDestDir = path.join(outdir, 'BashTool');
fs.mkdirSync(bashToolDestDir, { recursive: true });

await build({
  entryPoints: ['packages/agent/src/tool/BashTool/BashWorker.ts'],
  outdir: bashToolDestDir,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  external: [],
  banner: {
    js: importMetaUrlPolyfill,
  },
  define: {
    'import.meta.url': 'import_meta_url',
  },
});

// Rename output to BashWorker.js (esbuild outputs as BashWorker.js by default)
const builtWorkerPath = path.join(bashToolDestDir, 'BashWorker.js');
if (fs.existsSync(builtWorkerPath)) {
  console.log(`[build-agent-bundle] Built BashWorker.js as CommonJS bundle`);
} else {
  console.warn(`[build-agent-bundle] Warning: BashWorker.js was not built at expected path: ${builtWorkerPath}`);
}

const stats = fs.statSync(outfile);
console.log(`[build-agent-bundle] Built ${outfile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`[build-agent-bundle] Created package.json with type: commonjs`);
