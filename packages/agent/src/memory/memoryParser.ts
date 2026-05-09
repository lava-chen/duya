/**
 * Memory Entry Parser
 *
 * Parses and serializes memory entries in the format:
 * ## [type] summary § YYYY-MM-DD
 * content (optional)
 *
 * Entry delimiter between entries: § (section sign)
 *
 * The [type] tag is optional (legacy entries omit it).
 * Valid types: user, feedback, project, reference
 */

export const MEMORY_TYPES = [
  'user',
  'feedback',
  'project',
  'reference',
] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined
  return MEMORY_TYPES.find(t => t === raw)
}

export interface MemoryEntry {
  summary: string
  content?: string
  timestamp: string // YYYY-MM-DD
  type?: MemoryType
}

/**
 * Parse a memory file content into entries.
 */
export function parseEntries(content: string): MemoryEntry[] {
  if (!content.trim()) {
    return []
  }

  // Split by § delimiter (not § inside entries)
  // We need to be careful: entries are separated by \n§\n
  // But content can contain §, so we split by \n§\n specifically
  const rawEntries = content.split(/\n§\n/)

  const entries: MemoryEntry[] = []
  for (const raw of rawEntries) {
    const entry = parseEntry(raw.trim())
    if (entry) {
      entries.push(entry)
    }
  }

  return entries
}

/**
 * Parse a single entry.
 * Format: ## [type] summary § YYYY-MM-DD\ncontent
 * The [type] tag is optional for backward compatibility.
 */
function parseEntry(raw: string): MemoryEntry | null {
  if (!raw) return null

  // Match the pattern: ## [optional type] summary § YYYY-MM-DD
  const headerMatch = raw.match(/^##\s+(?:\[(\w+)\]\s+)?(.+?)\s+§\s+(\d{4}-\d{2}-\d{2})/)

  if (!headerMatch) {
    // Fallback: treat entire content as summary with current date
    return {
      summary: raw.slice(0, 100),
      timestamp: new Date().toISOString().split('T')[0],
    }
  }

  const rawType = headerMatch[1]
  const summary = headerMatch[2].trim()
  const timestamp = headerMatch[3]
  const content = raw.slice(headerMatch[0].length).trim()

  return {
    summary,
    content: content || undefined,
    timestamp,
    type: parseMemoryType(rawType),
  }
}

/**
 * Serialize a single entry to string.
 */
export function serializeEntry(entry: MemoryEntry): string {
  const typePrefix = entry.type ? `[${entry.type}] ` : ''
  const header = `## ${typePrefix}${entry.summary} § ${entry.timestamp}`
  if (entry.content) {
    return `${header}\n${entry.content}`
  }
  return header
}

/**
 * Serialize multiple entries to file content.
 */
export function serializeEntries(entries: MemoryEntry[]): string {
  if (entries.length === 0) {
    return ''
  }
  return entries.map(e => serializeEntry(e)).join('\n§\n')
}

/**
 * Append a new entry to existing file content.
 */
export function appendEntry(existingContent: string, newEntry: MemoryEntry): string {
  const existing = existingContent.trim()
  const newSerialized = serializeEntry(newEntry)

  if (!existing) {
    return newSerialized
  }

  return `${existing}\n§\n${newSerialized}`
}

/**
 * Replace an entry at a given index with a new entry.
 */
export function replaceEntry(
  existingContent: string,
  index: number,
  newEntry: MemoryEntry,
): string {
  const entries = parseEntries(existingContent)

  if (index < 0 || index >= entries.length) {
    throw new Error(`Invalid entry index: ${index}`)
  }

  entries[index] = newEntry
  return serializeEntries(entries)
}

/**
 * Remove an entry at a given index.
 */
export function removeEntry(existingContent: string, index: number): string {
  const entries = parseEntries(existingContent)

  if (index < 0 || index >= entries.length) {
    throw new Error(`Invalid entry index: ${index}`)
  }

  entries.splice(index, 1)
  return serializeEntries(entries)
}

/**
 * Find entry index by text match (in summary or content).
 */
export function findEntryIndex(entries: MemoryEntry[], text: string): number {
  const lowerText = text.toLowerCase()
  return entries.findIndex(
    e =>
      e.summary.toLowerCase().includes(lowerText) ||
      (e.content && e.content.toLowerCase().includes(lowerText)),
  )
}

/**
 * Calculate total character count (with delimiter) for entries.
 */
export function calculateTotalChars(entries: MemoryEntry[]): number {
  if (entries.length === 0) return 0
  const serialized = serializeEntries(entries)
  return serialized.length
}

/**
 * Format usage string.
 */
export function formatUsage(current: number, limit: number): string {
  const pct = Math.min(100, Math.floor((current / limit) * 100))
  return `${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`
}
