/**
 * @deprecated Memory Renderer — unused in active system.
 *
 * Helper functions for reading project MEMORY.md files directly.
 * Superseded by FileMemoryStore which provides full CRUD + snapshot support.
 * Retained for reference.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { scanMemoryContentForPrompt } from './scanner.js'

// =============================================================================
// Project Memory Config
// =============================================================================

const PROJECT_MEMORY_FILENAME = 'MEMORY.md'
const PROJECT_MEMORY_DIR = '.duya'
const MAX_PROJECT_MEMORY_SIZE = 10 * 1024 // 10KB

// =============================================================================
// Project Memory Helpers
// =============================================================================

/**
 * Get the path to the project memory file for a given project.
 */
export function getProjectMemoryPath(projectPath: string): string {
  return join(projectPath, PROJECT_MEMORY_DIR, PROJECT_MEMORY_FILENAME)
}

/**
 * Read raw project memory content (without scanning).
 * Used for the memory tool to read/edit the file.
 */
export function readProjectMemory(projectPath: string): string | null {
  const filePath = getProjectMemoryPath(projectPath)
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Render project memory file as a formatted system prompt block.
 * Returns empty string if file doesn't exist or is empty.
 */
export function renderProjectMemoryBlock(projectPath: string): string {
  const filePath = getProjectMemoryPath(projectPath)

  let content: string
  try {
    const stat = readFileSync(filePath, 'utf-8')
    content = stat
  } catch {
    // File doesn't exist - skip
    return ''
  }

  if (!content.trim()) {
    return ''
  }

  // Check size limit
  if (content.length > MAX_PROJECT_MEMORY_SIZE) {
    content = content.slice(0, MAX_PROJECT_MEMORY_SIZE) +
      `\n\n[TRUNCATED: project memory exceeds ${MAX_PROJECT_MEMORY_SIZE} bytes]`
  }

  // Scan for injection threats
  const blocked = scanMemoryContentForPrompt(content, PROJECT_MEMORY_FILENAME)
  if (blocked) {
    return blocked
  }

  const separator = '═'.repeat(46)
  return [
    separator,
    'PROJECT MEMORY — Context for this project directory',
    separator,
    content.trim(),
    '',
  ].join('\n')
}
