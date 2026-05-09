/**
 * Memory-directory scanning primitives.
 * Adapted from claude-code-haha memdir/memoryScan.ts
 */

import { readdir } from 'fs/promises'
import { basename, join } from 'path'
import { type MemoryType, parseMemoryType } from './memoryTypes.js'

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30

// =============================================================================
// Frontmatter parsing - simplified implementation
// =============================================================================

interface FrontmatterResult {
  frontmatter: Record<string, string>
  content: string
}

/**
 * Simple frontmatter parser for memory files.
 * Extracts YAML frontmatter between --- markers.
 */
function parseFrontmatter(content: string, _filePath: string): FrontmatterResult {
  const frontmatter: Record<string, string> = {}
  let body = content

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (match) {
    const yamlContent = match[1]
    body = match[2]

    // Simple YAML parsing for key: value pairs
    for (const line of yamlContent.split('\n')) {
      const colonIndex = line.indexOf(':')
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).trim()
        const value = line.slice(colonIndex + 1).trim()
        if (key && value) {
          frontmatter[key] = value
        }
      }
    }
  }

  return { frontmatter, content: body }
}

// =============================================================================
// File reading - simplified implementation
// =============================================================================

interface FileReadResult {
  content: string
  mtimeMs: number
}

/**
 * Read a file with mtime, limited to first N lines.
 */
async function readFileInRange(
  filePath: string,
  _startLine: number,
  maxLines: number,
  _encoding?: BufferEncoding,
  _signal?: AbortSignal,
): Promise<FileReadResult> {
  const fs = await import('fs/promises')
  const fstat = await fs.stat(filePath)

  const content = await fs.readFile(filePath, 'utf-8')
  const lines = content.split('\n').slice(0, maxLines)

  return {
    content: lines.join('\n'),
    mtimeMs: fstat.mtimeMs,
  }
}

/**
 * Scan a memory directory for .md files, read their frontmatter, and return
 * a header list sorted newest-first (capped at MAX_MEMORY_FILES).
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const mdFiles = (entries as unknown as string[]).filter(
      f => f.endsWith('.md') && basename(f) !== 'MEMORY.md',
    )

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = join(memoryDir, relativePath)

        if (signal.aborted) {
          throw new Error('Aborted')
        }

        const { content, mtimeMs } = await readFileInRange(
          filePath,
          0,
          FRONTMATTER_MAX_LINES,
          undefined,
          signal,
        )
        const { frontmatter } = parseFrontmatter(content, filePath)
        return {
          filename: relativePath,
          filePath,
          mtimeMs,
          description: frontmatter.description || null,
          type: parseMemoryType(frontmatter.type),
        }
      }),
    )

    return headerResults
      .filter(
        (r): r is PromiseFulfilledResult<MemoryHeader> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES)
  } catch {
    return []
  }
}

/**
 * Format memory headers as a text manifest: one line per file with
 * [type] filename (timestamp): description.
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}
