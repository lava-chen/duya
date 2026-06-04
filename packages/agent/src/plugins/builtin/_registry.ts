import { readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

export interface BuiltinPluginIndex {
  name: string
  dir: string
}

// Resolve the directory of this module across the three runtimes that load
// the agent package:
//   1. Raw ESM (tsc dist, NodeNext) — `import.meta.url` is a string.
//   2. esbuild CJS bundles with the `import_meta_url` polyfill
//      (`scripts/build-agent-bundle.mjs`, `scripts/build-cli-bundle.mjs`)
//      — `import.meta.url` is replaced with the polyfilled value at build
//      time, so it is also a string at runtime.
//   3. esbuild CJS bundles WITHOUT the polyfill (`scripts/build-electron.mjs`,
//      which bundles `electron/plugins/catalog.ts` → this file as part of
//      `dist-electron/main.js`) — `import.meta` is `undefined`, but CJS
//      exposes `__dirname`. We must fall back to it or `fileURLToPath`
//      throws ERR_INVALID_ARG_TYPE on the first call.
//
// The directory is computed lazily so that picking the right strategy does
// not have to happen at module-init time, where the CJS crash occurred.
function resolveBuiltinDir(): string {
  const meta = import.meta as { url?: string } | undefined
  if (meta && typeof meta.url === 'string') {
    return dirname(fileURLToPath(meta.url))
  }
  return __dirname
}

const BUILTIN_DIR = resolveBuiltinDir()

let _cache: BuiltinPluginIndex[] | null = null

export function listBuiltinPlugins(): BuiltinPluginIndex[] {
  if (_cache) return _cache
  _cache = readdirSync(BUILTIN_DIR)
    .filter((name) => {
      const p = join(BUILTIN_DIR, name)
      return statSync(p).isDirectory() && !name.startsWith('_') && !name.startsWith('.')
    })
    .map((name) => ({ name, dir: join(BUILTIN_DIR, name) }))
  return _cache
}

export function getBuiltinPluginDir(name: string): string | undefined {
  return listBuiltinPlugins().find((p) => p.name === name)?.dir
}

export function clearBuiltinCache(): void {
  _cache = null
}
