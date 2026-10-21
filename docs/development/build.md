# Build System

| Component         | Technology                      | Config                       |
| ----------------- | ------------------------------- | ---------------------------- |
| Frontend          | Vite 6 + React 19 + Zero Router | `vite.config.ts`             |
| Desktop Shell     | Electron 44.2.0 (**requires macOS 13+**; GUI gates run on macOS 13+ hosts) | `apps/desktop/src/main/index.ts` |
| Electron Compiler | esbuild                         | `scripts/build-electron.mjs` |
| Packager          | electron-builder                | `electron-builder.yml`       |
| Agent Core        | TypeScript                      | `packages/agent-core/`        |
| Testing           | Vitest + Playwright             | `vitest.config.ts`           |

## Worker Bundle (MUST FOLLOW)

- Format: CommonJS (`format: 'cjs'`). Output: `packages/host/bundle/worker-entry.js`.
  The esbuild entry point is `packages/cli/src/agent-worker-entry.ts`, **not** a file
  inside `packages/agent/` (`scripts/build-agent-bundle.mjs:30`).
- `bundle: true` inlines all runtime dependencies. Only `better-sqlite3` (native) and
  `BashWorker.js` (worker) remain external.
- **`blessed` is external in the CHAT CLI entry only.** It cannot be bundled:
  `blessed/lib/widget.js` enumerates its own `widgets/` directory with `readdirSync` and
  `require`s each file at runtime, which esbuild cannot see. First symptom is a
  misleading `Could not resolve 'term.js'` / `'pty.js'` — two packages blessed never
  declares but requires inside a widget method. Marking those external only moves the
  failure to runtime. The packaged worker entry never imports `cli/`, so it needs none of
  this; if that stops being true, fix the chat CLI entry rather than copying its externals up.
- Production resolves: primary `resources/harness-bundle/worker-entry.js`, fallback paths
  only for debug.
- Self-contained: no `node_modules` copying in `afterPack`.
- `better-sqlite3`: packaged to `resources/better-sqlite3/`, shared by main and agent.
  Agent receives `DUYA_BETTER_SQLITE3_PATH` env var.
- `BashWorker.js`: bundled to `resources/harness-bundle/BashTool/`. Worker uses
  `process.execPath` as Node.js runtime in production.
- Prompt `.hbs` assets: copied to `resources/harness-bundle/assets/` by
  `scripts/build-agent-bundle.mjs`.
- `packages/host/bundle/` is **tracked in git** (the old `packages/agent/bundle/` was
  gitignored and no longer exists).
- Pre-release checks:
  - `release/win-unpacked/resources/harness-bundle/worker-entry.js` exists
  - `release/win-unpacked/resources/harness-bundle/assets/dynamic/environment.hbs` exists
  - `release/win-unpacked/resources/harness-bundle/BashTool/BashWorker.js` exists
  - `release/win-unpacked/resources/better-sqlite3/build/Release/better_sqlite3.node` exists
  - First packaged chat turn reaches Agent `ready` (no timeout)
  - `app.log` has no `ERR_MODULE_NOT_FOUND`

## Why the CLI is a bundle and not `dist/`

`node packages/cli/dist/index.js` does **not** run, for two independent reasons. Each was
found by fixing the first and watching the second appear:

1. **Extensionless specifiers.** Node's ESM loader rejects them.
   `packages/plugin-core` is emitted under `module: ESNext` + `moduleResolution: bundler`,
   which permits and emits `./scope` rather than `./scope.js`. It is the only workspace
   package that emits any.
2. **No assets.** `tsc` emits JavaScript and declarations only. The `.hbs` prompt assets
   are never copied, and the prompt loader throws at module scope when it cannot find them
   ("fail loud, a missing prompt asset must never degrade into an empty persona").

So a thin wrapper over `dist` cannot work, and making `dist` loadable would mean changing
every asset-dependent package plus teaching `build-packages.mjs` to copy assets — its own
header calls that array the single source of build order.

**Do not give this artifact its own output directory.** Every gate under
`scripts/architecture/` skips directories named exactly `bundle`; a `bundle-cli/` directory
is not skipped, and its generated JavaScript was then scanned as first-party source and
reported as a new `module-dependency` violation.

Note the two distinct bundles: `npm run bundle:agent` emits
`packages/host/bundle/worker-entry.js` (the worker process), and `npm run build:cli-bundle`
emits `packages/cli/bundle/cli.cjs` (the CLI).
