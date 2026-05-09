import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

const outdir = path.join('packages', 'gateway', 'bundle');
const outfile = path.join(outdir, 'gateway-process-entry.js');

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
  entryPoints: ['packages/gateway/src/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: true,
  external: [],
  banner: {
    js: importMetaUrlPolyfill,
  },
  define: {
    'import.meta.url': 'import_meta_url',
  },
});

// Create a package.json to force CommonJS mode for the bundle
const packageJson = {
  name: '@duya/gateway-bundle',
  version: '0.1.0',
  private: true,
  type: 'commonjs',
  description: 'Gateway process bundle - CommonJS format for Node.js subprocess'
};

fs.writeFileSync(
  path.join(outdir, 'package.json'),
  JSON.stringify(packageJson, null, 2)
);

const stats = fs.statSync(outfile);
console.log(`[build-gateway-bundle] Built ${outfile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`[build-gateway-bundle] Created package.json with type: commonjs`);
