/**
 * scripts/bundle-cli.mjs
 *
 * One-off esbuild bundle for the duya CLI entry, used by the
 * regression tests in packages/agent/tests/cli-control-plane/ to
 * invoke the real CLI without depending on tsx.
 *
 * Plan 99: entry is now `packages/cli/src/index.ts`; output is
 * `packages/cli/bundle/cli.cjs`.
 */

import { build } from 'esbuild';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const outDir = path.join(projectRoot, 'packages', 'cli', 'bundle');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(projectRoot, 'packages', 'cli', 'src', 'index.ts')],
  outfile: path.join(outDir, 'cli.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  // Mark node builtins and known legacy optional deps as external.
  external: [
    'node:*',
    'date-format',
    'better-sqlite3',
    'playwright',
  ],
  banner: {
    js: "var import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
  define: {
    'import.meta.url': 'import_meta_url',
  },
  logLevel: 'info',
});

console.log('Built cli bundle');
