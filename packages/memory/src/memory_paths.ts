/**
 * Memory root path resolution.
 *
 * Single source of truth for where the persistent memory tree lives.
 * Default is `~/.duya/memory`; the `DUYA_MEMORY_ROOT` env var overrides
 * it (used by tests and alternative-home installations).
 */

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
