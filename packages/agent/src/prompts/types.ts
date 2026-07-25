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
  POWERSHELL: 'PowerShell',
  READ: 'Read',
  WRITE: 'Write',
  EDIT: 'Edit',
  GLOB: 'Glob',
  GREP: 'Grep',
  SUBAGENT: 'Agent', // wire name kept as 'Agent' for backward compat — see packages/agent/src/tool/SubagentTool/constants.ts
  SKILL: 'Skill',
  TASK: 'Task', // Unified task tool with actions: create, get, list, update, output, stop
  TODO_WRITE: 'TodoWrite',
  ASK_USER_QUESTION: 'AskUserQuestion',
  DISCOVER_SKILLS: 'DiscoverSkills',
  SESSION_SEARCH: 'SessionSearch',
  MESSAGE_SESSION: 'MessageSession',
  SLEEP: 'Sleep',
  VISION: 'vision_analyze',
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
  /** Current chat session ID */
  sessionId?: string
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
  /** System locale/timezone from the user's machine (via IPC) or subprocess fallback. */
  location?: {
    locale: string
    localeCountryCode: string | null
    timezone: string
  }
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
  /** Optional research task intent for research prompt assembly */
  researchIntent?: import('./research/types.js').ResearchTaskIntent
  /** Optional research project ID */
  researchProjectId?: string
  /** Whether project references section is enabled */
  referencesEnabled?: boolean
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
  /** Current chat session ID */
  sessionId?: string
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
  /** Whether this is a git worktree */
  isWorktree?: boolean
  /** Whether this is a non-interactive session */
  isNonInteractiveSession?: boolean
  /** Whether REPL mode is enabled */
  isReplModeEnabled?: boolean
  /** Whether embedded search tools (find/grep) are available */
  hasEmbeddedSearchTools?: boolean
  /** Whether fork subagent is enabled */
  isForkSubagentEnabled?: boolean
  /** Whether verification agent is enabled */
  isVerificationAgentEnabled?: boolean
  /** Whether skill search is enabled */
  isSkillSearchEnabled?: boolean
  /** Scratchpad directory path */
  scratchpadDir?: string
}

// ============================================================
// Prompt Build Context Options
// ============================================================

/**
 * Options for building a PromptContext.
 * Used by PromptSystem.buildContext() to create the context for each turn.
 */
export interface PromptBuildContextOptions {
  sessionId?: string
  workingDirectory?: string
  additionalWorkingDirectories?: string[]
  modelId?: string
  modelName?: string
  enabledTools?: Set<string>
  mcpServers?: PromptContext['mcpServers']
  language?: string
  userType?: 'ant' | 'external'
  outputStyleConfig?: OutputStyleConfig | null
  communicationPlatform?: CommunicationPlatform
  isWorktree?: boolean
  isNonInteractiveSession?: boolean
  isReplModeEnabled?: boolean
  hasEmbeddedSearchTools?: boolean
  isForkSubagentEnabled?: boolean
  isVerificationAgentEnabled?: boolean
  isSkillSearchEnabled?: boolean
  scratchpadDir?: string
  researchIntent?: import('./research/types.js').ResearchTaskIntent
  researchProjectId?: string
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
 * Models' reliable knowledge cutoff dates.
 *
 * Format:
 * - YYYY-MM-DD: vendor disclosed an exact date
 * - YYYY-MM: vendor only disclosed a month
 * - null: not disclosed, alias is rolling, or otherwise not reliable
 */
export type KnowledgeCutoff = string | null

/**
 * Exact IDs and models that need special handling.
 *
 * It is not advisable to guess cutoffs for rolling aliases:
 * deepseek-chat, qwen-plus, kimi, etc. can swap underlying models without
 * renaming.
 */
export const KNOWLEDGE_CUTOFFS = {
  // ---------------------------------------------------------------------------
  // Anthropic Claude
  // ---------------------------------------------------------------------------

  'claude-fable-5': '2026-01',
  'claude-mythos-5': '2026-01',
  'claude-opus-4-8': '2026-01',
  'claude-opus-4-7': '2026-01',
  'claude-sonnet-5': '2026-01',

  'claude-opus-4-6': '2025-05',
  'claude-sonnet-4-6': '2025-05',
  'claude-opus-4-5': '2025-05',
  'claude-haiku-4-5': '2025-02',
  'claude-sonnet-4-5': '2025-01',

  'claude-opus-4-1': '2025-01',
  'claude-opus-4': '2025-01',
  'claude-sonnet-4': '2025-01',

  // Unofficial compat aliases. Some aggregators may name models this way.
  'claude-haiku-4': '2025-02',

  // ---------------------------------------------------------------------------
  // OpenAI GPT / o-series
  // ---------------------------------------------------------------------------

  'gpt-5.6': '2026-02-16',
  'gpt-5.6-sol': '2026-02-16',
  'gpt-5.6-terra': '2026-02-16',
  'gpt-5.6-luna': '2026-02-16',

  'gpt-5.5': '2025-12-01',

  'gpt-5.4': '2025-08-31',
  'gpt-5.4-pro': '2025-08-31',
  'gpt-5.4-mini': '2025-08-31',
  'gpt-5.4-nano': '2025-08-31',

  'gpt-5.3-codex': '2025-08-31',

  'gpt-5.2': '2025-08-31',
  'gpt-5.2-pro': '2025-08-31',
  'gpt-5.2-codex': '2025-08-31',
  'gpt-5.2-chat-latest': '2025-08-31',

  'gpt-5.1': '2024-09-30',
  'gpt-5.1-chat-latest': '2024-09-30',
  'gpt-5.1-codex': '2024-09-30',
  'gpt-5.1-codex-mini': '2024-09-30',
  'gpt-5.1-codex-max': '2024-09-30',

  'gpt-5': '2024-09-30',
  'gpt-5-codex': '2024-09-30',
  'gpt-5-mini': '2024-05-31',
  'gpt-5-nano': '2024-05-31',

  'gpt-4.1': '2024-06-01',
  'gpt-4.1-mini': '2024-06-01',
  'gpt-4.1-nano': '2024-06-01',

  o3: '2024-06-01',
  'o3-pro': '2024-06-01',
  'o3-deep-research': '2024-06-01',

  'o4-mini': '2024-06-01',
  'o4-mini-deep-research': '2024-06-01',

  'o3-mini': '2023-10-01',

  o1: '2023-10-01',
  'o1-pro': '2023-10-01',
  'o1-mini': '2023-10-01',

  'gpt-4o': '2023-10-01',
  'gpt-4o-mini': '2023-10-01',
  'chatgpt-4o-latest': '2023-10-01',
  'gpt-4.5': '2023-10-01',
  'gpt-4': '2023-12-01',

  // When the official cutoff is not clearly disclosed, do not pass off the
  // release date as the knowledge cutoff.
  'gpt-oss-120b': null,
  'gpt-oss-20b': null,

  // ---------------------------------------------------------------------------
  // Google Gemini
  // ---------------------------------------------------------------------------

  'gemini-3.5-flash': '2025-01',

  'gemini-3.1-pro': '2025-01',
  'gemini-3.1-pro-preview': '2025-01',
  'gemini-3.1-flash': '2025-01',
  'gemini-3.1-flash-live-preview': '2025-01',
  'gemini-3.1-flash-lite': '2025-01',
  'gemini-3.1-flash-lite-image': '2025-01',

  'gemini-3-pro': '2025-01',
  'gemini-3-pro-preview': '2025-01',
  'gemini-3-flash': '2025-01',

  'gemini-2.5-pro': '2025-01',
  'gemini-2.5-flash': '2025-01',
  'gemini-2.5-flash-lite': '2025-01',

  // Image models are an exception: Google disclosed a cutoff of 2025-06.
  'gemini-2.5-flash-image': '2025-06',

  'gemini-2.0-pro': '2024-08',
  'gemini-2.0-flash': '2024-08',
  'gemini-2.0-flash-lite': '2024-08',

  'gemini-1.5-pro': '2023-11',
  'gemini-1.5-flash': '2023-11',
  'gemini-1.5': '2023-11',

  // ---------------------------------------------------------------------------
  // xAI Grok
  // ---------------------------------------------------------------------------

  'grok-4.5': '2026-02-01',
  'grok-4.5-latest': '2026-02-01',

  'grok-4': '2024-11',
  'grok-4-latest': '2024-11',
  'grok-4-fast': '2024-11',

  'grok-3': '2024-11',
  'grok-3-latest': '2024-11',
  'grok-3-mini': '2024-11',

  // Newer model IDs should not silently inherit Grok 4's old date.
  'grok-4.20': null,
  'grok-code-fast-1': null,

  // ---------------------------------------------------------------------------
  // DeepSeek
  // ---------------------------------------------------------------------------

  // Current production IDs, but DeepSeek has not stably disclosed cutoffs
  // suitable for engineering judgement.
  'deepseek-v4-pro': null,
  'deepseek-v4-flash': null,
  'deepseek-v3.2': null,
  'deepseek-v3.2-speciale': null,
  'deepseek-v3.1': null,
  'deepseek-v3': null,
  'deepseek-r1': null,
  'deepseek-r1-0528': null,

  // Rolling aliases whose underlying model can change.
  'deepseek-chat': null,
  'deepseek-reasoner': null,
  'deepseek-coder': null,
  deepseek: null,

  // ---------------------------------------------------------------------------
  // Alibaba Qwen
  // ---------------------------------------------------------------------------

  'qwen3.7-max': null,
  'qwen3.7-plus': null,
  'qwen3.6-plus': null,
  'qwen3.6-35b-a3b': null,
  'qwen3.5-397b-a17b': null,
  'qwen3.5-122b-a10b': null,
  'qwen3.5-35b-a3b': null,
  'qwen3.5-27b': null,

  'qwen3-max': null,
  'qwen3-plus': null,
  'qwen3-coder': null,
  'qwen3-235b-a22b': null,
  'qwen3-32b': null,
  'qwen3-30b-a3b': null,
  'qwen3-14b': null,
  'qwen3-8b': null,

  'qwen-max': null,
  'qwen-plus': null,
  'qwen-turbo': null,
  'qwen-flash': null,
  'qwen-long': null,
  'qwen-coder': null,
  qwen: null,
  qwq: null,
  qvq: null,

  // ---------------------------------------------------------------------------
  // MiniMax
  // ---------------------------------------------------------------------------

  'minimax-m3': null,
  'minimax-m2.7': null,
  'minimax-m2.7-highspeed': null,
  'minimax-m2.5': null,
  'minimax-m2.5-highspeed': null,
  'minimax-m2.1': null,
  'minimax-m2.1-highspeed': null,
  'minimax-m2': null,
  minimax: null,

  // ---------------------------------------------------------------------------
  // Moonshot / Kimi
  // ---------------------------------------------------------------------------

  'kimi-k3': null,
  'kimi-k2.7-code': null,
  'kimi-k2.7-code-highspeed': null,
  'kimi-k2.6': null,
  'kimi-k2.5': null,
  'kimi-k2-thinking': null,
  'kimi-k2-thinking-turbo': null,
  'kimi-k2-0905-preview': null,
  'kimi-k2-turbo-preview': null,

  'moonshot-v1-8k': null,
  'moonshot-v1-32k': null,
  'moonshot-v1-128k': null,
  moonshot: null,
  kimi: null,

  // ---------------------------------------------------------------------------
  // Zhipu / Z.ai GLM
  // ---------------------------------------------------------------------------

  'glm-5.1': null,
  'glm-5': null,
  'glm-4.7': null,
  'glm-4.6': null,
  'glm-4.5': null,
  'glm-4-plus': null,
  'glm-4-air': null,
  'glm-4-flash': null,
  'glm-4-long': null,
  'glm-4': null,
  glm: null,

  // ---------------------------------------------------------------------------
  // Other major providers and open model families
  // ---------------------------------------------------------------------------

  // Mistral
  'mistral-large': null,
  'mistral-medium': null,
  'mistral-small': null,
  'mistral-nemo': null,
  'mistral-saba': null,
  codestral: null,
  'codestral-latest': null,
  'magistral-medium': null,
  'magistral-small': null,

  // Meta
  'llama-4-maverick': null,
  'llama-4-scout': null,
  'llama-3.3-70b-instruct': null,
  'llama-3.2-90b-vision-instruct': null,
  'llama-3.1-405b-instruct': null,

  // Google open models
  'gemma-3': null,
  'gemma-3n': null,
  codegemma: null,

  // Cohere
  'command-a': null,
  'command-r': null,
  'command-r-plus': null,
  'command-r7b': null,

  // Amazon
  'amazon-nova-premier': null,
  'amazon-nova-pro': null,
  'amazon-nova-lite': null,
  'amazon-nova-micro': null,

  // AI21
  'jamba-1.5-large': null,
  'jamba-1.5-mini': null,

  // Perplexity
  sonar: null,
  'sonar-pro': null,
  'sonar-reasoning': null,
  'sonar-reasoning-pro': null,
  'sonar-deep-research': null,

  // NVIDIA
  'nemotron-ultra': null,
  'nemotron-super': null,
  'nemotron-nano': null,

  // Other Chinese model families
  ernie: null,
  doubao: null,
  hunyuan: null,
  baichuan: null,
  'yi-large': null,
  'step-2': null,
} as const satisfies Readonly<Record<string, KnowledgeCutoff>>

type KnowledgeCutoffRule = readonly [
  pattern: RegExp,
  cutoff: KnowledgeCutoff,
]

/**
 * Rules used to recognise:
 * - dated snapshots, e.g. gpt-5.2-2025-12-11
 * - preview IDs, e.g. gemini-2.5-flash-preview-09-2025
 * - Claude date suffixes, e.g. claude-haiku-4-5-20251001
 * - extension suffixes added by aggregator platforms
 *
 * Order must go from specific to broad.
 */
const KNOWLEDGE_CUTOFF_RULES: readonly KnowledgeCutoffRule[] = [
  // Anthropic
  [/^claude-(?:fable|mythos)-5(?:-|$)/, '2026-01'],
  [/^claude-opus-4-8(?:-|$)/, '2026-01'],
  [/^claude-opus-4-7(?:-|$)/, '2026-01'],
  [/^claude-sonnet-5(?:-|$)/, '2026-01'],
  [/^claude-(?:opus|sonnet)-4-6(?:-|$)/, '2025-05'],
  [/^claude-opus-4-5(?:-|$)/, '2025-05'],
  [/^claude-haiku-4-5(?:-|$)/, '2025-02'],
  [/^claude-sonnet-4-5(?:-|$)/, '2025-01'],
  [/^claude-(?:opus-4-1|opus-4|sonnet-4)(?:-|$)/, '2025-01'],

  // OpenAI
  [/^gpt-5\.6(?:-|$)/, '2026-02-16'],
  [/^gpt-5\.5(?:-|$)/, '2025-12-01'],
  [/^gpt-5\.4(?:-|$)/, '2025-08-31'],
  [/^gpt-5\.3-codex(?:-|$)/, '2025-08-31'],
  [/^gpt-5\.2(?:-|$)/, '2025-08-31'],
  [/^gpt-5\.1(?:-|$)/, '2024-09-30'],

  // mini/nano MUST come before the broad GPT-5 rule.
  [/^gpt-5-(?:mini|nano)(?:-|$)/, '2024-05-31'],
  [/^gpt-5(?:-codex)?(?:-\d{4}-\d{2}-\d{2})?$/, '2024-09-30'],

  [/^gpt-4\.1(?:-|$)/, '2024-06-01'],
  [/^o3-mini(?:-|$)/, '2023-10-01'],
  [/^o3(?:-|$)/, '2024-06-01'],
  [/^o4-mini(?:-|$)/, '2024-06-01'],
  [/^o1(?:-|$)/, '2023-10-01'],
  [/^(?:gpt-4o|chatgpt-4o)(?:-|$)/, '2023-10-01'],
  [/^gpt-4\.5(?:-|$)/, '2023-10-01'],

  // Gemini: the image exception must precede the general Gemini 2.5 rule.
  [/^gemini-2\.5-flash-image(?:-|$)/, '2025-06'],
  [/^gemini-3\.5(?:-|$)/, '2025-01'],
  [/^gemini-3\.1(?:-|$)/, '2025-01'],
  [/^gemini-3(?:-|$)/, '2025-01'],
  [/^gemini-2\.5(?:-|$)/, '2025-01'],
  [/^gemini-2\.0(?:-|$)/, '2024-08'],
  [/^gemini-1\.5(?:-|$)/, '2023-11'],

  // xAI
  [/^grok-4\.5(?:-|$)/, '2026-02-01'],
  [/^grok-3(?:-|$)/, '2024-11'],

  // Model families that have been seen but where the vendor has not
  // reliably disclosed a cutoff.
  [
    /^(?:deepseek|qwen|qwq|qvq|kimi|moonshot|minimax|glm)(?:[-.]|$)/,
    null,
  ],
  [
    /^(?:mistral|codestral|magistral|llama|gemma|command|cohere)(?:[-.]|$)/,
    null,
  ],
  [
    /^(?:amazon-nova|nova|jamba|ernie|doubao|hunyuan|baichuan|yi|step)(?:[-.]|$)/,
    null,
  ],
  [/^(?:nemotron|sonar)(?:[-.]|$)/, null],
]

/**
 * Normalise model IDs returned by different platforms.
 *
 * Supports:
 * - openai/gpt-5.4
 * - anthropic/claude-sonnet-4-6
 * - deepseek-ai/DeepSeek-V4-Flash
 * - models/gemini-2.5-pro
 * - us.anthropic.claude-sonnet-4-5-20250929-v1:0
 * - openai/gpt-4o:free
 */
export function normalizeModelId(modelId: string): string {
  let normalized = modelId.trim().toLowerCase()

  // Strip URL query params.
  normalized = normalized.split('?', 1)[0]

  // OpenRouter, Vertex, Hugging Face, etc. frequently use provider/model.
  const lastSlashIndex = normalized.lastIndexOf('/')
  if (lastSlashIndex >= 0) {
    normalized = normalized.slice(lastSlashIndex + 1)
  }

  // Amazon Bedrock Claude prefix.
  normalized = normalized.replace(
    /^(?:(?:global|us|eu|apac)\.)?anthropic\./,
    '',
  )

  // Bedrock version suffix, e.g. -v1:0.
  normalized = normalized.replace(/-v\d+:\d+$/, '')

  // Common OpenRouter variant suffixes.
  normalized = normalized.replace(
    /:(?:free|online|thinking|extended)$/,
    '',
  )

  return normalized
}

/**
 * Returns null when no cutoff is found, the vendor has not disclosed one,
 * or the model is a rolling alias.
 *
 * For time-sensitive questions, null should be interpreted as:
 * "do not rely on parameter knowledge — prefer search or external data tools".
 */
export function getKnowledgeCutoff(modelId: string): KnowledgeCutoff {
  const normalized = normalizeModelId(modelId)

  if (
    Object.prototype.hasOwnProperty.call(KNOWLEDGE_CUTOFFS, normalized)
  ) {
    return KNOWLEDGE_CUTOFFS[
      normalized as keyof typeof KNOWLEDGE_CUTOFFS
    ]
  }

  for (const [pattern, cutoff] of KNOWLEDGE_CUTOFF_RULES) {
    if (pattern.test(normalized)) {
      return cutoff
    }
  }

  return null
}
