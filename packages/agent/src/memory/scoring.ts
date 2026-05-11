/**
 * Memory Scoring - Keyword-based relevance scoring for prefetch
 *
 * Simple scoring algorithm:
 * 1. Extract keywords from query (filter common stopwords)
 * 2. Score entries by keyword overlap with summary + content
 * 3. Apply recency boost (fresher = higher score)
 * 4. Cap at maxEntries to minimize token usage
 */

import { type MemoryEntry } from './memoryParser.js'

/**
 * Days elapsed since timestamp. Floor-rounded.
 */
function memoryAgeDays(timestampMs: number): number {
  return Math.max(0, Math.floor((Date.now() - timestampMs) / 86_400_000))
}

// Common English stopwords to filter out
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'can', 'need', 'want', 'like',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'him', 'her',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'any', 'no', 'not', 'only', 'same', 'so', 'than', 'too', 'very',
  'just', 'also', 'now', 'here', 'there', 'then', 'once', 'if',
  'about', 'after', 'before', 'between', 'into', 'through', 'during',
  'above', 'below', 'up', 'down', 'out', 'off', 'over', 'under',
  // Code-related stopwords
  'function', 'class', 'method', 'file', 'code', 'use', 'using',
  'new', 'get', 'set', 'add', 'remove', 'update', 'create', 'delete',
])

export interface ScoredEntry {
  entry: MemoryEntry
  score: number
  matchKeywords: string[]
}

/**
 * Extract keywords from text.
 * Lowercase, split on whitespace/punctuation, filter stopwords and short words.
 */
function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[\s\-_.,;:!?()\[\]{}'"`]+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
  return new Set(words)
}

/**
 * Calculate keyword overlap score between query and entry.
 * Returns tuple of [score, matchedKeywords].
 */
function keywordScore(queryKeywords: Set<string>, text: string): { score: number; matched: string[] } {
  const textKeywords = extractKeywords(text)
  let score = 0
  const matched: string[] = []

  for (const keyword of queryKeywords) {
    if (textKeywords.has(keyword)) {
      score += 1
      matched.push(keyword)
    }
    // Also check for substring matches (e.g., "bug" matches "debug")
    else {
      for (const textKeyword of textKeywords) {
        if (textKeyword.includes(keyword) || keyword.includes(textKeyword)) {
          score += 0.5
          matched.push(keyword)
          break
        }
      }
    }
  }

  return { score, matched }
}

/**
 * Score memory entries by relevance to a query.
 *
 * @param entries - Memory entries to score
 * @param query - User query text
 * @param options.maxEntries - Maximum entries to return (default: 5)
 * @param options.maxAgeDays - Maximum age in days to consider (default: unlimited)
 * @returns Sorted array of scored entries, highest score first
 */
export function scoreMemoryEntries(
  entries: MemoryEntry[],
  query: string,
  options: { maxEntries?: number; maxAgeDays?: number } = {},
): ScoredEntry[] {
  const { maxEntries = 5, maxAgeDays: maxAge } = options

  // Extract keywords from query once
  const queryKeywords = extractKeywords(query)

  // If no meaningful keywords, return empty
  if (queryKeywords.size === 0) {
    return []
  }

  const now = Date.now()
  const scoredEntries: ScoredEntry[] = []

  for (const entry of entries) {
    // Check age filter
    if (maxAge !== undefined) {
      const entryAge = memoryAgeDays(new Date(entry.timestamp).getTime())
      if (entryAge > maxAge) continue
    }

    // Score based on summary match (weighted more heavily)
    const summaryResult = keywordScore(queryKeywords, entry.summary)
    // Score based on content match (lower weight)
    const contentResult = entry.content
      ? keywordScore(queryKeywords, entry.content)
      : { score: 0, matched: [] }

    // Combined score: summary is 2x weight, content is 1x
    const baseScore = summaryResult.score * 2 + contentResult.score

    if (baseScore === 0) continue

    // Apply recency boost: entries from today get 1.5x, yesterday 1.25x
    const entryAge = memoryAgeDays(new Date(entry.timestamp).getTime())
    let recencyBoost = 1.0
    if (entryAge === 0) recencyBoost = 1.5
    else if (entryAge === 1) recencyBoost = 1.25
    else if (entryAge <= 7) recencyBoost = 1.1

    // Type boost: user and feedback types get slight preference
    let typeBoost = 1.0
    if (entry.type === 'user') typeBoost = 1.2
    else if (entry.type === 'feedback') typeBoost = 1.1

    const finalScore = baseScore * recencyBoost * typeBoost

    // Combine matched keywords from both
    const allMatched = [...new Set([...summaryResult.matched, ...contentResult.matched])]

    scoredEntries.push({
      entry,
      score: finalScore,
      matchKeywords: allMatched,
    })
  }

  // Sort by score descending
  scoredEntries.sort((a, b) => b.score - a.score)

  // Cap at maxEntries
  return scoredEntries.slice(0, maxEntries)
}

/**
 * Format scored entries as a readable context string.
 */
export function formatScoredEntries(scoredEntries: ScoredEntry[]): string {
  if (scoredEntries.length === 0) return ''

  const lines: string[] = []

  for (const { entry, matchKeywords } of scoredEntries) {
    const age = memoryAgeDays(new Date(entry.timestamp).getTime())
    const ageStr = age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age}d ago`

    const header = entry.type
      ? `[${entry.type}] ${entry.summary} (${ageStr})`
      : `${entry.summary} (${ageStr})`

    lines.push(header)

    if (entry.content) {
      lines.push(entry.content)
    }
  }

  return lines.join('\n')
}
