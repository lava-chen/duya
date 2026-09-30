import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

// Resolve workspace plugin-core from THIS checkout (worktree-safe;
// the node_modules junction pins the primary checkout).
const PLUGIN_CORE_ROOT = fileURLToPath(new URL('./packages/plugin-core', import.meta.url))
// Same worktree-safe treatment for @duya/browser (plan 583 seam A): tests
// run the engine SOURCE, while `tsc` checks the agent against the package's
// emitted `dist/index.d.ts`. Resolving both to the package dir would make
// vitest read `main: dist/index.js` and silently test a stale build.
const BROWSER_SRC = path.resolve(__dirname, './packages/browser/src/index.ts')

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
      'packages/ai/test/**/*.test.ts',
      'packages/gateway/src/**/*.test.ts',
      'packages/agent/src/**/*.test.ts',
      'packages/browser/src/**/*.test.ts',
      'packages/browser/tests/**/*.test.ts',
      'packages/cli/src/**/*.test.ts',
      'packages/computer-use/src/**/*.test.ts',
      'scripts/**/*.test.ts',
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
      // Pin better-sqlite3 to the root-managed copy. packages/agent pins
      // v11 (no node-24 prebuilt exists), so its package-local duplicate
      // loads with a stale NODE_MODULE_VERSION; the root copy is the one
      // the ensure-sqlite-abi pretest swaps per runtime.
      { find: /^better-sqlite3$/, replacement: path.resolve(__dirname, './node_modules/better-sqlite3') },
      // Resolve workspace plugin-core from THIS checkout (worktree-safe;
      // the node_modules junction pins the primary checkout).
      { find: '@duya/plugin-core', replacement: PLUGIN_CORE_ROOT },
      { find: '@duya/browser', replacement: BROWSER_SRC },
      // Mirror vite.config.ts aliases so vitest can resolve
      // `@duya/conductor/renderer/*` to the package's source tree. Without
      // these the test environment errors out when any imported file
      // transitively pulls in WidgetRenderer / ConductorView / etc.
      { find: /^@duya\/conductor\/renderer\/(.*)$/, replacement: path.resolve(__dirname, './packages/conductor/src/renderer/') + '/$1' },
      { find: '@duya/conductor/renderer', replacement: path.resolve(__dirname, './packages/conductor/src/renderer/index') },
    ],
  },
})
