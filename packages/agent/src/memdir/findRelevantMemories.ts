/**
 * Find relevant memories for a query.
 * Adapted from claude-code-haha memdir/findRelevantMemories.ts
 */

import {
  formatMemoryManifest,
  type MemoryHeader,
  scanMemoryFiles,
} from './memoryScan.js'

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to Claude as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful, then do not include it.
- If there are no memories that would clearly be useful, return an empty list.
`

/**
 * Find memory files relevant to a query by scanning memory file headers
 * and asking the model to select the most relevant ones.
 *
 * Returns absolute file paths + mtime of the most relevant memories
 * (up to 5). Excludes MEMORY.md (already loaded in system prompt).
 *
 * NOTE: This is a simplified stub implementation. The full implementation
 * would use sideQuery with a model to select relevant memories.
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  _recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  const memories = (await scanMemoryFiles(memoryDir, signal)).filter(
    m => !alreadySurfaced.has(m.filePath),
  )

  if (memories.length === 0) {
    return []
  }

  // Simple keyword-based relevance matching as fallback
  // In production, this would use a proper model-based selection
  const queryWords = query.toLowerCase().split(/\s+/)
  const scored = memories.map(m => {
    const filename = m.filename.toLowerCase()
    const description = (m.description || '').toLowerCase()
    const type = (m.type || '').toLowerCase()

    let score = 0
    for (const word of queryWords) {
      if (word.length < 3) continue
      if (filename.includes(word)) score += 2
      if (description.includes(word)) score += 1
      if (type.includes(word)) score += 0.5
    }
    return { memory: m, score }
  })

  scored.sort((a, b) => b.score - a.score)

  return scored
    .slice(0, 5)
    .filter(s => s.score > 0)
    .map(s => ({ path: s.memory.filePath, mtimeMs: s.memory.mtimeMs }))
}
