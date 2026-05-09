/**
 * Memory paths management for duya
 * Adapted from claude-code-haha memdir/paths.ts
 */

import { homedir } from 'os'
import { isAbsolute, join, normalize, sep } from 'path'

// Simple memoize implementation
function memoize<T extends (...args: unknown[]) => unknown>(
  fn: T,
  _resolver?: (...args: unknown[]) => unknown,
): T {
  const cache = new Map<string, unknown>()
  return ((...args: unknown[]) => {
    const key = JSON.stringify(args)
    if (cache.has(key)) {
      return cache.get(key)
    }
    const result = fn(...args)
    cache.set(key, result)
    return result
  }) as T
}

// =============================================================================
// Stub utilities - these would need full implementation for production use
// =============================================================================

/**
 * Whether auto-memory features are enabled (memdir, agent memory, past session search).
 * Enabled by default. Priority chain (first defined wins):
 *   1. duya_DISABLE_AUTO_MEMORY env var (1/true → OFF, 0/false → ON)
 *   2. autoMemoryEnabled in settings (supports project-level opt-out)
 *   3. Default: enabled
 */
export function isAutoMemoryEnabled(): boolean {
  const envVal = process.env.duya_DISABLE_AUTO_MEMORY
  if (envVal === '1' || envVal === 'true') {
    return false
  }
  if (envVal === '0' || envVal === 'false') {
    return true
  }
  return true
}

/**
 * Returns the base directory for persistent memory storage.
 * Resolution order:
 *   1. duya_MEMORY_DIR env var (explicit override)
 *   2. ~/.duya (default config home)
 */
export function getMemoryBaseDir(): string {
  if (process.env.duya_MEMORY_DIR) {
    return process.env.duya_MEMORY_DIR
  }
  return join(homedir(), '.duya')
}

const AUTO_MEM_DIRNAME = 'memory'
const AUTO_MEM_ENTRYPOINT_NAME = 'MEMORY.md'

/**
 * Normalize and validate a candidate auto-memory directory path.
 *
 * SECURITY: Rejects paths that would be dangerous as a read-allowlist root
 * or that normalize() doesn't fully resolve:
 * - relative (!isAbsolute): "../foo" — would be interpreted relative to CWD
 * - root/near-root (length < 3): "/" → "" after strip; "/a" too short
 * - Windows drive-root (C: regex): "C:\" → "C:" after strip
 * - UNC paths (\\server\share): network paths — opaque trust boundary
 * - null byte: survives normalize(), can truncate in syscalls
 *
 * Returns the normalized path with exactly one trailing separator,
 * or undefined if the path is unset/empty/rejected.
 */
function validateMemoryPath(
  raw: string | undefined,
  expandTilde: boolean,
): string | undefined {
  if (!raw) {
    return undefined
  }
  let candidate = raw
  if (
    expandTilde &&
    (candidate.startsWith('~/') || candidate.startsWith('~\\'))
  ) {
    const rest = candidate.slice(2)
    const restNorm = normalize(rest || '.')
    if (restNorm === '.' || restNorm === '..') {
      return undefined
    }
    candidate = join(homedir(), rest)
  }
  const normalized = normalize(candidate).replace(/[/\\]+$/, '')
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.startsWith('\\\\') ||
    normalized.startsWith('//') ||
    normalized.includes('\0')
  ) {
    return undefined
  }
  return (normalized + sep).normalize('NFC')
}

/**
 * Direct override for the full auto-memory directory path via env var.
 * When set, getAutoMemPath()/getAutoMemEntrypoint() return this path directly
 * instead of computing `{base}/projects/{sanitized-cwd}/memory/`.
 */
function getAutoMemPathOverride(): string | undefined {
  return validateMemoryPath(
    process.env.duya_MEMORY_PATH_OVERRIDE,
    false,
  )
}

/**
 * Check if duya_MEMORY_PATH_OVERRIDE is set to a valid override.
 * Use this as a signal that the SDK caller has explicitly opted into
 * the auto-memory mechanics.
 */
export function hasAutoMemPathOverride(): boolean {
  return getAutoMemPathOverride() !== undefined
}

/**
 * Returns the project root for memory directory naming.
 * Uses process.cwd() as fallback.
 */
function getAutoMemBase(): string {
  return process.cwd() || homedir()
}

/**
 * Sanitize a path segment for use in directory names.
 * Removes or replaces characters that could be problematic in paths.
 */
function sanitizePathSegment(segment: string): string {
  return segment
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\0/g, '')
    .slice(0, 100)
}

/**
 * Returns the auto-memory directory path.
 *
 * Resolution order:
 *   1. duya_MEMORY_PATH_OVERRIDE env var (full-path override)
 *   2. <memoryBase>/projects/<sanitized-project-root>/memory/
 *      where memoryBase is resolved by getMemoryBaseDir()
 */
export const getAutoMemPath = memoize(
  (): string => {
    const override = getAutoMemPathOverride()
    if (override) {
      return override
    }
    const projectsDir = join(getMemoryBaseDir(), 'projects')
    const sanitizedBase = sanitizePathSegment(getAutoMemBase())
    const path = join(projectsDir, sanitizedBase, AUTO_MEM_DIRNAME) + sep
    return path.normalize('NFC')
  },
  () => getAutoMemBase(),
)

/**
 * Returns the daily log file path for the given date (defaults to today).
 * Shape: <autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md
 */
export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  const yyyy = date.getFullYear().toString()
  const mm = (date.getMonth() + 1).toString().padStart(2, '0')
  const dd = date.getDate().toString().padStart(2, '0')
  return join(getAutoMemPath(), 'logs', yyyy, mm, `${yyyy}-${mm}-${dd}.md`)
}

/**
 * Returns the auto-memory entrypoint (MEMORY.md inside the auto-memory dir).
 * Follows the same resolution order as getAutoMemPath().
 */
export function getAutoMemEntrypoint(): string {
  return join(getAutoMemPath(), AUTO_MEM_ENTRYPOINT_NAME)
}

/**
 * Check if an absolute path is within the auto-memory directory.
 */
export function isAutoMemPath(absolutePath: string): boolean {
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getAutoMemPath())
}
