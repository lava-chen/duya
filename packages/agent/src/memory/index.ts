/**
 * Memory System - Public API
 *
 * File-based memory architecture (hermes-agent style):
 * - Global Memory: ~/.duya/MEMORY.md and ~/.duya/USER.md
 * - Project Memory: {projectPath}/.duya/MEMORY.md
 */

// Types
export * from './types.js'

// Entry Parser
export {
  parseEntries,
  serializeEntry,
  serializeEntries,
  appendEntry,
  removeEntry,
  replaceEntry,
  findEntryIndex,
  formatUsage,
} from './memoryParser.js'

export type { MemoryEntry } from './memoryParser.js'

// File Store
export { FileMemoryStore } from './FileMemoryStore.js'

// Scanner
export { scanMemoryContent, scanMemoryContentForPrompt, MemoryScanError } from './scanner.js'

// Manager
export { MemoryManager, getMemoryManager, resetMemoryManager } from './manager.js'

// Tool
export { MemoryTool, getMemoryTool } from './tool.js'
