import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@desktop-styles': fileURLToPath(new URL('../desktop/src/renderer/styles', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/browser',
    emptyOutDir: true,
    sourcemap: false,
  },
});
