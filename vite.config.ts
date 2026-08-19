import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    // Resolve `.ts` before `.js` so the dev server always picks up the
    // latest source, not the stale `src/**/*.js` artifacts that are
    // committed alongside `.ts` files. Without this, Vite's default
    // extensions order (`['.mjs', '.js', '.mts', '.ts', ...]`) makes
    // it match the older compiled `.js` first — and any newly-added
    // i18n keys or other source changes silently don't reach the
    // browser until the `.js` artifacts are regenerated.
    extensions: ['.mjs', '.mts', '.ts', '.tsx', '.js', '.jsx', '.json'],
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: /^@duya\/conductor\/renderer\/(.*)$/, replacement: path.resolve(__dirname, './packages/conductor/src/renderer/') + '/$1' },
      { find: '@duya/conductor/renderer', replacement: path.resolve(__dirname, './packages/conductor/src/renderer/index') },
    ],
  },
  // Pre-bundle heavy UI / state libs up-front so the first browser
  // request doesn't have to wait for esbuild to crawl them on demand.
  // Heavy deps: antd, framer-motion, streamdown, react-syntax-highlighter,
  // react-grid-layout, xterm… (plus the SDK CommonJS entries listed below).
  optimizeDeps: {
    // `entries` restricts the dep crawler to the app entry's real import
    // graph, so it never scans the generated html under release/ /
    // storybook-static/ / build/ / docs/ as crawl entries (which starves the
    // event loop on slow Windows disk IO and holds page requests forever).
    // IMPORTANT: do NOT add noDiscovery here — it would disable automatic
    // collection of transitive CommonJS deps (e.g. hoist-non-react-statics
    // pulled in by @emotion/react), which then get served raw and fail their
    // named/default ESM imports in the renderer.
    entries: ['index.html'],
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      // Pre-bundle the heavy UI / state libs and the SDK CommonJS entries
      // explicitly so the first browser request doesn't wait for esbuild to
      // crawl them on demand. The SDK deep paths ship CommonJS and are
      // imported with named bindings (partialParse, _iterSSEMessages), so
      // they must be pre-bundled with interop — see `needsInterop` below.
      '@anthropic-ai/sdk',
      '@anthropic-ai/sdk/_vendor/partial-json-parser/parser.js',
      '@anthropic-ai/sdk/core/streaming.js',
      'openai',
      '@tanstack/react-query',
      'zustand',
      'zustand/middleware',
      'clsx',
      'tailwind-merge',
      'framer-motion',
      'antd',
      '@tabler/icons-react',
      'react-markdown',
      'remark-gfm',
      'react-syntax-highlighter',
      'react-grid-layout',
      'streamdown',
      'html2canvas',
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@xterm/addon-web-links',
    ],
    // `node-pty` and `better-sqlite3` are native and only used in the
    // Electron main process — never scan them in the renderer graph.
    exclude: ['node-pty', 'better-sqlite3'],
    // `@anthropic-ai/sdk` (and `openai`) ship CommonJS with named exports
    // (`exports.partialParse`, `exports._iterSSEMessages`). When pre-bundled,
    // esbuild must wrap them in a CommonJS interop so the renderer's
    // `import { partialParse } from '@anthropic-ai/sdk/.../parser.js'` bind
    // correctly. `needsInterop` forces that wrapper; without it the optimizer
    // may emit them as-is and the named imports fail at runtime.
    needsInterop: [
      '@anthropic-ai/sdk',
      '@anthropic-ai/sdk/_vendor/partial-json-parser/parser.js',
      '@anthropic-ai/sdk/core/streaming.js',
      'openai',
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 500,
    minify: 'terser',
    cssMinify: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // React core
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'vendor-react';
          }
          // UI component libraries
          if (
            id.includes('node_modules/antd') ||
            id.includes('node_modules/@phosphor-icons/react')
          ) {
            return 'vendor-ui';
          }
          // Animation and motion
          if (id.includes('node_modules/framer-motion')) {
            return 'vendor-motion';
          }
          // Markdown and code highlighting
          if (
            id.includes('node_modules/react-markdown') ||
            id.includes('node_modules/react-syntax-highlighter') ||
            id.includes('node_modules/remark-gfm')
          ) {
            return 'vendor-markdown';
          }
          // State management
          if (id.includes('node_modules/zustand')) {
            return 'vendor-state';
          }
          // Streamdown and plugins
          if (id.includes('node_modules/streamdown')) {
            return 'vendor-streamdown';
          }
        },
      },
    },
  },
  server: {
    port: 3000,
    // Never cache dev responses: Vite's module ETag is derived from the
    // source file (size + mtime), NOT the transformed output, so a renderer
    // disk cache can revalidate 304 and keep serving a stale transform that
    // references an old `?v=<optimize hash>` — which 404s after a Vite
    // restart re-optimizes deps with a different hash. `no-store` forces
    // every reload to fetch fresh transforms and stays consistent with the
    // current optimize hash.
    headers: {
      'Cache-Control': 'no-store',
    },
    // Bind explicitly to IPv4 loopback so Electron (which resolves
    // "localhost" to IPv6 first on some Windows hosts) can reach the
    // dev server without falling back to a file:// error page. Set
    // DUYA_VITE_HOST to override (e.g. "0.0.0.0" for LAN testing).
    host: process.env.DUYA_VITE_HOST ?? '127.0.0.1',
    // DUYA_NO_HMR=1 disables HMR entirely: file edits (e.g. from a
    // background agent working in the same repo) no longer hot-swap
    // components or trigger a full page reload. The renderer stays on
    // the already-loaded bundle; press Ctrl+R to reload and fetch the
    // fresh modules on demand.
    hmr: process.env.DUYA_NO_HMR === '1' ? false : undefined,
    watch: {
      // The E2E runner creates per-namespace userData directories under
      // the repo root; watching them races with locked Chromium cache
      // files and can crash the dev server on Windows.
      // Build outputs are excluded too: `electron:dev` regenerates
      // dist-electron/, packages/agent/bundle/ and (after packaging)
      // release/ on every start, and a background agent editing code
      // triggers rescan after each build. Watching these multi-GB trees
      // on Windows pins the Vite event loop (page requests time out for
      // minutes) — the renderer only ever needs src/ and packages/*/src.
      ignored: [
        '**/.e2e-userdata/**',
        '**/node_modules/**',
        '**/.git/**',
        '**/.mimosa/**',
        '**/.claude/**',
        '**/.cache/**',
        '**/dist/**',
        '**/dist-electron/**',
        '**/release/**',
        '**/build/**',
        '**/storybook-static/**',
        '**/docs/**',
        '**/coverage/**',
        '**/packages/agent/bundle/**',
      ],
    },
    // Kick off dep optimization + transform of the entry / hot
    // modules as soon as the server boots, not when the browser
    // first requests them. Cuts the perceived "cold start" by the
    // time it normally takes esbuild to crawl the import graph
    // after the first request.
    //
    // Disabled: on this Windows machine the pre-warm scan of the
    // entry module graph does synchronous filesystem work that
    // stalls the event loop under slow disk IO, making every page
    // request time out for minutes. Browser requests trigger the
    // same transform on demand at acceptable speed.
    // warmup: {
    //   clientFiles: [
    //     './index.html',
    //     './src/main.tsx',
    //     './src/App.tsx',
    //     './src/styles/globals.css',
    //   ],
    // },
  },
});
