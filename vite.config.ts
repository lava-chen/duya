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
  // Without this, Vite's dep scanner walks the full import graph from
  // `/src/main.tsx`, which can take 10s+ on first dev start when the
  // `.vite/deps` cache is cold (heavy deps: antd, framer-motion,
  // streamdown, react-syntax-highlighter, react-grid-layout, xterm…).
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      '@tanstack/react-query',
      'zustand',
      'zustand/middleware',
      'clsx',
      'tailwind-merge',
      'es-toolkit',
      'framer-motion',
      'antd',
      '@ant-design/icons',
      '@phosphor-icons/react',
      '@tabler/icons-react',
      'lucide-react',
      '@lobehub/ui',
      'react-markdown',
      'remark-gfm',
      'react-syntax-highlighter',
      'react-grid-layout',
      'streamdown',
      '@streamdown/cjk',
      '@streamdown/math',
      '@streamdown/mermaid',
      'html2canvas',
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@xterm/addon-web-links',
      'use-stick-to-bottom',
    ],
    // `node-pty` and `better-sqlite3` are native and only used in the
    // Electron main process — never scan them in the renderer graph.
    exclude: ['node-pty', 'better-sqlite3'],
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
            id.includes('node_modules/@lobehub/ui') ||
            id.includes('node_modules/@phosphor-icons/react') ||
            id.includes('node_modules/lucide-react')
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
          if (
            id.includes('node_modules/streamdown') ||
            id.includes('node_modules/@streamdown/')
          ) {
            return 'vendor-streamdown';
          }
        },
      },
    },
  },
  server: {
    port: 3000,
    // Bind explicitly to IPv4 loopback so Electron (which resolves
    // "localhost" to IPv6 first on some Windows hosts) can reach the
    // dev server without falling back to a file:// error page. Set
    // DUYA_VITE_HOST to override (e.g. "0.0.0.0" for LAN testing).
    host: process.env.DUYA_VITE_HOST ?? '127.0.0.1',
    // Kick off dep optimization + transform of the entry / hot
    // modules as soon as the server boots, not when the browser
    // first requests them. Cuts the perceived "cold start" by the
    // time it normally takes esbuild to crawl the import graph
    // after the first request.
    warmup: {
      clientFiles: [
        './index.html',
        './src/main.tsx',
        './src/App.tsx',
        './src/styles/globals.css',
      ],
    },
  },
});
