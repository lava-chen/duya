import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

// Resolve workspace plugin-core from THIS checkout (worktree-safe;
// the node_modules junction pins the primary checkout). Points at `dist`,
// matching the package's own `exports` map: consumers now import declared
// subpaths (`@duya/plugin-core/mcp/core/alias`) instead of reaching into
// `src/`, so the alias has to map a subpath onto `dist/<subpath>`.
const PLUGIN_CORE_DIST = fileURLToPath(new URL('./packages/plugin-core/dist', import.meta.url))
// Same reason: the protocol package must be tested against THIS worktree's
// source, never the primary checkout's dist.
const AGENT_PROTOCOL_SRC = fileURLToPath(new URL('./packages/agent-protocol/src', import.meta.url))

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'apps/desktop/src/renderer/**/*.test.ts',
      'apps/desktop/src/renderer/**/*.test.tsx',
      'apps/desktop/src/renderer/**/*.spec.ts',
      'apps/desktop/src/main/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      'packages/*/tests/**/*.spec.ts',
      'packages/ai/test/**/*.test.ts',
      'packages/agent-protocol/test/**/*.test.ts',
      'packages/agent-core/test/**/*.test.ts',
      'packages/agent-runtime/test/**/*.test.ts',
      'packages/gateway/src/**/*.test.ts',
      'packages/agent/src/**/*.test.ts',
      'packages/cli/src/**/*.test.ts',
      'packages/computer-use/src/**/*.test.ts',
      'scripts/**/*.test.ts',
      'packages/conductor/src/**/*.test.ts',
      'packages/conductor/src/**/*.test.tsx',
      // Plan 587 E4.3: the eval tree. Collected deliberately rather than left to
      // a convention glob, because `check-test-coverage` treats a tracked test
      // file outside `include` as a test nobody ever runs.
      'evals/**/*.test.ts',
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
      { find: '@', replacement: path.resolve(__dirname, './apps/desktop/src/renderer') },
      // Pin better-sqlite3 to the root-managed copy. packages/agent pins
      // v11 (no node-24 prebuilt exists), so its package-local duplicate
      // loads with a stale NODE_MODULE_VERSION; the root copy is the one
      // the ensure-sqlite-abi pretest swaps per runtime.
      { find: /^better-sqlite3$/, replacement: path.resolve(__dirname, './node_modules/better-sqlite3') },
      // Resolve workspace plugin-core from THIS checkout (worktree-safe;
      // the node_modules junction pins the primary checkout). Exact bare
      // name first, then subpaths — the bare rule must not swallow them.
      { find: /^@duya\/plugin-core$/, replacement: PLUGIN_CORE_DIST + '/index.js' },
      { find: /^@duya\/plugin-core\/(.*)$/, replacement: PLUGIN_CORE_DIST + '/$1' },
      // Subpaths first: the bare name would otherwise swallow
      // `@duya/agent-protocol/testing` and `/legacy`.
      // `/testing` resolves to the subpath INDEX, matching the package's own
      // `exports` map. It used to point at `testing/fixtures.ts`, which is one
      // file inside the subpath and therefore silently hid `RunLedger` and
      // `mapWorkerEvent` from every consumer — a test importing
      // `@duya/agent-protocol/testing` got fixtures and nothing else.
      { find: /^@duya\/agent-protocol\/testing$/, replacement: AGENT_PROTOCOL_SRC + '/testing/index.ts' },
      { find: /^@duya\/agent-protocol\/legacy$/, replacement: AGENT_PROTOCOL_SRC + '/legacy/sse-event.ts' },
      // Plan 587 T3.1: the moved transcript vocabulary. Subpath rule first,
      // for the same reason as `/testing` and `/legacy` above — the bare-name
      // rule below would otherwise swallow it.
      { find: /^@duya\/agent-protocol\/transcript$/, replacement: AGENT_PROTOCOL_SRC + '/transcript/index.ts' },
      { find: /^@duya\/agent-protocol$/, replacement: AGENT_PROTOCOL_SRC + '/index.ts' },
      // agent-core / agent-runtime resolve to THIS checkout's source too, for
      // the same worktree-safety reason as the protocol package above.
      { find: /^@duya\/agent-core$/, replacement: fileURLToPath(new URL('./packages/agent-core/src', import.meta.url)) + '/index.ts' },
      { find: /^@duya\/agent-runtime$/, replacement: fileURLToPath(new URL('./packages/agent-runtime/src', import.meta.url)) + '/index.ts' },
      // Plan 583 ISS-02: the duya-file media allowlist reuses the sandboxed
      // file tools' root-boundary primitive from agent source. Point at this
      // checkout (worktree-safe), same as plugin-core above.
      {
        find: /^@duya\/agent\/tool\/allowedRoots$/,
        replacement: fileURLToPath(
          new URL('./packages/agent/src/tool/allowedRoots.ts', import.meta.url),
        ),
      },
      // Mirror vite.config.ts aliases so vitest can resolve
      // `@duya/conductor/renderer/*` to the package's source tree. Without
      // these the test environment errors out when any imported file
      // transitively pulls in WidgetRenderer / ConductorView / etc.
      { find: /^@duya\/conductor\/renderer\/(.*)$/, replacement: path.resolve(__dirname, './packages/conductor/src/renderer/') + '/$1' },
      { find: '@duya/conductor/renderer', replacement: path.resolve(__dirname, './packages/conductor/src/renderer/index') },
    ],
  },
})
