/**
 * @deprecated Memdir memory system — NOT ACTIVE.
 *
 * This module was adapted from claude-code-haha's typed memory system
 * (directory-based, one file per memory) but was never wired into the
 * agent's runtime. The active memory system is in `../memory/`.
 *
 * The type definitions (user/feedback/project/reference) have been
 * incorporated into the active system. The remaining code here
 * (prompt templates, directory management, team memory) is retained
 * as reference material for potential future migration.
 *
 * Memory system documentation:
 * - Active: packages/agent/src/memory/
 * - This (reference): packages/agent/src/memdir/
 */

// Memory types and constants
export {
  MEMORY_TYPES,
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  MEMORY_DRIFT_CAVEAT,
  WHEN_TO_ACCESS_SECTION,
  TRUSTING_RECALL_SECTION,
  MEMORY_FRONTMATTER_EXAMPLE,
  parseMemoryType,
} from './memoryTypes.js'
export type { MemoryType } from './memoryTypes.js'

// Memory paths
export {
  isAutoMemoryEnabled,
  getMemoryBaseDir,
  getAutoMemPath,
  getAutoMemDailyLogPath,
  getAutoMemEntrypoint,
  isAutoMemPath,
  hasAutoMemPathOverride,
} from './paths.js'

// Main memory management
export {
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
  truncateEntrypointContent,
  DIR_EXISTS_GUIDANCE,
  DIRS_EXIST_GUIDANCE,
  ensureMemoryDirExists,
  buildMemoryLines,
  buildMemoryPrompt,
  loadMemoryPrompt,
} from './memdir.js'
export type { EntrypointTruncation } from './memdir.js'

// Memory scanning and relevance
export {
  scanMemoryFiles,
  formatMemoryManifest,
} from './memoryScan.js'
export type { MemoryHeader } from './memoryScan.js'

export {
  findRelevantMemories,
} from './findRelevantMemories.js'
export type { RelevantMemory } from './findRelevantMemories.js'

// Memory aging utilities
export {
  memoryAgeDays,
  memoryAge,
  memoryFreshnessText,
  memoryFreshnessNote,
} from './memoryAge.js'

// Team memory (optional feature)
export {
  isTeamMemoryEnabled,
  getTeamMemPath,
  getTeamMemEntrypoint,
  isTeamMemPath,
  isTeamMemFile,
  PathTraversalError,
} from './teamMemPaths.js'

export {
  buildCombinedMemoryPrompt,
} from './teamMemPrompts.js'
