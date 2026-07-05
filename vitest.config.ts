import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/*.spec.ts',
      'electron/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      'packages/*/tests/**/*.spec.ts',
      'packages/gateway/src/**/*.test.ts',
      'packages/agent/src/**/*.test.ts',
      'packages/cli/src/**/*.test.ts',
      'packages/conductor/src/**/*.test.ts',
      'packages/conductor/src/**/*.test.tsx',
    ],
    exclude: ['node_modules', 'dist', '.next'],
    setupFiles: ['./test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '.next/**',
        '**/*.d.ts',
        '**/*.config.ts',
        '**/*.test.ts',
        '**/*.test.tsx',
      ],
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  resolve: {
    // Mirror vite.config.ts: prefer `.ts` over `.js` so test runs pick
    // up the latest source instead of stale committed `.js` artifacts.
    extensions: ['.mjs', '.mts', '.ts', '.tsx', '.js', '.jsx', '.json'],
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // Mirror vite.config.ts aliases so vitest can resolve
      // `@duya/conductor/renderer/*` to the package's source tree. Without
      // these the test environment errors out when any imported file
      // transitively pulls in WidgetRenderer / ConductorView / etc.
      { find: /^@duya\/conductor\/renderer\/(.*)$/, replacement: path.resolve(__dirname, './packages/conductor/src/renderer/') + '/$1' },
      { find: '@duya/conductor/renderer', replacement: path.resolve(__dirname, './packages/conductor/src/renderer/index') },
    ],
  },
})
