import { readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const BUILTIN_DIR = dirname(fileURLToPath(import.meta.url))

export interface BuiltinPluginIndex {
  name: string
  dir: string
}

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