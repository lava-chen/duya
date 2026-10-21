/**
 * Nested AGENTS.md on-demand loader (Plan 408b).
 *
 * Mirrors claude-code-haha's `getNestedMemoryAttachmentsForFile` (Plan 408
 * Phase 6): when a tool touches a file below the session cwd, discover and
 * return the AGENTS.md / `.duya/AGENTS.md` / `.duya/rules/*.md` files on the
 * directory chain between cwd and that file, plus ancestor-chain conditional
 * rules (frontmatter `paths:` globs) matching the touched path.
 *
 * Processing order (must be preserved, cc-haha parity):
 *  1. Ancestor-chain (root → cwd) conditional rules matching the trigger;
 *  2. Nested directories (cwd-exclusive → trigger dir), shallow to deep:
 *     AGENTS.md + unconditional + conditional rules.
 *
 * Dedup is two-level: `processedPaths` guards within one call; the
 * session-level `loadedPaths` set (owned by AgentsMdManager) prevents
 * re-injection across turns.
 */

import * as fs from 'fs'
import * as path from 'path'
import { promisify } from 'util'
import picomatch from 'picomatch'

import type { AgentsFileInfo } from './types.js'
import { DEFAULT_AGENTS_MD_CONFIG } from './types.js'
import { processAgentsFile } from './loader.js'

const readdirAsync = promisify(fs.readdir)

// =============================================================================
// Trigger extraction
// =============================================================================

/** Tools whose inputs carry a filesystem path worth triggering on. */
const TRIGGER_TOOLS = new Set(['read', 'edit', 'write', 'grep', 'glob'])

/**
 * Extract absolute trigger paths from this turn's tool calls.
 * Handles `file_path` (read/edit/write) and `path` (grep/glob directory).
 * Relative paths are resolved against `workingDirectory`. Unrecognized tools
 * and calls without a usable path are skipped.
 */
export function extractTriggerPaths(
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
  workingDirectory: string,
): string[] {
  const paths = new Set<string>()
  for (const call of toolCalls) {
    if (!call || !TRIGGER_TOOLS.has(call.name)) continue
    const input = call.input as Record<string, unknown> | undefined
    if (!input || typeof input !== 'object') continue
    const raw = input.file_path ?? input.path
    if (typeof raw !== 'string' || raw.trim().length === 0) continue
    const resolved = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(workingDirectory, raw)
    paths.add(resolved)
  }
  return [...paths]
}

// =============================================================================
// Path guards
// =============================================================================

function normalizeForDedup(p: string): string {
  const normalized = path.normalize(p)
  // Windows is case-insensitive; lowercase only there to keep POSIX intact.
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isInsideRoot(p: string, root: string): boolean {
  const rel = path.relative(root, p)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function hasForbiddenSegment(p: string): boolean {
  return p.split(/[\\/]/).some(
    (seg) => seg === '.git' || seg === 'node_modules',
  )
}

function sanitizeTriggers(triggerPaths: readonly string[], cwd: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of triggerPaths) {
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw)
    if (!isInsideRoot(abs, cwd)) continue
    if (hasForbiddenSegment(abs)) continue
    const key = normalizeForDedup(abs)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(abs)
  }
  return result
}

// =============================================================================
// Glob matching (conditional rules)
// =============================================================================

/**
 * Match a repo-relative path against `paths:` frontmatter patterns.
 * `parseFrontmatterPaths` strips trailing `/**`, so a pattern like `src`
 * means "src itself and everything inside it" — implement that prefix
 * semantics on top of plain picomatch.
 */
export function matchesGlobs(relPath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false
  if (picomatch([...patterns])(relPath)) return true
  return patterns.some((pattern) => {
    const base = pattern.replace(/\/+$/, '')
    return base.length > 0 && relPath.startsWith(`${base}/`)
  })
}

// =============================================================================
// Discovery
// =============================================================================

export interface NestedLoadContext {
  /** Session cwd (= project root for eager loading). */
  cwd: string
  /** Absolute paths touched by tools this turn. */
  triggerPaths: readonly string[]
  /** Session-level already-injected absolute paths (mutated by this call). */
  loadedPaths: Set<string>
}

async function loadFileIfAny(
  filePath: string,
  processedPaths: Set<string>,
): Promise<AgentsFileInfo[]> {
  try {
    return await processAgentsFile(
      filePath,
      'Project',
      processedPaths,
      DEFAULT_AGENTS_MD_CONFIG,
    )
  } catch {
    return []
  }
}

/**
 * Load every candidate in one directory: AGENTS.md, .duya/AGENTS.md,
 * and markdown files under .duya/rules (recursive). Returns [] silently
 * when none exist.
 */
async function probeDirectory(
  dir: string,
  processedPaths: Set<string>,
): Promise<AgentsFileInfo[]> {
  const files: AgentsFileInfo[] = []
  files.push(...(await loadFileIfAny(path.join(dir, 'AGENTS.md'), processedPaths)))
  files.push(
    ...(await loadFileIfAny(path.join(dir, '.duya', 'AGENTS.md'), processedPaths)),
  )

  const rulesDir = path.join(dir, '.duya', 'rules')
  try {
    const entries = await readdirAsync(rulesDir, {
      withFileTypes: true,
      recursive: true,
    })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const entryParent =
        'parentPath' in entry
          ? (entry as fs.Dirent & { parentPath: string }).parentPath
          : (entry as unknown as { path: string }).path
      const entryAbs = path.join(entryParent ?? rulesDir, entry.name)
      files.push(...(await loadFileIfAny(entryAbs, processedPaths)))
    }
  } catch {
    // No rules directory — expected in most projects.
  }

  return files
}

/** Directory chain strictly below cwd, shallow → deep, ending at trigger dir. */
function nestedDirChain(triggerDir: string, cwd: string): string[] {
  const chain: string[] = []
  let current = triggerDir
  while (current !== cwd && isInsideRoot(current, cwd)) {
    chain.push(current)
    current = path.dirname(current)
  }
  return chain.reverse()
}

/**
 * Discover nested memory files for this turn's triggers. Returns only the
 * delta not yet present in `ctx.loadedPaths`; every returned file path (and
 * its @include children) is added to the set before returning.
 */
export async function collectNestedMemoryFiles(
  ctx: NestedLoadContext,
): Promise<AgentsFileInfo[]> {
  const cwd = path.resolve(ctx.cwd)
  const triggers = sanitizeTriggers(ctx.triggerPaths, cwd)
  if (triggers.length === 0) return []

  const processedPaths = new Set<string>()
  const result: AgentsFileInfo[] = []

  const pushUnique = (files: AgentsFileInfo[]): void => {
    for (const file of files) {
      const key = normalizeForDedup(file.path)
      if (ctx.loadedPaths.has(key)) {
        processedPaths.add(key) // already surfaced earlier in the session
        continue
      }
      ctx.loadedPaths.add(key)
      result.push(file)
    }
  }

  // Phase 1: ancestor-chain conditional rules (root → cwd inclusive).
  const ancestors: AgentsFileInfo[] = []
  let dir = cwd
  while (dir !== path.parse(dir).root && dir !== '') {
    ancestors.push(...(await loadFileIfAny(path.join(dir, 'AGENTS.md'), processedPaths)))
    ancestors.push(
      ...(await loadFileIfAny(path.join(dir, '.duya', 'AGENTS.md'), processedPaths)),
    )
    dir = path.dirname(dir)
  }

  for (const trigger of triggers) {
    const rel = path.relative(cwd, trigger).replace(/\\/g, '/')
    for (const file of ancestors) {
      if (file.globs && matchesGlobs(rel, file.globs)) {
        pushUnique([file])
      }
    }
  }

  // Phase 2: nested directories per trigger (shallow → deep).
  for (const trigger of triggers) {
    const chain = nestedDirChain(path.dirname(trigger), cwd)
    for (const nestedDir of chain) {
      pushUnique(await probeDirectory(nestedDir, processedPaths))
    }
  }

  return result
}
