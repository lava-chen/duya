/**
 * Prompt Engineering System - Core Types
 * Provides type safety for system prompt construction with caching support
 */

/**
 * MCP Server connection info for prompt context.
 * Simplified version of the full MCP types.
 */
export interface MCPServerConnection {
  name: string
  instructions?: string
  type?: 'connected' | 'disconnected'
}

// ============================================================
// Tool Name Constants
// ============================================================

export const TOOL_NAMES = {
  BASH: 'Bash',
  READ: 'Read',
  WRITE: 'Write',
  EDIT: 'Edit',
  GLOB: 'Glob',
  GREP: 'Grep',
  AGENT: 'Agent',
  SKILL: 'Skill',
  TASK_CREATE: 'TaskCreate',
  TASK_UPDATE: 'TaskUpdate',
  TASK_GET: 'TaskGet',
  TASK_LIST: 'TaskList',
  TASK_STOP: 'TaskStop',
  TASK_OUTPUT: 'TaskOutput',
  TODO_WRITE: 'TodoWrite',
  ASK_USER_QUESTION: 'AskUserQuestion',
  DISCOVER_SKILLS: 'DiscoverSkills',
  SLEEP: 'Sleep',
} as const

// ============================================================
// Model Constants
// ============================================================

export const MODEL_CONSTANTS = {
  // Provider-neutral frontier model reference
  FRONTIER_MODEL_NAME: 'Claude Opus 4.6',

  // Claude models
  CLAUDE_4_5_OR_4_6_MODEL_IDS: {
    opus: 'claude-opus-4-6',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5-20251001',
  },

  // OpenAI models
  OPENAI_MODEL_IDS: {
    gpt4o: 'gpt-4o',
    gpt4oMini: 'gpt-4o-mini',
    gpt45: 'gpt-4.5',
    o1: 'o1',
    o3Mini: 'o3-mini',
  },

  // Google Gemini models
  GEMINI_MODEL_IDS: {
    pro15: 'gemini-1.5-pro',
    flash15: 'gemini-1.5-flash',
    pro25: 'gemini-2.5-pro',
    flash25: 'gemini-2.5-flash',
  },

  // DeepSeek models
  DEEPSEEK_MODEL_IDS: {
    v3: 'deepseek-v3',
    r1: 'deepseek-r1',
  },

  // Qwen models
  QWEN_MODEL_IDS: {
    max: 'qwen-max',
    plus: 'qwen-plus',
    turbo: 'qwen-turbo',
    coder: 'qwen-coder',
  },
} as const

// ============================================================
// SystemPrompt Branded Type
// ============================================================

/**
 * Branded type for system prompt arrays.
 * Prevents accidental mixing of regular string[] with SystemPrompt.
 *
 * Usage:
 * ```typescript
 * const prompt = asSystemPrompt(['line 1', 'line 2'])
 * ```
 */
export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

/**
 * Cast a readonly string[] to SystemPrompt type.
 * Use this when building system prompts to maintain type safety.
 */
export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}

// ============================================================
// Prompt Section Types
// ============================================================

/**
 * A single section of the system prompt.
 * Sections can be cached (static) or volatile (dynamic).
 */
export interface PromptSection {
  /** Unique identifier for this section */
  name: string
  /** Function to compute the section content. Returns null if section should be omitted. */
  compute: () => string | null | Promise<string | null>
  /**
   * If true, this section recomputes every turn and will break prompt caching.
   * Use for dynamic content like environment info, MCP instructions, etc.
   */
  volatile: boolean
  /** Optional description for debugging */
  description?: string
}

/**
 * A resolved (computed) prompt section with its content.
 */
export interface ResolvedPromptSection {
  name: string
  content: string | null
  volatile: boolean
}

// ============================================================
// Prompt Context
// ============================================================

/**
 * Communication platform types for prompt injection
 */
export type CommunicationPlatform =
  | 'cli'
  | 'duya-app'
  | 'weixin'
  | 'feishu'
  | 'telegram'
  | 'qq'
  | 'web'
  | 'api'

/**
 * Context information passed to section compute functions.
 * Contains all the runtime information needed to build dynamic sections.
 */
export interface PromptContext {
  /** Current working directory */
  workingDirectory: string
  /** Additional working directories */
  additionalWorkingDirectories?: string[]
  /** Operating system platform (win32, darwin, linux) */
  platform: string
  /** Shell name (bash, zsh, pwsh, etc.) */
  shell: string
  /** OS version string */
  osVersion?: string
  /** Model ID being used */
  modelId: string
  /** Marketing name for the model */
  modelName?: string
  /** Knowledge cutoff date for the model */
  knowledgeCutoff?: string
  /** Set of enabled tool names */
  enabledTools: Set<string>
  /** Connected MCP servers with their instructions */
  mcpServers?: MCPServerConnection[]
  /** Session start timestamp */
  sessionStartTime: number
  /** Language preference for responses */
  language?: string
  /** Whether this is a git worktree */
  isWorktree?: boolean
  /** Whether this is a non-interactive session */
  isNonInteractiveSession?: boolean
  /** Whether REPL mode is enabled */
  isReplModeEnabled?: boolean
  /** Whether embedded search tools are available */
  hasEmbeddedSearchTools?: boolean
  /** Whether fork subagent is enabled */
  isForkSubagentEnabled?: boolean
  /** Whether verification agent is enabled */
  isVerificationAgentEnabled?: boolean
  /** Whether skill search is enabled */
  isSkillSearchEnabled?: boolean
  /** Scratchpad directory path */
  scratchpadDir?: string
  /** User type (for conditional prompt sections) */
  userType?: 'ant' | 'external'
  /** Output style configuration */
  outputStyleConfig?: OutputStyleConfig | null
  /** Communication platform type (cli, duya-app, weixin, feishu, web, api) */
  communicationPlatform?: CommunicationPlatform
}

// ============================================================
// Output Style Configuration
// ============================================================

/**
 * Configuration for custom output styles.
 * Allows users to define how the agent should respond.
 */
export interface OutputStyleConfig {
  /** Name of the output style */
  name: string
  /** The prompt that defines this output style */
  prompt: string
  /** Whether to keep coding instructions in the prompt */
  keepCodingInstructions?: boolean
}

// ============================================================
// Feature Flags
// ============================================================

/**
 * Feature flags for controlling prompt behavior.
 * These allow enabling/disabling certain prompt sections without code changes.
 */
export interface PromptFeatureFlags {
  /** Enable detailed task decomposition guidance */
  taskDecomposition?: boolean
  /** Enable safety confirmation prompts for risky actions */
  safetyConfirmations?: boolean
  /** Enable verbose output style */
  verboseOutput?: boolean
  /** Enable memory/memdir integration */
  memoryIntegration?: boolean
  /** Enable scratchpad directory support */
  scratchpad?: boolean
  /** Enable proactive/autonomous mode */
  proactive?: boolean
  /** Enable token budget display */
  tokenBudget?: boolean
  /** Enable verification agent */
  verificationAgent?: boolean
  /** Enable skill search */
  skillSearch?: boolean
  /** Enable fork subagent */
  forkSubagent?: boolean
  /** Enable numeric length anchors */
  numericLengthAnchors?: boolean
}

// ============================================================
// Tool Prompt Contributions
// ============================================================

/**
 * A tool's contribution to the system prompt.
 * Each tool can provide usage guidance, cautions, and examples.
 */
export interface ToolPromptContribution {
  /** The tool name this contribution is for */
  toolName: string
  /** Additional instructions for how to use this tool effectively */
  usageGuidance?: string
  /** Precautions or warnings when using this tool */
  cautions?: string[]
  /** Example usage patterns */
  examples?: string[]
  /** When to prefer this tool over alternatives */
  preferOver?: string[]
}

// ============================================================
// Prompt Manager Options
// ============================================================

/**
 * Options for creating a PromptManager instance.
 */
export interface PromptManagerOptions {
  /** Default working directory for the agent */
  workingDirectory?: string
  /** Additional working directories */
  additionalWorkingDirectories?: string[]
  /** Model ID being used (for system prompt context) */
  modelId?: string
  /** Feature flags to control prompt behavior */
  features?: PromptFeatureFlags
  /** Custom section registry for additional prompt sections */
  customSections?: PromptSection[]
  /** Output style configuration */
  outputStyleConfig?: OutputStyleConfig | null
  /** Language preference */
  language?: string
  /** User type (for conditional prompt sections) */
  userType?: 'ant' | 'external'
  /** Communication platform type */
  communicationPlatform?: CommunicationPlatform
  /** Prompt profile: base + overlays for progressive disclosure */
  promptProfile?: import('./modes/types.js').PromptProfile
}

// ============================================================
// Constants
// ============================================================

/**
 * Boundary marker separating static (cacheable) content from dynamic content.
 * Everything BEFORE this marker can use persistent caching.
 * Everything AFTER contains session-specific content.
 *
 * Note: This is a string that should appear in the prompt array. The actual
 * splitting for cache optimization happens at the API layer.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

/**
 * Default system prompt used when no custom prompt is provided.
 */
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant.'

/**
 * Cyber risk instruction for intro section.
 */
export const CYBER_RISK_INSTRUCTION = `Cybersecurity is a critical concern for the user. You must not introduce vulnerabilities, expose secrets, or facilitate attacks. Always follow security best practices.`

/**
 * Knowledge cutoff dates for different models.
 * Based on official documentation and model release information.
 */
export const KNOWLEDGE_CUTOFFS: Record<string, string> = {
  // Claude models
  'claude-sonnet-4-6': 'August 2025',
  'claude-opus-4-6': 'May 2025',
  'claude-opus-4-5': 'May 2025',
  'claude-haiku-4': 'February 2025',
  'claude-opus-4': 'January 2025',
  'claude-sonnet-4': 'January 2025',

  // OpenAI models
  'gpt-4o': 'October 2023',
  'gpt-4o-mini': 'October 2023',
  'gpt-4.5': 'October 2023',
  'o1': 'October 2023',
  'o3-mini': 'October 2023',
  'o4-mini': 'May 2025',

  // Google Gemini models
  'gemini-2.5': 'January 2025',
  'gemini-1.5-pro': 'November 2023',
  'gemini-1.5-flash': 'November 2023',
  'gemini-1.5': 'November 2023',

  // DeepSeek models
  'deepseek-v3': 'December 2024',
  'deepseek-r1': 'December 2024',
  'deepseek': 'December 2024',

  // Qwen models
  'qwen-max': 'April 2025',
  'qwen-plus': 'April 2025',
  'qwen-turbo': 'April 2025',
  'qwen-coder': 'April 2025',
  'qwen': 'April 2025',

  // MiniMax models
  'minimax': 'March 2025',

  // Kimi models
  'moonshot': 'March 2025',
  'kimi': 'March 2025',

  // Zhipu GLM models
  'glm-5': 'April 2025',
  'glm-4': 'January 2025',
  'glm': 'April 2025',
}
