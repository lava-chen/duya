/**
 * scripts/bundle-cli-server.mjs
 *
 * One-off esbuild bundle for the CLI API server plus its database
 * initialization, used by the regression tests in
 * packages/agent/tests/cli-control-plane/ to spawn a headless Electron
 * entry without depending on the full dist-electron/main.js bundle.
 *
 * The output is a single CJS file that exports startCliApiServer and
 * initDatabase (the latter is the bundled initDatabaseFromBoot
 * function from electron/db/connection.ts). The test entry calls
 * initDatabase() before startCliApiServer() to wire the per-test
 * schema into the same connection singleton the queries use.
 *
 * This avoids the closure-over-`var db = null` problem that
 * pre-bundling just cli-api-server.ts caused: with initDatabase in
 * the same bundle, the test entry can call it before start, and
 * the queries' getDatabase() returns the resulting singleton.
 */

import { build } from 'esbuild';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const outDir = path.join(projectRoot, 'packages', 'agent', 'bundle');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'cli-api-server.cjs');

// Use a small entry that re-exports both functions from the source.
const tmpEntry = path.join(outDir, '.cli-server-entry.ts');
const fs = await import('node:fs/promises');
await fs.writeFile(
  tmpEntry,
  `export { startCliApiServer } from '../../../electron/cli/cli-api-server';
export { initDatabaseFromBoot as initDatabase } from '../../../electron/db/connection';
`,
  'utf-8',
);

await build({
  entryPoints: [tmpEntry],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  external: [
    'electron',
    'better-sqlite3',
    'playwright',
    'chromium-bidi/lib/cjs/bidiMapper/BidiMapper',
    'chromium-bidi/lib/cjs/cdp/CdpConnection',
  ],
  banner: {
    js: "var import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
  define: {
    'import.meta.url': 'import_meta_url',
  },
  logLevel: 'info',
});

await fs.unlink(tmpEntry);

console.log(`Built ${outFile}`);


