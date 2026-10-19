import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const uiSource = path.resolve(webRoot, '../../packages/ui/src');

export default defineConfig({
  root: webRoot,
  publicDir: path.resolve(webRoot, '../../public'),
  plugins: [react()],
  base: '/',
  resolve: {
    extensions: ['.mjs', '.mts', '.ts', '.tsx', '.js', '.jsx', '.json'],
    alias: [
      { find: /^@\/(.*)$/, replacement: `${uiSource}/$1` },
      { find: '@duya/ui/styles.css', replacement: path.join(uiSource, 'styles/globals.css') },
      { find: '@duya/ui', replacement: path.join(uiSource, 'index.ts') },
      { find: /^@duya\/conductor\/renderer\/(.*)$/, replacement: path.resolve(webRoot, '../../packages/conductor/src/renderer/$1') },
      { find: '@duya/conductor/renderer', replacement: path.resolve(webRoot, '../../packages/conductor/src/renderer/index.ts') },
    ],
  },
  build: {
    outDir: path.resolve(webRoot, 'dist/client'),
    emptyOutDir: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
});
