/**
 * scripts/build-web-server-bundle.mjs
 *
 * Output:
 *   apps/web/dist/server/main.js
 *
 * ## Why the Web server is BUNDLED and not `tsc`-emitted
 *
 * The Web BFF is a plain Node ESM program. It reaches the Host over HTTP, and
 * it reads the Host's runtime descriptor — nothing more. But a `tsc`-emitted
 * `apps/web/dist/server/main.js` imports `@duya/host/local-host`, and the
 * Host's dist chain reaches `@duya/plugin-core`, whose `moduleResolution:
 * bundler` emit carries extensionless relative specifiers and directory
 * imports. Plain Node has no such fallback, so the program died at import
 * time:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: .../packages/plugin-core/dist/error-wrapper
 *
 * The repository already knew this: `apps/web/tests/fixtures/register-dist-resolver.mjs`
 * installs a `module.registerHooks` shim for exactly this, and the acceptance
 * fixture passes `--import` to load it. The PRODUCT entry had no such hook, so
 * `npm run web-app` — the command the docs tell a user to run — crashed.
 *
 * Two things fix it, and this build is one of them:
 *
 *   1. The Web server now reads the runtime descriptor through
 *      `@duya/host/host-runtime`, a module with no runtime dependency at all,
 *      and talks to the Host through `@duya/host/http-client`, whose imports
 *      are all type-only. The server's module graph therefore holds no
 *      package whose emit plain Node cannot resolve.
 *
 *   2. This bundle compiles that server from TypeScript SOURCE, with
 *      `workspacePublicSources()` resolving every `@duya/` specifier to its
 *      package source, so the emitted program is self-contained: one file, no
 *      dist chain, no resolver shim. It is the same approach
 *      `build-cli-bundle.mjs` and `build-host-worker-bundle.mjs` take for the
 *      same reason.
 *
 * The bundle is ESM, matching `apps/web/package.json`'s `"type": "module"`, so
 * `import.meta.url` keeps working — `main.ts` resolves the browser build
 * directory (`../client/`) from it.
 *
 * The browser half of the Web app is NOT bundled here: it is built by Vite
 * into `apps/web/dist/client/`, and this script must not touch it.
 */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspacePublicSources } from './workspace-public-sources.mjs';

/**
 * The repository root, derived from THIS script's location rather than from
 * `process.cwd()`.
 *
 * `npm run -w @duya/web build` runs the script with `apps/web` as the working
 * directory, and `workspacePublicSources()` reads `packages/` relative to the
 * root it is given — so a cwd-derived root would look for
 * `apps/web/packages` and find nothing.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const outdir = path.join(repoRoot, 'apps', 'web', 'dist', 'server');
const outfile = path.join(outdir, 'main.js');

if (fs.existsSync(outdir)) {
  fs.rmSync(outdir, { recursive: true, force: true });
}
fs.mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, 'apps/web/src/server/main.ts')],
  outfile,
  bundle: true,
  plugins: [workspacePublicSources(repoRoot)],
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: false,
  minify: false,
  // The server's own module graph holds only Node builtins plus two Host
  // modules that resolve to source. Nothing native is reachable from it, so
  // there is nothing to keep external: the emitted file must stand alone.
  external: [],
});

const stats = fs.statSync(outfile);
console.log(`[build-web-server-bundle] Built ${outfile} (${(stats.size / 1024).toFixed(1)} KB)`);
