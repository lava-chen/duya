/**
 * Vite config for the streaming-render benchmark harness.
 *
 * A SEPARATE build from the app's own `vite build`, for two reasons:
 *
 *   1. The harness must render the chat components in isolation, without the
 *      app shell (stores, panels, sidebars) — the numbers are about the
 *      streaming render path, not about the whole window.
 *   2. It must be a PRODUCTION build (minified, production React), because
 *      dev React double-invokes render functions and warns, which changes
 *      the very cost this harness measures.
 *
 * The aliases mirror the app's root `vite.config.ts` so the harness resolves
 * the same modules the app does — including `@` → `packages/ui/src`.
 *
 * The build output goes to `docs-local/` (gitignored) so a benchmark run
 * never leaves artefacts inside the source tree.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** packages/ui/src */
const UI_SRC = path.resolve(HARNESS_DIR, '../../../..');
/** repository root */
const REPO_ROOT = path.resolve(HARNESS_DIR, '../../../../../../..');

export default defineConfig({
  root: HARNESS_DIR,
  base: './',
  plugins: [react()],
  resolve: {
    extensions: ['.mjs', '.mts', '.ts', '.tsx', '.js', '.jsx', '.json'],
    alias: [
      { find: '@duya/ui/styles.css', replacement: path.resolve(UI_SRC, 'styles/globals.css') },
      { find: /^@duya\/ui\/(.*)$/, replacement: path.resolve(UI_SRC) + '/$1' },
      { find: '@duya/ui', replacement: path.resolve(UI_SRC, 'index.ts') },
      { find: '@', replacement: UI_SRC },
    ],
  },
  css: {
    // The app's own PostCSS config (Tailwind v4) — the harness renders the
    // same stylesheet, so the same layout work is measured.
    postcss: path.join(REPO_ROOT, 'postcss.config.mjs'),
  },
  build: {
    outDir: path.join(REPO_ROOT, 'docs-local', 'perf-streaming', 'harness-dist'),
    emptyOutDir: true,
    // Minified by default, like the app's own build. `PERF_HARNESS_UNMINIFIED=1`
    // drops minification for CPU-profiling runs: a minified bundle hides every
    // function name, and a profile that cannot name its hot functions is not
    // evidence of anything.
    minify: process.env.PERF_HARNESS_UNMINIFIED === '1' ? false : 'terser',
    sourcemap: true,
    target: 'chrome120',
    chunkSizeWarningLimit: 2000,
  },
});
