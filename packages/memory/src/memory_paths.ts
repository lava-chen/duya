/**
 * Memory root path resolution.
 *
 * Single source of truth for where the persistent memory tree lives.
 * Default is `~/.duya/memory`; the `DUYA_MEMORY_ROOT` env var overrides
 * it (used by tests and alternative-home installations).
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Resolve the DUYA root (`~/.duya`). Returns null when the home directory
 * is unavailable.
 */
export function getDuyaRoot(): string | null {
  const home = os.homedir()
  if (!home) return null
  return path.join(home, '.duya')
}

/**
 * Resolve the DUYA memory root (default `~/.duya/memory`), honouring an
 * optional override via the `DUYA_MEMORY_ROOT` env var. Returns null when
 * the home directory is unavailable.
 */
export function getDuyaMemoryRoot(): string | null {
  if (process.env.DUYA_MEMORY_ROOT) return process.env.DUYA_MEMORY_ROOT
  const home = os.homedir()
  if (!home) return null
  return path.join(home, '.duya', 'memory')
}

/**
 * Resolve a relative memory/state path without following links below its
 * trusted root. Missing tails are allowed so recovery can remove stale index
 * rows. This checks an existing tree; it is not a lock against concurrent
 * filesystem replacement by another process.
 */
export function resolveUnlinkedMemoryPath(root: string, relative: string): string | null {
  const normalized = relative.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (!root || segments.some((part) => !part || part === '.' || part === '..' || /[:\0]/.test(part))) return null
  const absolute = path.resolve(root, ...segments)
  let cursor = path.resolve(root)
  for (const segment of segments) {
    cursor = path.join(cursor, segment)
    try {
      const stat = fs.lstatSync(cursor)
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute
      return null
    }
  }
  return absolute
}

/** Only canonical tier/legacy memory files are eligible for forget repair. */
export function isCanonicalMemoryPath(relative: string): boolean {
  const parts = relative.replace(/\\/g, '/').split('/')
  if (!relative.endsWith('.md') || parts.some((part) => !part || part === '.' || part === '..' || /[:\0]/.test(part))) return false
  if (parts[0] === 'memory' && ['items', 'entities', 'global'].includes(parts[1] ?? '')) return parts.length >= 3
  const safeId = (value: string | undefined) => value !== undefined && /^[a-zA-Z0-9_-]+$/.test(value)
  if (parts[0] === 'agents' && safeId(parts[1]) && ['memory', 'user'].includes(parts[2] ?? '')) return parts.length >= 4
  return parts[0] === 'projects' && safeId(parts[1]) && parts[2] === 'agents' && safeId(parts[3]) && parts.length >= 5
}
