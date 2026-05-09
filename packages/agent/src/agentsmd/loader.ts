/**
 * AGENTS.md Loader
 *
 * Loads AGENTS.md files from various locations:
 * 1. Managed: /etc/duya/AGENTS.md (system-wide)
 * 2. User: ~/.duya/AGENTS.md (user-specific)
 * 3. Project: AGENTS.md, .duya/AGENTS.md, .duya/rules/*.md (project-specific)
 * 4. Local: AGENTS.local.md (local private)
 *
 * Files are loaded in reverse order of priority (later files have higher priority).
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { promisify } from 'util'
import type {
  AgentsFileInfo,
  AgentsMemoryType,
  AgentsMdConfig,
} from './types.js'
import {
  DEFAULT_AGENTS_MD_CONFIG,
  TEXT_FILE_EXTENSIONS,
  MEMORY_INSTRUCTION_PROMPT,
} from './types.js'

const readFileAsync = promisify(fs.readFile)
const readdirAsync = promisify(fs.readdir)
const statAsync = promisify(fs.stat)
const accessAsync = promisify(fs.access)

// =============================================================================
// Path Resolution
// =============================================================================

/**
 * Get the managed (system) AGENTS.md path
 */
function getManagedPath(): string {
  if (process.platform === 'win32') {
    return 'C:\\ProgramData\\duya\\AGENTS.md'
  }
  return '/etc/duya/AGENTS.md'
}

/**
 * Get the user AGENTS.md path
 */
function getUserPath(): string {
  const homeDir = os.homedir()
  return path.join(homeDir, '.duya', 'AGENTS.md')
}

/**
 * Get the user rules directory
 */
function getUserRulesDir(): string {
  const homeDir = os.homedir()
  return path.join(homeDir, '.duya', 'rules')
}

/**
 * Expand paths with ~ and environment variables
 */
function expandPath(filePath: string, baseDir?: string): string {
  // Expand ~ to home directory
  if (filePath.startsWith('~/')) {
    filePath = path.join(os.homedir(), filePath.slice(2))
  }

  // Expand environment variables
  filePath = filePath.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '')
  filePath = filePath.replace(/\$(\w+)/g, (_, name) => process.env[name] || '')

  // Resolve relative paths
  if (baseDir && !path.isAbsolute(filePath)) {
    filePath = path.resolve(baseDir, filePath)
  }

  return filePath
}

// =============================================================================
// File Reading
// =============================================================================

/**
 * Check if a file exists and is readable
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await accessAsync(filePath, fs.constants.R_OK)
    const stats = await statAsync(filePath)
    return stats.isFile()
  } catch {
    return false
  }
}

/**
 * Check if a directory exists
 */
async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await statAsync(dirPath)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Safely read a file with error handling
 */
async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    const content = await readFileAsync(filePath, 'utf-8')
    return content
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ENOENT = file doesn't exist, EISDIR = is a directory — both expected
    if (code === 'ENOENT' || code === 'EISDIR') {
      return null
    }
    // Log permission errors
    if (code === 'EACCES') {
      console.warn(`Permission denied reading AGENTS.md: ${filePath}`)
    }
    return null
  }
}

// =============================================================================
// Frontmatter Parsing
// =============================================================================

interface FrontmatterResult {
  frontmatter: Record<string, string>
  content: string
}

/**
 * Parse YAML frontmatter from markdown content
 */
function parseFrontmatter(rawContent: string): FrontmatterResult {
  const frontmatter: Record<string, string> = {}
  let content = rawContent

  // Check for frontmatter delimiter
  if (rawContent.startsWith('---')) {
    const endIndex = rawContent.indexOf('---', 3)
    if (endIndex !== -1) {
      const frontmatterText = rawContent.slice(3, endIndex).trim()
      content = rawContent.slice(endIndex + 3).trimStart()

      // Parse simple key: value pairs
      for (const line of frontmatterText.split('\n')) {
        const colonIndex = line.indexOf(':')
        if (colonIndex !== -1) {
          const key = line.slice(0, colonIndex).trim()
          const value = line.slice(colonIndex + 1).trim()
          frontmatter[key] = value
        }
      }
    }
  }

  return { frontmatter, content }
}

/**
 * Split paths string from frontmatter into array
 */
function splitPaths(pathsStr: string): string[] {
  return pathsStr
    .split(/[,\s]+/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
}

/**
 * Parse frontmatter and extract path patterns
 */
function parseFrontmatterPaths(rawContent: string): {
  content: string
  paths?: string[]
} {
  const { frontmatter, content } = parseFrontmatter(rawContent)

  if (!frontmatter.paths) {
    return { content }
  }

  const patterns = splitPaths(frontmatter.paths)
    .map(pattern => {
      // Remove /** suffix - treat 'path' as matching both the path itself and everything inside
      return pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    })
    .filter(p => p.length > 0)

  // If all patterns are ** (match-all), treat as no globs
  if (patterns.length === 0 || patterns.every(p => p === '**')) {
    return { content }
  }

  return { content, paths: patterns }
}

// =============================================================================
// HTML Comment Stripping
// =============================================================================

/**
 * Strip HTML comments from markdown content
 * Preserves comments inside code blocks
 */
export function stripHtmlComments(content: string): {
  content: string
  stripped: boolean
} {
  if (!content.includes('<!--')) {
    return { content, stripped: false }
  }

  // Simple regex to remove HTML comments
  // This is a simplified version - for production, consider using a proper markdown parser
  const commentRegex = /<!--[\s\S]*?-->/g
  const strippedContent = content.replace(commentRegex, '')

  return {
    content: strippedContent,
    stripped: strippedContent !== content,
  }
}

// =============================================================================
// Include Directive Parsing
// =============================================================================

/**
 * Extract @include paths from markdown content
 * Syntax: @path, @./relative/path, @~/home/path, or @/absolute/path
 */
function extractIncludePaths(content: string, basePath: string): string[] {
  const paths: string[] = []
  const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g
  let match: RegExpExecArray | null

  while ((match = includeRegex.exec(content)) !== null) {
    let includePath = match[1]
    if (!includePath) continue

    // Strip fragment identifiers
    const hashIndex = includePath.indexOf('#')
    if (hashIndex !== -1) {
      includePath = includePath.substring(0, hashIndex)
    }
    if (!includePath) continue

    // Unescape spaces
    includePath = includePath.replace(/\\ /g, ' ')

    // Validate and expand path
    const isValidPath =
      includePath.startsWith('./') ||
      includePath.startsWith('~/') ||
      (includePath.startsWith('/') && includePath !== '/') ||
      (!includePath.startsWith('@') &&
        !includePath.match(/^[#%^&*()]+/) &&
        includePath.match(/^[a-zA-Z0-9._-]/))

    if (isValidPath) {
      const resolvedPath = expandPath(includePath, path.dirname(basePath))
      paths.push(resolvedPath)
    }
  }

  return [...new Set(paths)] // Remove duplicates
}

// =============================================================================
// File Processing
// =============================================================================

/**
 * Parse raw file content into AgentsFileInfo
 */
function parseAgentsFileContent(
  rawContent: string,
  filePath: string,
  type: AgentsMemoryType,
  includeBasePath?: string,
): { info: AgentsFileInfo | null; includePaths: string[] } {
  // Skip non-text files
  const ext = path.extname(filePath).toLowerCase()
  if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) {
    console.warn(`Skipping non-text file in @include: ${filePath}`)
    return { info: null, includePaths: [] }
  }

  const { content: withoutFrontmatter, paths } = parseFrontmatterPaths(rawContent)

  // Strip HTML comments
  const { content: strippedContent } = stripHtmlComments(withoutFrontmatter)

  // Extract include paths if base path provided
  const includePaths = includeBasePath
    ? extractIncludePaths(strippedContent, includeBasePath)
    : []

  const contentDiffersFromDisk = strippedContent !== rawContent

  return {
    info: {
      path: filePath,
      type,
      content: strippedContent.trim(),
      globs: paths,
      contentDiffersFromDisk,
      rawContent: contentDiffersFromDisk ? rawContent : undefined,
    },
    includePaths,
  }
}

/**
 * Process a single AGENTS.md file and its includes
 */
async function processAgentsFile(
  filePath: string,
  type: AgentsMemoryType,
  processedPaths: Set<string>,
  config: AgentsMdConfig,
  depth: number = 0,
  parent?: string,
): Promise<AgentsFileInfo[]> {
  // Check max depth
  if (depth >= config.maxIncludeDepth) {
    return []
  }

  // Normalize path for comparison
  const normalizedPath = path.normalize(filePath).toLowerCase()
  if (processedPaths.has(normalizedPath)) {
    return []
  }
  processedPaths.add(normalizedPath)

  // Read file
  const rawContent = await safeReadFile(filePath)
  if (!rawContent) {
    return []
  }

  // Parse content
  const { info, includePaths } = parseAgentsFileContent(
    rawContent,
    filePath,
    type,
    filePath,
  )

  if (!info || !info.content) {
    return []
  }

  // Add parent info
  if (parent) {
    info.parent = parent
  }

  const result: AgentsFileInfo[] = [info]

  // Process includes
  for (const includePath of includePaths) {
    const includedFiles = await processAgentsFile(
      includePath,
      type,
      processedPaths,
      config,
      depth + 1,
      filePath,
    )
    result.push(...includedFiles)
  }

  return result
}

// =============================================================================
// Rules Directory Processing
// =============================================================================

/**
 * Process .duya/rules/*.md files
 */
async function processRulesDir(
  rulesDir: string,
  type: AgentsMemoryType,
  processedPaths: Set<string>,
  config: AgentsMdConfig,
  conditionalOnly: boolean = false,
): Promise<AgentsFileInfo[]> {
  const result: AgentsFileInfo[] = []

  if (!(await dirExists(rulesDir))) {
    return result
  }

  try {
    const entries = await readdirAsync(rulesDir, { withFileTypes: true })

    for (const entry of entries) {
      const entryPath = path.join(rulesDir, entry.name)

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        const subdirFiles = await processRulesDir(
          entryPath,
          type,
          processedPaths,
          config,
          conditionalOnly,
        )
        result.push(...subdirFiles)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const files = await processAgentsFile(
          entryPath,
          type,
          processedPaths,
          config,
        )

        // Filter based on conditional flag
        for (const file of files) {
          const hasGlobs = file.globs && file.globs.length > 0
          if (conditionalOnly ? hasGlobs : !hasGlobs) {
            result.push(file)
          }
        }
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES') {
      console.warn(`Permission denied reading rules directory: ${rulesDir}`)
    }
  }

  return result
}

// =============================================================================
// Main Loader Function
// =============================================================================

export interface LoadAgentsMdOptions {
  /** Current working directory */
  cwd: string
  /** Configuration overrides */
  config?: Partial<AgentsMdConfig>
  /** Force include external files */
  forceIncludeExternal?: boolean
}

/**
 * Load all AGENTS.md files for the current session
 *
 * Files are loaded in priority order (lowest to highest):
 * 1. Managed (system) - lowest priority
 * 2. User
 * 3. Project (from root to cwd)
 * 4. Local - highest priority
 */
export async function loadAgentsMdFiles(
  options: LoadAgentsMdOptions,
): Promise<AgentsFileInfo[]> {
  const config: AgentsMdConfig = {
    ...DEFAULT_AGENTS_MD_CONFIG,
    ...options.config,
  }

  const result: AgentsFileInfo[] = []
  const processedPaths = new Set<string>()

  // 1. Load Managed (system) AGENTS.md
  if (config.enableManaged) {
    const managedPath = getManagedPath()
    const managedFiles = await processAgentsFile(
      managedPath,
      'Managed',
      processedPaths,
      config,
    )
    result.push(...managedFiles)

    // Load managed rules
    const managedRulesDir = path.join(path.dirname(managedPath), 'rules')
    const managedRules = await processRulesDir(
      managedRulesDir,
      'Managed',
      processedPaths,
      config,
    )
    result.push(...managedRules)
  }

  // 2. Load User AGENTS.md
  if (config.enableUser) {
    const userPath = getUserPath()
    const userFiles = await processAgentsFile(
      userPath,
      'User',
      processedPaths,
      config,
    )
    result.push(...userFiles)

    // Load user rules
    const userRulesDir = getUserRulesDir()
    const userRules = await processRulesDir(
      userRulesDir,
      'User',
      processedPaths,
      config,
    )
    result.push(...userRules)
  }

  // 3. Load Project AGENTS.md (from root to cwd)
  if (config.enableProject) {
    const dirs: string[] = []
    let currentDir = options.cwd

    // Collect all directories from cwd to root
    while (currentDir !== path.parse(currentDir).root) {
      dirs.push(currentDir)
      currentDir = path.dirname(currentDir)
    }

    // Process from root to cwd (lowest to highest priority)
    for (const dir of dirs.reverse()) {
      // Try AGENTS.md
      const agentsPath = path.join(dir, 'AGENTS.md')
      const agentsFiles = await processAgentsFile(
        agentsPath,
        'Project',
        processedPaths,
        config,
      )
      result.push(...agentsFiles)

      // Try .duya/AGENTS.md
      const dotDuyaPath = path.join(dir, '.duya', 'AGENTS.md')
      const dotDuyaFiles = await processAgentsFile(
        dotDuyaPath,
        'Project',
        processedPaths,
        config,
      )
      result.push(...dotDuyaFiles)

      // Try .duya/rules/*.md
      const rulesDir = path.join(dir, '.duya', 'rules')
      const rulesFiles = await processRulesDir(
        rulesDir,
        'Project',
        processedPaths,
        config,
      )
      result.push(...rulesFiles)
    }
  }

  // 4. Load Local AGENTS.local.md (highest priority)
  if (config.enableLocal) {
    const dirs: string[] = []
    let currentDir = options.cwd

    while (currentDir !== path.parse(currentDir).root) {
      dirs.push(currentDir)
      currentDir = path.dirname(currentDir)
    }

    for (const dir of dirs.reverse()) {
      const localPath = path.join(dir, 'AGENTS.local.md')
      const localFiles = await processAgentsFile(
        localPath,
        'Local',
        processedPaths,
        config,
      )
      result.push(...localFiles)
    }
  }

  return result
}

// =============================================================================
// Prompt Building
// =============================================================================

/**
 * Build the AGENTS.md prompt section from loaded files
 */
export function buildAgentsMdPrompt(files: AgentsFileInfo[]): string {
  if (files.length === 0) {
    return ''
  }

  const memories: string[] = []

  for (const file of files) {
    if (!file.content) continue

    const description =
      file.type === 'Project'
        ? ' (project instructions, checked into the codebase)'
        : file.type === 'Local'
          ? " (user's private project instructions, not checked in)"
          : file.type === 'Managed'
            ? ' (system-wide instructions)'
            : " (user's private global instructions for all projects)"

    memories.push(
      `Contents of ${file.path}${description}:\n\n${file.content}`,
    )
  }

  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if a file path is an AGENTS.md file
 */
export function isAgentsMdFile(filePath: string): boolean {
  const name = path.basename(filePath)
  if (name === 'AGENTS.md' || name === 'AGENTS.local.md') {
    return true
  }
  // Check for .duya/rules/ - handle both Unix and Windows paths
  if (name.endsWith('.md')) {
    const normalizedPath = filePath.replace(/\\/g, '/')
    return normalizedPath.includes('/.duya/rules/')
  }
  return false
}

/**
 * Get large files that exceed the size limit
 */
export function getLargeAgentsMdFiles(
  files: AgentsFileInfo[],
  maxSize: number = DEFAULT_AGENTS_MD_CONFIG.maxFileSize,
): AgentsFileInfo[] {
  return files.filter(f => f.content.length > maxSize)
}
