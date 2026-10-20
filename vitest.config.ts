import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'node:fs'

// Follow this checkout's declared exports, including relocated source subpaths.
// Shared dependency junctions otherwise let Vite read the primary manifest.
const WORKSPACE_SOURCE_ALIASES = ['host', 'data', 'capabilities', 'agent-runtime', 'agent-core', 'agent-protocol', 'client-core', 'command-catalog'].flatMap((name) => {
  const directory = new URL(`./packages/${name}/`, import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('package.json', directory), 'utf8')) as {
    name: string;
    exports: Record<string, string | { types?: string; import?: string; default?: string }>;
  }
  return Object.entries(manifest.exports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length).map(([key, value]) => {
    const target = typeof value === 'string' ? value : value.types ?? value.import ?? value.default
    if (!target) throw new Error(`Missing source export target: ${manifest.name}${key}`)
    const specifier = manifest.name + (key === '.' ? '' : key.slice(1))
    const pattern = specifier.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)')
    const source = target.replace(/^\.\/dist\//, './src/').replace(/\.d\.ts$/, '.ts').replace(/\.js$/, '.ts')
    return { find: new RegExp(`^${pattern}$`), replacement: fileURLToPath(new URL(source.replace('*', '$1'), directory)) }
  })
})

// Resolve workspace plugin-core from THIS checkout (worktree-safe;
// the node_modules junction pins the primary checkout). Points at `dist`,
// matching the package's own `exports` map: consumers now import declared
// subpaths (`@duya/plugin-core/mcp/core/alias`) instead of reaching into
// `src/`, so the alias has to map a subpath onto `dist/<subpath>`.
const PLUGIN_CORE_DIST = fileURLToPath(new URL('./packages/plugin-core/dist', import.meta.url))
// Plan 610 A5: same worktree-safety reason, for the package that took over the
// App Connector vocabulary and the `.app.json` declaration schema.
const CONNECTORS_DIST = fileURLToPath(new URL('./packages/connectors/dist', import.meta.url))
// Same reason: the protocol package must be tested against THIS worktree's
// source, never the primary checkout's dist.
const AGENT_PROTOCOL_SRC = fileURLToPath(new URL('./packages/agent-protocol/src', import.meta.url))
// Plan 610 A5: memory moved out of `packages/agent/src/memory-{state,rollout}`
// into its own package. Aliased to SOURCE, not dist, so a test that mocks or
// imports a memory subpath exercises the code being edited without requiring a
// build first -- and so `vi.mock` on a memory subpath intercepts the same
// module id the consumer under test imports.
const MEMORY_SRC = fileURLToPath(new URL('./packages/memory/src', import.meta.url))
// Plan 610 A8: the extension contract package. Source alias, same
// worktree-safety reason as memory above.
const TOOLING_SRC = fileURLToPath(new URL('./packages/tooling/src', import.meta.url))
// Plan 610 A8: the FS capability moved out of packages/agent. Aliased to
// SOURCE so the agent shims and capability tests exercise the edited code
// without a build first, and so module identity is shared across shims.
const CAPABILITIES_SRC = fileURLToPath(new URL('./packages/capabilities/src', import.meta.url))
// T04b: the host package for the same worktree-safety reason as every entry
// above, and for one extra reason that only shows up here. `host` owns
// `worker-db-client`, and host's own modules import it by RELATIVE path
// (`./worker-db-client.js`) while the agent-side shim
// (`packages/agent/src/ipc/db-client.ts`) imports it by PACKAGE NAME. Leaving
// both to resolve through the node_modules junction pins them to the primary
// checkout, so a `vi.mock` aimed at one of those ids cannot intercept the
// other -- and the unmocked side then puts a plain object on the vitest pool's
// own channel. Aliasing both spellings onto THIS checkout's source is what
// makes one module id again.
const HOST_SRC = fileURLToPath(new URL('./packages/host/src', import.meta.url))

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/ui/src/**/*.test.ts',
      'packages/ui/src/**/*.test.tsx',
      'packages/ui/src/**/*.spec.ts',
      'apps/desktop/src/main/**/*.test.ts',
      'apps/web/tests/**/*.test.ts',
      // Plan 587 M5.2: the contracts boundary. Collected deliberately, because
      // a test file outside `include` is a test nobody ever runs, and
      // `check-test-coverage` treats it as exactly that.
      'apps/desktop/src/contracts/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      'packages/*/tests/**/*.spec.ts',
      'packages/ai/test/**/*.test.ts',
      'packages/agent-protocol/test/**/*.test.ts',
      'packages/agent-core/test/**/*.test.ts',
      'packages/agent-runtime/test/**/*.test.ts',
      // Plan 610 A8: the conformance suite moved with SurfaceModel into
      // packages/client-core. A tracked test file left outside this array is
      // one no runner collects, which check-test-coverage reports as an
      // orphan. Same no-apostrophe rule as the memory glob below.
      'packages/client-core/test/**/*.test.ts',
      'packages/input-completion/test/**/*.test.ts',
      'packages/gateway/src/**/*.test.ts',
      'packages/agent/src/**/*.test.ts',
      // Plan 610 A5: the memory tests moved with the code into
      // `packages/memory/src/__tests__`. Without this glob they are tracked
      // test files that no runner collects, which `check-test-coverage`
      // correctly treats as a test nobody ever runs.
      //
      // No apostrophe characters anywhere in this comment:
      // `check-test-coverage.mjs` reads the include array with a regex over
      // quoted strings and does not strip comments, so one apostrophe here
      // silently swallows the glob below and the gate starts reporting every
      // test file in the repo as an orphan.
      'packages/memory/src/**/*.test.ts',
      'packages/cli/src/**/*.test.ts',
      // Plan 610 T15: the capability degradation suite sits in `test/`, not
      // `src/`, because it drives the Host HTTP boundary end to end rather
      // than unit-testing a CLI module. A tracked test file outside this array
      // is one no runner collects, which `check-test-coverage` reports as an
      // orphan and correctly calls a test nobody ever runs.
      // No apostrophe characters in this comment: the coverage script reads the
      // include array with a regex over quoted strings and does not strip
      // comments, so one apostrophe here would swallow the glob below.
      'packages/cli/test/**/*.test.ts',
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
      ...WORKSPACE_SOURCE_ALIASES,
      { find: '@', replacement: path.resolve(__dirname, './packages/ui/src') },
      { find: '@duya/ui/styles.css', replacement: path.resolve(__dirname, './packages/ui/src/styles/globals.css') },
      { find: /^@duya\/ui\/(.*)$/, replacement: path.resolve(__dirname, './packages/ui/src') + '/$1' },
      { find: '@duya/ui', replacement: path.resolve(__dirname, './packages/ui/src/index.ts') },
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
      // Plan 610 A5: the App Connector vocabulary and `.app.json` schema moved
      // out of plugin-core into their own package. Same reason as above — this
      // checkout's `dist`, never the primary checkout's node_modules junction.
      { find: /^@duya\/connectors$/, replacement: CONNECTORS_DIST + '/index.js' },
      { find: /^@duya\/connectors\/(.*)$/, replacement: CONNECTORS_DIST + '/$1' },
      // Plan 610 A5. Subpath rule before the bare name, so a declared subpath is
      // never swallowed. `/testing` resolves to the subpath INDEX (it holds two
      // modules, not one).
      { find: /^@duya\/memory\/testing$/, replacement: MEMORY_SRC + '/testing/index.ts' },
      { find: /^@duya\/memory\/(.*)$/, replacement: MEMORY_SRC + '/$1' },
      { find: /^@duya\/memory$/, replacement: MEMORY_SRC + '/index.ts' },
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
      // agent-core / agent-runtime resolve to THIS checkout source too, for
      // the same worktree-safety reason as the protocol package above.
      { find: /^@duya\/agent-core$/, replacement: fileURLToPath(new URL('./packages/agent-core/src', import.meta.url)) + '/index.ts' },
      { find: /^@duya\/agent-runtime$/, replacement: fileURLToPath(new URL('./packages/agent-runtime/src', import.meta.url)) + '/index.ts' },
      // The input-completion core shared by the desktop composer and the CLI
      // TUI. Source, not dist, for the same worktree-safety reason.
      { find: /^@duya\/input-completion$/, replacement: fileURLToPath(new URL('./packages/input-completion/src', import.meta.url)) + '/index.ts' },
      // T04b. Subpath rule before the bare name, same as the protocol package
      // above, so a declared subpath is never swallowed.
      { find: /^@duya\/host\/(.*)$/, replacement: HOST_SRC + '/$1' },
      { find: /^@duya\/host$/, replacement: HOST_SRC + '/index.ts' },
      // Plan 583 ISS-02 + 610 A5 continuation (2026-10-10): the duya-file
      // media allowlist consumes the root-boundary primitive from
      // `@duya/sandbox` (moved out of packages/agent/src/tool/allowedRoots.ts).
      // Point at this checkout's source (worktree-safe), same as plugin-core
      // and the protocol packages above.
      {
        find: /^@duya\/sandbox$/,
        replacement: fileURLToPath(
          new URL('./packages/sandbox/src/index.ts', import.meta.url),
        ),
      },
      // Plan 610 A8: the extension contract package (source, worktree-safe).
      { find: /^@duya\/tooling$/, replacement: TOOLING_SRC + '/index.ts' },
      // Plan 610 A8: the FS capability package (source, worktree-safe).
      // Every declared subpath of the package `exports` map mirrors the src
      // directory layout, so one pair of rules covers them all. The two
      // directory barrels (contracts, permissions) are listed explicitly
      // because directory-index resolution is not reliable in vite-node.
      // No apostrophes in this comment block: check-test-coverage.mjs scans
      // quoted strings in this file verbatim.
      { find: /^@duya\/capabilities\/contracts$/, replacement: CAPABILITIES_SRC + '/contracts/index.ts' },
      { find: /^@duya\/capabilities\/permissions$/, replacement: CAPABILITIES_SRC + '/permissions/index.ts' },
      { find: /^@duya\/capabilities\/(.*)$/, replacement: CAPABILITIES_SRC + '/$1' },
      { find: /^@duya\/capabilities$/, replacement: CAPABILITIES_SRC + '/index.ts' },
      // Mirror vite.config.ts aliases so vitest can resolve
      // `@duya/conductor/renderer/*` to the package's source tree. Without
      // these the test environment errors out when any imported file
      // transitively pulls in WidgetRenderer / ConductorView / etc.
      { find: /^@duya\/conductor\/renderer\/(.*)$/, replacement: path.resolve(__dirname, './packages/conductor/src/renderer/') + '/$1' },
      { find: '@duya/conductor/renderer', replacement: path.resolve(__dirname, './packages/conductor/src/renderer/index') },
    ],
  },
})
