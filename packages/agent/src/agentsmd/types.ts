/**
 * AGENTS.md Types
 *
 * File-based agent instruction architecture (similar to claude-code):
 * - Managed: /etc/duya/AGENTS.md - Global system instructions
 * - User: ~/.duya/AGENTS.md - User private global instructions
 * - Project: AGENTS.md, .duya/AGENTS.md, .duya/rules/*.md - Project instructions
 * - Local: AGENTS.local.md - Local private project instructions
 */

// =============================================================================
// Memory Types
// =============================================================================

export type AgentsMemoryType = 'Managed' | 'User' | 'Project' | 'Local'

// =============================================================================
// Agents File Info
// =============================================================================

export interface AgentsFileInfo {
  /** Absolute path to the file */
  path: string
  /** Type of memory */
  type: AgentsMemoryType
  /** File content */
  content: string
  /** Parent file path if included via @ directive */
  parent?: string
  /** Glob patterns for conditional rules */
  globs?: string[]
  /** Whether content differs from disk (due to transformations) */
  contentDiffersFromDisk?: boolean
  /** Raw content if transformed */
  rawContent?: string
}

// =============================================================================
// Configuration
// =============================================================================

export interface AgentsMdConfig {
  /** Whether to enable managed (system) AGENTS.md */
  enableManaged: boolean
  /** Whether to enable user AGENTS.md */
  enableUser: boolean
  /** Whether to enable project AGENTS.md */
  enableProject: boolean
  /** Whether to enable local AGENTS.md */
  enableLocal: boolean
  /** Patterns to exclude */
  excludes: string[]
  /** Maximum file size in characters */
  maxFileSize: number
  /** Maximum include depth for @ directives */
  maxIncludeDepth: number
}

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_AGENTS_MD_CONFIG: AgentsMdConfig = {
  enableManaged: true,
  enableUser: true,
  enableProject: true,
  enableLocal: true,
  excludes: [],
  maxFileSize: 40000,
  maxIncludeDepth: 5,
}

export const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'

// Text file extensions allowed for @include directives
export const TEXT_FILE_EXTENSIONS = new Set([
  // Markdown and text
  '.md',
  '.txt',
  '.text',
  // Data formats
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  // Web
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  // JavaScript/TypeScript
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  // Python
  '.py',
  '.pyi',
  '.pyw',
  // Ruby
  '.rb',
  '.erb',
  '.rake',
  // Go
  '.go',
  // Rust
  '.rs',
  // Java/Kotlin/Scala
  '.java',
  '.kt',
  '.kts',
  '.scala',
  // C/C++
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.hxx',
  // C#
  '.cs',
  // Swift
  '.swift',
  // Shell
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  // Config
  '.env',
  '.ini',
  '.cfg',
  '.conf',
  '.config',
  '.properties',
  // Database
  '.sql',
  '.graphql',
  '.gql',
  // Protocol
  '.proto',
  // Frontend frameworks
  '.vue',
  '.svelte',
  '.astro',
  // Templating
  '.ejs',
  '.hbs',
  '.pug',
  '.jade',
  // Other languages
  '.php',
  '.pl',
  '.pm',
  '.lua',
  '.r',
  '.R',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.clj',
  '.cljs',
  '.cljc',
  '.edn',
  '.hs',
  '.lhs',
  '.elm',
  '.ml',
  '.mli',
  '.f',
  '.f90',
  '.f95',
  '.for',
  // Build files
  '.cmake',
  '.make',
  '.makefile',
  '.gradle',
  '.sbt',
  // Documentation
  '.rst',
  '.adoc',
  '.asciidoc',
  '.org',
  '.tex',
  '.latex',
  // Lock files
  '.lock',
  // Misc
  '.log',
  '.diff',
  '.patch',
])
