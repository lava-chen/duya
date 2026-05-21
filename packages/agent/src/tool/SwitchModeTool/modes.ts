/**
 * Mode configurations for SwitchModeTool
 * Defines tool permissions and behaviors for each agent mode
 */

import type { AgentMode } from './constants.js'

// Tools that are disabled in read-only modes
const READONLY_MODE_BANNED_TOOLS = new Set([
  'Write',
  'Edit',
  'touch',
  'rm',
  'mv',
  'cp',
  'mkdir',
  'Task',
])

// Tools that are always allowed
const ALWAYS_ALLOWED_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'Bash', // Bash is allowed but limited to read-only commands in read-only modes
  'Agent',
  'ListMcpResources',
  'ReadMcpResource',
  'WebSearch',
  'WebFetch',
  'Task', // Unified task tool with actions: create, get, list, update, output, stop
  'EnterPlanMode',
  'ExitPlanMode',
  'SwitchMode',
  'EnterWorktree',
  'ExitWorktree',
  'Brief',
  'Browser',
  'SessionSearch',
  'Config',
  'DuyaInfo',
  'DuyaConfig',
  'DuyaRestart',
  'DuyaHealth',
  'DuyaSessions',
  'DuyaLogs',
  'Skill',
  'Vision',
])

export interface ModeConfig {
  /** Whether this mode is read-only */
  readOnly: boolean
  /** Tools explicitly banned in this mode */
  bannedTools: Set<string>
  /** Additional system prompt instructions for this mode */
  systemPromptSuffix: string
}

export const MODE_CONFIGS: Record<AgentMode, ModeConfig> = {
  general: {
    readOnly: false,
    bannedTools: new Set(),
    systemPromptSuffix: '',
  },
  plan: {
    readOnly: true,
    bannedTools: READONLY_MODE_BANNED_TOOLS,
    systemPromptSuffix: `

=== CRITICAL: READ-ONLY MODE ===
You are in PLAN mode. You are STRICTLY PROHIBITED from:
- Creating or modifying files (no Write, Edit, touch, mkdir)
- Deleting files (no rm)
- Moving or copying files (no mv, cp)

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. Use Task tool with action "create" to plan your work.`,
  },
  explore: {
    readOnly: true,
    bannedTools: READONLY_MODE_BANNED_TOOLS,
    systemPromptSuffix: `

=== CRITICAL: READ-ONLY MODE ===
You are in EXPLORE mode. You are STRICTLY PROHIBITED from:
- Creating or modifying files (no Write, Edit, touch, mkdir)
- Deleting files (no rm)
- Moving or copying files (no mv, cp)

Your role is EXCLUSIVELY to explore and search the codebase. Be thorough and efficient.`,
  },
  verify: {
    readOnly: true,
    bannedTools: READONLY_MODE_BANNED_TOOLS,
    systemPromptSuffix: `

=== CRITICAL: READ-ONLY MODE ===
You are in VERIFY mode. You are STRICTLY PROHIBITED from:
- Creating or modifying files (no Write, Edit, touch, mkdir)
- Deleting files (no rm)
- Moving or copying files (no mv, cp)

Your role is EXCLUSIVELY to verify implementation correctness. Run tests, check outputs, and try to break things.`,
  },
  'code-review': {
    readOnly: true,
    bannedTools: READONLY_MODE_BANNED_TOOLS,
    systemPromptSuffix: `

=== CRITICAL: READ-ONLY MODE ===
You are in CODE REVIEW mode. You are STRICTLY PROHIBITED from:
- Creating or modifying files (no Write, Edit, touch, mkdir)
- Deleting files (no rm)
- Moving or copying files (no mv, cp)

Your role is EXCLUSIVELY to review code for quality, bugs, security issues, and best practices.`,
  },
}

/**
 * Check if a tool is allowed in a given mode
 */
export function isToolAllowedInMode(toolName: string, mode: AgentMode): boolean {
  const config = MODE_CONFIGS[mode]
  if (!config.readOnly) return true
  if (ALWAYS_ALLOWED_TOOLS.has(toolName)) return true
  if (config.bannedTools.has(toolName)) return false
  return true
}

/**
 * Filter tools based on the current mode
 */
export function filterToolsByMode<T extends { name: string }>(tools: T[], mode: AgentMode): T[] {
  if (mode === 'general') return tools
  return tools.filter(tool => isToolAllowedInMode(tool.name, mode))
}