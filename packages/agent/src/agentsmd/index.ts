/**
 * AGENTS.md System - Public API
 *
 * File-based agent instruction architecture (claude-code style):
 * - Managed: /etc/duya/AGENTS.md - Global system instructions
 * - User: ~/.duya/AGENTS.md - User private global instructions
 * - Project: AGENTS.md, .duya/AGENTS.md, .duya/rules/*.md - Project instructions
 * - Local: AGENTS.local.md - Local private project instructions
 *
 * Usage:
 * ```typescript
 * import { getAgentsMdManager } from './agentsmd/index.js'
 *
 * const manager = getAgentsMdManager()
 * await manager.loadForSession('/path/to/project')
 *
 * // Get prompt for system injection
 * const prompt = manager.buildAgentsMdPrompt()
 * ```
 */

// =============================================================================
// Types
// =============================================================================

export type {
  AgentsFileInfo,
  AgentsMemoryType,
  AgentsMdConfig,
} from './types.js'

export {
  DEFAULT_AGENTS_MD_CONFIG,
  TEXT_FILE_EXTENSIONS,
  MEMORY_INSTRUCTION_PROMPT,
} from './types.js'

// =============================================================================
// Loader
// =============================================================================

export {
  loadAgentsMdFiles,
  buildAgentsMdPrompt,
  isAgentsMdFile,
  getLargeAgentsMdFiles,
  stripHtmlComments,
} from './loader.js'

export type { LoadAgentsMdOptions } from './loader.js'

// =============================================================================
// Manager
// =============================================================================

export {
  AgentsMdManager,
  getAgentsMdManager,
  resetAgentsMdManager,
  createAgentsMdManager,
} from './manager.js'
