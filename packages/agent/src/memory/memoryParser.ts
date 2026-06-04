/**
 * Memory Entry Parser
 *
 * Parses and serializes memory entries in the format:
 * ## [type] summary § YYYY-MM-DD <!--id:m-xxxxxxxx-->
 * content (optional)
 *
 * Entry delimiter between entries: § (section sign)
 *
 * The [type] tag is optional (legacy entries omit it).
 * Valid types: user, feedback, project, reference
 *
 * The trailing `<!--id:...-->` marker carries a stable entry id used by
 * replace/remove; legacy entries (pre-id) get a fresh id assigned on parse.
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
  /** Stable, file-persisted id (e.g. `m-abc12345`). */
  id: string
  summary: string
  content?: string
  timestamp: string // YYYY-MM-DD
  type?: MemoryType
}

/**
 * Generate a short, stable id for a memory entry.
 * Format: `m-` + 8 chars of base36 randomness. Collisions are vanishingly
 * unlikely at human-scale memory sizes (<300 entries); if they ever do
 * collide the second `add` will fall back to substring matching anyway.
 */
export function generateMemoryId(): string {
  // 4 bytes of entropy → 8 base36 chars after leading zero padding
  let n = 0
  const bytes = new Uint8Array(4)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    // Last-resort fallback for environments without crypto.getRandomValues
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  for (let i = 0; i < bytes.length; i++) {
    n = n * 256 + bytes[i]
  }
  return `m-${n.toString(36).padStart(8, '0')}`
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
 * Format: ## [type] summary § YYYY-MM-DD [<!--id:m-xxxxxxxx-->]
 *          content (optional)
 * The [type] tag, the id marker, and the content body are all optional for
 * backward compatibility.
 */
function parseEntry(raw: string): MemoryEntry | null {
  if (!raw) return null

  // Match the pattern: ## [optional type] summary § YYYY-MM-DD [optional id marker]
  const headerMatch = raw.match(
    /^##\s+(?:\[(\w+)\]\s+)?(.+?)\s+§\s+(\d{4}-\d{2}-\d{2})(?:\s*<!--\s*id:([\w-]+)\s*-->)?/,
  )

  // Extract id marker even when the header doesn't fully match (e.g. fallback)
  const idMarkerMatch = raw.match(/<!--\s*id:([\w-]+)\s*-->/)
  const rawId = headerMatch?.[4] ?? idMarkerMatch?.[1]

  if (!headerMatch) {
    // Fallback: treat entire content as summary with current date
    return {
      id: rawId ?? generateMemoryId(),
      summary: raw.slice(0, 100),
      timestamp: new Date().toISOString().split('T')[0],
    }
  }

  const rawType = headerMatch[1]
  const summary = headerMatch[2].trim()
  const timestamp = headerMatch[3]
  // Strip any id marker from the post-header body so it doesn't leak into content
  const afterHeader = raw.slice(headerMatch[0].length).replace(/<!--\s*id:[\w-]+\s*-->/g, '').trim()

  return {
    id: rawId ?? generateMemoryId(),
    summary,
    content: afterHeader || undefined,
    timestamp,
    type: parseMemoryType(rawType),
  }
}

/**
 * Serialize a single entry to string.
 */
export function serializeEntry(entry: MemoryEntry): string {
  const typePrefix = entry.type ? `[${entry.type}] ` : ''
  const idMarker = ` <!--id:${entry.id}-->`
  const header = `## ${typePrefix}${entry.summary} § ${entry.timestamp}${idMarker}`
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
 * Strip the display-only decorations that the renderer adds around an entry
 * header so the user can paste a verbatim `oldText` (the way it appears in
 * `list` output) and still have it match the underlying summary.
 *
 * Removes, applied inside-out (so each step sees a clean tail):
 *   1. trailing `*(today)*` / `*(yesterday)*` / `*(Nd ago)*` age hint
 *   2. trailing ` § YYYY-MM-DD` timestamp
 *   3. leading `## ` and optional `[type]` tag (e.g. `## [project] `)
 *   4. surrounding whitespace
 */
export function stripEntryDecorations(text: string): string {
  return text
    .replace(/\s*\*\((?:today|yesterday|\d+d\s+ago)\)\*?\s*$/i, '')
    .replace(/\s+§\s+\d{4}-\d{2}-\d{2}\s*$/, '')
    .replace(/^##\s+(?:\[[\w-]+\]\s+)?/, '')
    .trim()
}

/**
 * Find entry index by text match (in summary or content).
 *
 * Accepts text in any of these forms:
 *   1. raw substring of summary or content
 *   2. a full header line (with `## [type]` prefix and `§ YYYY-MM-DD` suffix)
 *   3. a header line plus the `*(Nd ago)*` age hint the renderer appends
 *
 * Matching is case-insensitive substring search against the normalized
 * summary / content fields. The first matching entry wins.
 */
export function findEntryIndex(entries: MemoryEntry[], text: string): number {
  const normalized = stripEntryDecorations(text).toLowerCase()
  if (!normalized) return -1

  return entries.findIndex(
    e =>
      e.summary.toLowerCase().includes(normalized) ||
      (e.content !== undefined && e.content.toLowerCase().includes(normalized)),
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
