/**
 * Memory System Types
 *
 * File-based memory architecture (hermes-agent style):
 * - Global Memory: ~/.duya/MEMORY.md and ~/.duya/USER.md
 * - Project Memory: {projectPath}/.duya/MEMORY.md
 */

import type { MemoryEntry, MemoryType } from './memoryParser.js'

// Re-export from memoryParser
export type { MemoryEntry, MemoryType } from './memoryParser.js'
export { MEMORY_TYPES, parseMemoryType } from './memoryParser.js'

// =============================================================================
// Character Limits
// =============================================================================

const DEFAULT_CHAR_LIMITS = {
  memory: 2200,
  user: 1375,
  project: 2200,
} as const

export const MEMORY_CHAR_LIMITS = {
  memory: readEnvInt('DUYA_MEMORY_LIMIT', DEFAULT_CHAR_LIMITS.memory),
  user: readEnvInt('DUYA_USER_MEMORY_LIMIT', DEFAULT_CHAR_LIMITS.user),
  project: readEnvInt('DUYA_PROJECT_MEMORY_LIMIT', DEFAULT_CHAR_LIMITS.project),
} as const

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed) || parsed < 100) return fallback
  return parsed
}

export type MemoryTarget = 'global' | 'project'
export type MemorySubtarget = 'memory' | 'user'

// =============================================================================
// Memory Result
// =============================================================================

export interface MemoryToolResult {
  success: boolean
  entries?: MemoryEntry[]
  usage?: string
  error?: string
  message?: string
}

// =============================================================================
// Memory Tool Input
// =============================================================================

export type MemoryAction = 'add' | 'replace' | 'remove' | 'list'

export interface MemoryToolInput {
  action: MemoryAction
  /** 'global' or 'project' memory */
  target?: 'global' | 'project'
  /** For global: 'memory' or 'user'. For project: ignored (always memory) */
  subtarget?: 'memory' | 'user'
  /** Entry summary (short description) */
  summary?: string
  /** Entry content (detailed) */
  content?: string
  /** Memory type: user, feedback, project, reference */
  type?: MemoryType
  /** Text to match for replace/remove */
  oldText?: string
}
