import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
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
  },
});
